/**
 * List Phase Runner
 *
 * Phase 1 of the exploration pipeline.
 * Scans listing pages, finds all job links, classifies them.
 * Returns collected links for Phase 2 (detail extraction).
 */

import { PlaywrightCrawler, createPlaywrightRouter, Configuration } from 'crawlee';
import { Page } from 'playwright';
import { classifyJobLinks, extractLinksWithContext } from './extractor';
import { UsageTracker } from './cost-calculator';
import { normalizeUrl } from './url-normalizer';
import { extractCanonicalName } from './canonical-name';
import { loadExistingRoles, loadDismissedDrafts, classifyRoleAction } from './existing-role-checker';
import type { RoleAction } from '@/packages/schemas/careers-scraping';
import { ExpectedProgramme } from './programme-suggester';

export interface ListPhaseInput {
    scrapeUrlId: string;
    url: string;
    firmId: string;
    firmName: string;
    scraperConfig?: any;
}

export interface CollectedLink {
    url: string;
    title: string;
    action: RoleAction;
    existingRoleId?: string;
    urlChanged?: boolean;
}

export interface ListPhaseResult {
    success: boolean;
    collectedLinks: CollectedLink[];
    allRolesInScan: Array<{ title: string; url: string }>;
    metrics: {
        pagesProcessed: number;
        rolesFound: number;
        rolesSkipped: number;
        totalTokensUsed: number;
        totalCostUsd: number;
        durationSeconds: number;
    };
    error?: string;
    logs: string[];
}

async function smartScroll(page: Page, maxScrolls = 10, log: (msg: string) => void): Promise<void> {
    let previousHeight = 0;
    let scrollCount = 0;
    let stableCount = 0;

    while (scrollCount < maxScrolls && stableCount < 2) {
        const currentHeight = await page.evaluate(() => document.body.scrollHeight);
        if (currentHeight === previousHeight) {
            stableCount++;
        } else {
            stableCount = 0;
        }
        previousHeight = currentHeight;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1500);
        scrollCount++;
    }

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
}

async function waitForPageReady(page: Page, log: (msg: string) => void): Promise<void> {
    try {
        await page.waitForLoadState('networkidle', { timeout: 20000 });
        log('Network idle achieved');
    } catch {
        log('Network idle timeout - continuing with domcontentloaded');
        try {
            await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
        } catch {
            log('DOM content loaded timeout - continuing anyway');
        }
    }
    await page.waitForTimeout(1500);
    log('Ready for scraping');
}

async function clickPaginationNext(page: Page, log: (msg: string) => void): Promise<boolean> {
    const paginationSelectors = [
        '#pagination a.arrow.next',
        '.pagination a.arrow.next',
        '#pagination a.next',
        '.pagination a.next',
        '.pager a.next',
        'a[aria-label="Next"]',
        'a[aria-label="Next page"]',
        '[rel="next"]',
        'button[aria-label="Next"]',
        'button[aria-label="Next page"]',
        '.pagination button.next',
        '#pagination button.next',
        'button:has-text("Load More")',
        'button:has-text("Show More")',
        'a:has-text("Load More")',
        'a:has-text("Show More")',
    ];

    for (const selector of paginationSelectors) {
        try {
            const element = await page.$(selector);
            if (!element) continue;

            const style = await element.getAttribute('style');
            if (style?.includes('pointer-events:none')) continue;

            const ariaDisabled = await element.getAttribute('aria-disabled');
            if (ariaDisabled === 'true') continue;

            const disabled = await element.getAttribute('disabled');
            if (disabled !== null) continue;

            const isVisible = await element.isVisible();
            if (!isVisible) continue;

            await element.click();
            await page.waitForTimeout(2500);
            log(`✓ Clicked pagination: ${selector}`);
            return true;
        } catch {
            continue;
        }
    }

    // Try numbered pagination
    try {
        const nextPageInfo = await page.evaluate(() => {
            const activeLink = document.querySelector(
                '#pagination .active, .pagination .active, #pagination [aria-current="page"], .pagination [aria-current="page"]'
            );
            if (!activeLink) return null;
            const currentNum = parseInt(activeLink.textContent || '', 10);
            if (isNaN(currentNum)) return null;
            return { currentPage: currentNum, nextPage: currentNum + 1 };
        });

        if (nextPageInfo) {
            const nextPageElement = await page.$(
                `#pagination a:has-text("${nextPageInfo.nextPage}"), .pagination a:has-text("${nextPageInfo.nextPage}")`
            );
            if (nextPageElement) {
                await nextPageElement.click();
                await page.waitForTimeout(2500);
                log(`✓ Clicked page ${nextPageInfo.nextPage}`);
                return true;
            }
        }
    } catch {
        // continue
    }

    log('No more pagination found');
    return false;
}

/**
 * Run the LIST phase - scan listing pages and collect role links
 */
export async function runListPhase(input: ListPhaseInput): Promise<ListPhaseResult> {
    const startTime = Date.now();
    const logs: string[] = [];

    const log = (msg: string) => {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] ${msg}`);
        logs.push(`[${timestamp}] ${msg}`);
    };

    const scraperConfig = input.scraperConfig || {};
    const maxPages = scraperConfig.maxPages ?? 10;
    const maxScrolls = scraperConfig.maxScrolls ?? 5;

    try {
        log(`Starting LIST phase for: ${input.url}`);

        // Load existing roles and dismissed drafts
        const existingRoles = await loadExistingRoles(input.firmId);
        const dismissedDrafts = await loadDismissedDrafts(input.firmId);

        log(`Loaded ${existingRoles.byUrl.size} existing roles, ${dismissedDrafts.byUrl.size} dismissed drafts`);

        let pagesProcessed = 0;
        let rolesFound = 0;
        let rolesSkipped = 0;
        const seenUrls = new Set<string>();
        const allRolesInScan: Array<{ title: string; url: string }> = [];
        const collectedLinks: CollectedLink[] = [];
        const classificationTracker = new UsageTracker();

        const crawleeConfig = new Configuration({ persistStorage: false });
        const router = createPlaywrightRouter();

        router.addDefaultHandler(async ({ page }) => {
            const pageUrl = page.url();
            log(`[LIST] Processing: ${pageUrl}`);

            while (pagesProcessed < maxPages) {
                pagesProcessed++;
                log(`[LIST] --- Page ${pagesProcessed} ---`);

                await waitForPageReady(page, log);
                await smartScroll(page, maxScrolls, log);

                const html = await page.content();
                const linksWithContext = extractLinksWithContext(html, pageUrl);
                log(`[LIST] Found ${linksWithContext.length} total links`);

                if (linksWithContext.length === 0) {
                    log('[LIST] ⚠️ No links found - possible rendering issue');
                    break;
                }

                // Classify links with LLM
                const classification = await classifyJobLinks(linksWithContext);
                classificationTracker.add(classification.usage);
                log(`[LIST] ✓ LLM identified ${classification.jobLinks.length} job links`);

                // Store for pattern analysis
                classification.jobLinks.forEach(link => {
                    allRolesInScan.push({ title: link.title, url: link.url });
                });

                // Classify each link action
                const classifiedLinks = classification.jobLinks.map(jobLink => {
                    const result = classifyRoleAction(
                        jobLink.url,
                        jobLink.title,
                        existingRoles.byUrl,
                        existingRoles.byName,
                        dismissedDrafts.byUrl,
                        dismissedDrafts.byName
                    );
                    rolesFound++;
                    log(`[LIST]   - "${jobLink.title.substring(0, 50)}..." → ${result.action}`);
                    return {
                        url: jobLink.url,
                        title: jobLink.title,
                        action: result.action,
                        existingRoleId: result.existingRoleId,
                        urlChanged: result.urlChanged,
                    };
                });

                // Collect non-skip links
                const toCollect = classifiedLinks.filter(l => l.action !== 'SKIP');
                rolesSkipped += classifiedLinks.filter(l => l.action === 'SKIP').length;

                for (const link of toCollect) {
                    const normalized = normalizeUrl(link.url);
                    if (seenUrls.has(normalized)) continue;
                    seenUrls.add(normalized);
                    collectedLinks.push(link);
                }

                log(`[LIST] Collected ${toCollect.length} new roles (${collectedLinks.length} total)`);

                const hasMorePages = await clickPaginationNext(page, log);
                if (!hasMorePages) break;
            }
        });

        const crawler = new PlaywrightCrawler(
            {
                requestHandler: router,
                headless: true,
                maxConcurrency: 1,
                navigationTimeoutSecs: 60,
                requestHandlerTimeoutSecs: 300,
                browserPoolOptions: { useFingerprints: true },
                launchContext: {
                    launchOptions: {
                        args: ['--disable-blink-features=AutomationControlled'],
                    },
                },
            },
            crawleeConfig
        );

        await crawler.run([{ url: input.url, label: 'LIST' }]);

        const cost = classificationTracker.getCost('gpt-4o-mini');
        const durationSeconds = (Date.now() - startTime) / 1000;

        log(`✅ LIST phase complete: ${collectedLinks.length} roles to extract in ${durationSeconds.toFixed(2)}s`);
        log(`Cost: $${cost.totalCost.toFixed(4)} (${cost.totalTokens.toLocaleString()} tokens)`);

        return {
            success: true,
            collectedLinks,
            allRolesInScan,
            metrics: {
                pagesProcessed,
                rolesFound,
                rolesSkipped,
                totalTokensUsed: cost.totalTokens,
                totalCostUsd: cost.totalCost,
                durationSeconds,
            },
            logs,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(`✗ LIST phase failed: ${errorMessage}`);
        return {
            success: false,
            collectedLinks: [],
            allRolesInScan: [],
            metrics: {
                pagesProcessed: 0,
                rolesFound: 0,
                rolesSkipped: 0,
                totalTokensUsed: 0,
                totalCostUsd: 0,
                durationSeconds: (Date.now() - startTime) / 1000,
            },
            error: errorMessage,
            logs,
        };
    }
}