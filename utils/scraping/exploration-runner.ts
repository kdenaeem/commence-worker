/**
 * Production Exploration Runner
 *
 * This is the core scraping engine for Flow A - Exploration.
 * It discovers new programmes and roles from career pages.
 *
 * Key features:
 * - Skip-DETAIL optimization (check existing roles before extracting)
 * - Saves discoveries to DB (programme_discovery_drafts, role_discovery_drafts)
 * - Returns metrics for scrape_urls update
 * - Based on scraping-playground.ts but production-ready
 */

import { PlaywrightCrawler, createPlaywrightRouter, Configuration } from 'crawlee';
import { Page } from 'playwright';
import {
    extractRoleFromHtml,
    classifyJobLinks,
    extractLinksWithContext,
} from './extractor';
import { suggestProgramme, ExpectedProgramme, normalizeProgrammeName } from './programme-suggester';
import { UsageTracker } from './cost-calculator';
import { normalizeUrl } from './url-normalizer';
import { extractCanonicalName } from './canonical-name';
import { loadExistingRoles, loadDismissedDrafts, classifyRoleAction } from './existing-role-checker';
import { saveDiscovery, updateScrapeUrlMetrics } from './save-discoveries';
import type { ScrapedRole, RoleAction } from '@/packages/schemas/careers-scraping';
import { createClient } from '@supabase/supabase-js';

export interface ExplorationJobInput {
    scrapeUrlId: string;
    url: string;
    firmId: string;
    firmName: string;
    firmSlug: string;
    expectedProgrammes: ExpectedProgramme[];
    existingProgrammes: Array<{
        id: string;
        name: string;
        normalized_name: string | null;
        program_type: string;
    }>;
    scraperConfig?: any;
}

export interface ExplorationJobResult {
    success: boolean;
    metrics: {
        roles_found: number;
        roles_skipped: number;
        roles_new: number;
        roles_url_changed: number;
        roles_reopened: number;
        total_tokens_used: number;
        total_cost_usd: number;
        duration_seconds: number;
    };
    error?: string;
    logs: string[];
}

/**
 * Smart scroll that continues until no new content loads.
 */
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

    // Scroll back to top
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
}

/**
 * Waits for the page to be ready for scraping.
 */
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

/**
 * Tries to click the "next" pagination button.
 * Works for all pagination types: state-based, URL-based, Load More buttons.
 * Returns true if clicked successfully, false if no more pages.
 */
async function clickPaginationNext(page: Page, log: (msg: string) => void): Promise<boolean> {
    // Pagination selectors - prioritize specific context to avoid false positives
    const paginationSelectors = [
        // Arrow-based "next" within pagination context (most common)
        '#pagination a.arrow.next',
        '.pagination a.arrow.next',
        '#pagination a.next',
        '.pagination a.next',
        '.pager a.next',

        // Standard aria labels for next page
        'a[aria-label="Next"]',
        'a[aria-label="Next page"]',
        'a[aria-label*="Next" i][aria-label*="result" i]', // "Next 10 results"
        '[rel="next"]',

        // Buttons
        'button[aria-label="Next"]',
        'button[aria-label="Next page"]',
        '.pagination button.next',
        '#pagination button.next',

        // "Load More" buttons
        'button:has-text("Load More")',
        'button:has-text("Show More")',
        'a:has-text("Load More")',
        'a:has-text("Show More")',
    ];

    // Try each selector
    for (const selector of paginationSelectors) {
        try {
            const element = await page.$(selector);
            if (!element) continue;

            // Check if disabled (skip if disabled)
            const style = await element.getAttribute('style');
            if (style?.includes('pointer-events:none') || style?.includes('pointer-events: none')) {
                log(`Skipping ${selector} - pointer-events:none`);
                continue;
            }

            const ariaDisabled = await element.getAttribute('aria-disabled');
            if (ariaDisabled === 'true') {
                log(`Skipping ${selector} - aria-disabled=true`);
                continue;
            }

            const disabled = await element.getAttribute('disabled');
            if (disabled !== null) {
                log(`Skipping ${selector} - disabled attribute present`);
                continue;
            }

            // Check if visible
            const isVisible = await element.isVisible();
            if (!isVisible) {
                log(`Skipping ${selector} - not visible`);
                continue;
            }

            // Found a clickable pagination element!
            log(`Found pagination: ${selector}`);
            try {
                await element.click();
                await page.waitForTimeout(2500); // Wait for new content to load
                log(`✓ Clicked pagination successfully`);
                return true;
            } catch (error) {
                log(`Failed to click: ${error instanceof Error ? error.message : String(error)}`);
            }
        } catch (error) {
            // Continue to next selector
            log(`Error checking ${selector}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // Try numbered pagination (clicking specific page numbers like "2", "3", etc.)
    try {
        const nextPageInfo = await page.evaluate(() => {
            // Find the currently active page number
            const activeLink = document.querySelector(
                '#pagination .active, .pagination .active, #pagination [aria-current="page"], .pagination [aria-current="page"]'
            );
            if (!activeLink) return null;

            const currentNum = parseInt(activeLink.textContent || '', 10);
            if (isNaN(currentNum)) return null;

            return { currentPage: currentNum, nextPage: currentNum + 1 };
        });

        if (nextPageInfo) {
            const { nextPage } = nextPageInfo;
            log(`Current page: ${nextPageInfo.currentPage}, looking for page ${nextPage}...`);

            // Try to find and click the next page number
            const nextPageElement = await page.$(
                `#pagination a:has-text("${nextPage}"), .pagination a:has-text("${nextPage}")`
            );

            if (nextPageElement) {
                log(`Found numbered pagination: page ${nextPage}`);
                try {
                    await nextPageElement.click();
                    await page.waitForTimeout(2500);
                    log(`✓ Clicked page ${nextPage} successfully`);
                    return true;
                } catch (error) {
                    log(`Failed to click page ${nextPage}: ${error instanceof Error ? error.message : String(error)}`);
                }
            } else {
                log(`Page ${nextPage} not found - likely at last page`);
            }
        }
    } catch (error) {
        log(`Error checking numbered pagination: ${error instanceof Error ? error.message : String(error)}`);
    }

    log('No more pagination found');
    return false;
}

/**
 * Run exploration job for a single URL
 *
 * This is the main entry point for the exploration pipeline.
 */
export async function runExplorationJob(input: ExplorationJobInput): Promise<ExplorationJobResult> {
    const startTime = Date.now();
    const logs: string[] = [];

    const logMessage = (msg: string) => {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] ${msg}`);
        logs.push(`[${timestamp}] ${msg}`);
    };

    // Extract scraper configuration with defaults
    const scraperConfig = input.scraperConfig || {};
    const maxPages = scraperConfig.maxPages ?? 10;
    const maxRoles = scraperConfig.maxRoles ?? null; // null means unlimited
    const maxScrolls = scraperConfig.maxScrolls ?? 5;
    const extractionModel = scraperConfig.extractionModel ?? 'gpt-5-mini';

    try {
        logMessage(`Starting exploration for: ${input.url}`);
        logMessage(`Firm: ${input.firmName} (${input.firmId})`);
        logMessage(`Expected programmes: ${input.expectedProgrammes.length}`);
        logMessage(`Existing programmes: ${input.existingProgrammes.length}`);
        logMessage(`Scraper config: maxPages=${maxPages}, maxRoles=${maxRoles ?? 'unlimited'}, maxScrolls=${maxScrolls}, extractionModel=${extractionModel}`);

        // Load existing roles for skip-DETAIL optimization
        logMessage('Loading existing roles from DB...');
        const existingRoles = await loadExistingRoles(input.firmId);
        logMessage(`Loaded ${existingRoles.byUrl.size} roles by URL, ${existingRoles.byName.size} by canonical name`);

        // Load dismissed drafts to avoid re-scraping
        logMessage('Loading dismissed drafts from DB...');
        const dismissedDrafts = await loadDismissedDrafts(input.firmId);
        logMessage(`Loaded ${dismissedDrafts.byUrl.size} dismissed drafts by URL, ${dismissedDrafts.byName.size} by canonical name`);

        // Track state
        let pagesProcessed = 0;
        const seenUrls = new Set<string>();
        const allRolesInScan: Array<{ title: string; url: string }> = [];

        // Two-phase processing: collect all classified links in Phase 1 (LIST)
        const collectedLinks: Array<{
            url: string;
            title: string;
            action: RoleAction;
            existingRoleId?: string;
            urlChanged?: boolean;
        }> = [];

        // Track metrics
        let rolesFound = 0;
        let rolesSkipped = 0;
        let rolesNew = 0;
        let rolesUrlChanged = 0;
        let rolesReopened = 0;

        // Track LLM usage
        const extractionTracker = new UsageTracker();
        const classificationTracker = new UsageTracker();
        const suggestionTracker = new UsageTracker();

        // Disable Crawlee's default storage
        const crawleeConfig = new Configuration({
            persistStorage: false,
        });

        const router = createPlaywrightRouter();

        // LIST handler - processes listing pages to find job links
        // Handles all pagination types by looping internally
        router.addDefaultHandler(async ({ page }) => {
            const pageUrl = page.url();
            logMessage(`[LIST] ========== Starting LIST handler for: ${pageUrl} ==========`);

            // Loop through all pagination pages (clicks next, works for state-based & URL-based)
            while (pagesProcessed < maxPages) {
                pagesProcessed++;
                logMessage(`[LIST] --- Processing page ${pagesProcessed} ---`);

                // Wait for page to be ready
                logMessage(`[LIST] Waiting for page to be ready...`);
                await waitForPageReady(page, logMessage);
                logMessage(`[LIST] Performing smart scroll to load dynamic content (maxScrolls=${maxScrolls})...`);
                await smartScroll(page, maxScrolls, logMessage);

                // Extract links with context
                logMessage(`[LIST] Extracting links from HTML...`);
                const html = await page.content();
                const linksWithContext = extractLinksWithContext(html, pageUrl);
                logMessage(`[LIST] Found ${linksWithContext.length} total links on page`);

                if (linksWithContext.length === 0) {
                    logMessage('[LIST] ⚠️  WARNING: No links found on page - this might indicate a rendering issue');
                    return;
                }

                // Use LLM to classify which links are job postings
                logMessage('[LIST] 🤖 Calling LLM to classify which links are job postings...');
                logMessage(`[LIST] Sending ${linksWithContext.length} links to classifier...`);
                const classification = await classifyJobLinks(linksWithContext);
                classificationTracker.add(classification.usage);
                logMessage(`[LIST] ✓ LLM identified ${classification.jobLinks.length} job links (${linksWithContext.length - classification.jobLinks.length} non-job links filtered out)`);
                logMessage(`[LIST] Classification used ${classification.usage.totalTokens} tokens`);
                if (classification.jobLinks.length > 0) {
                    logMessage(`[LIST] Sample job links: ${classification.jobLinks.slice(0, 3).map(l => `"${l.title}"`).join(', ')}...`);
                }

                // Store ALL job links for pattern analysis
                logMessage(`[LIST] 📊 Storing all ${classification.jobLinks.length} job links for pattern analysis...`);
                classification.jobLinks.forEach((jobLink) => {
                    allRolesInScan.push({ title: jobLink.title, url: jobLink.url });
                });
                logMessage(`[LIST] Total roles accumulated across all pages: ${allRolesInScan.length}`);

                // Classify each link: SKIP, NEW_ROLE, URL_CHANGED, or REOPENING
                logMessage(`[LIST] 🔍 Classifying each link against existing roles and dismissed drafts...`);
                const classifiedLinks = classification.jobLinks.map((jobLink) => {
                    const classification = classifyRoleAction(
                        jobLink.url,
                        jobLink.title,
                        existingRoles.byUrl,
                        existingRoles.byName,
                        dismissedDrafts.byUrl,
                        dismissedDrafts.byName
                    );

                    rolesFound++;

                    // Determine if this was skipped due to dismissal
                    const dismissedByUrl = dismissedDrafts.byUrl.has(normalizeUrl(jobLink.url));
                    const dismissedByName = dismissedDrafts.byName.has(extractCanonicalName(jobLink.title));
                    const isDismissed = dismissedByUrl || dismissedByName;

                    const logSuffix = classification.existingRoleId
                        ? ` (existing: ${classification.existingRoleId})`
                        : isDismissed
                            ? ` (dismissed draft)`
                            : '';

                    logMessage(`[LIST]   - "${jobLink.title.substring(0, 50)}..." → ${classification.action}${logSuffix}`);

                    return {
                        url: jobLink.url,
                        title: jobLink.title,
                        action: classification.action,
                        existingRoleId: classification.existingRoleId,
                        urlChanged: classification.urlChanged,
                    };
                });

                // Count actions
                const toSkip = classifiedLinks.filter((l) => l.action === 'SKIP');
                const newRoles = classifiedLinks.filter((l) => l.action === 'NEW_ROLE');
                const urlChanges = classifiedLinks.filter((l) => l.action === 'URL_CHANGED');
                const reopenings = classifiedLinks.filter((l) => l.action === 'REOPENING');

                // Count for summary
                rolesFound += classifiedLinks.length;
                rolesSkipped += toSkip.length;

                logMessage(`[LIST] ========== Classification Summary ==========`);
                logMessage(`[LIST]   ✓ SKIP (unchanged): ${toSkip.length}`);
                logMessage(`[LIST]   ✨ NEW_ROLE: ${newRoles.length}`);
                logMessage(`[LIST]   🔄 URL_CHANGED: ${urlChanges.length}`);
                logMessage(`[LIST]   🔓 REOPENING: ${reopenings.length}`);
                logMessage(`[LIST] ============================================`);

                // Collect links for Phase 2 (DETAIL extraction)
                // Only collect NEW, URL_CHANGED, and REOPENING
                const toCollect = [...newRoles, ...urlChanges, ...reopenings];

                for (const link of toCollect) {
                    const normalizedUrl = normalizeUrl(link.url);
                    if (seenUrls.has(normalizedUrl)) {
                        logMessage(`[LIST] Skipping duplicate: ${link.url}`);
                        continue;
                    }

                    seenUrls.add(normalizedUrl);
                    collectedLinks.push(link);
                }

                logMessage(`[LIST] 📦 Collected ${toCollect.length} roles for Phase 2 extraction`);
                logMessage(`[LIST] Total collected so far: ${collectedLinks.length} roles`);

                // Try clicking pagination to load next page
                logMessage(`[LIST] Checking for pagination...`);
                const hasMorePages = await clickPaginationNext(page, logMessage);

                if (!hasMorePages) {
                    logMessage('[LIST] No more pagination found - exiting loop');
                    break;
                }

                logMessage(`[LIST] Pagination clicked successfully - will process next page`);
                // Loop continues to process the next page's content
            }

            // All pages processed - trigger Phase 2
            logMessage('[LIST] All pagination exhausted - triggering Phase 2');
            await checkAndStartDetailPhase();
        });

        // DETAIL handler - extracts structured data and saves to DB
        router.addHandler('DETAIL', async ({ page, request }) => {
            const detailUrl = request.url;
            const {
                expectedTitle,
                updateType,
                existingRoleId,
                firmId,
                scrapeUrlId,
                firmName,
                expectedProgrammes,
                existingProgrammes,
                allRolesInScan,
            } = request.userData;

            logMessage(`[DETAIL] ========== Processing Detail Page ==========`);
            logMessage(`[DETAIL] URL: ${detailUrl}`);
            logMessage(`[DETAIL] Expected title: "${expectedTitle}"`);
            logMessage(`[DETAIL] Action: ${updateType}${existingRoleId ? ` (updating role ${existingRoleId})` : ''}`);
            logMessage(`[DETAIL] Context received:`);
            logMessage(`[DETAIL]   - firmName: ${firmName}`);
            logMessage(`[DETAIL]   - expectedProgrammes: ${expectedProgrammes?.length || 0}`);
            logMessage(`[DETAIL]   - existingProgrammes: ${existingProgrammes?.length || 0}`);
            logMessage(`[DETAIL]   - allRolesInScan: ${allRolesInScan?.length || 0}`);

            // Wait for detail page content
            try {
                await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
                await page.waitForLoadState('networkidle', { timeout: 10000 });
            } catch {
                logMessage('[DETAIL] Page load timeout - continuing with available content');
            }

            await page.waitForTimeout(2000);

            const html = await page.content();
            const htmlLength = html.length;
            logMessage(`[DETAIL] Page content loaded (${htmlLength} characters)`);

            // Extract structured data using LLM
            logMessage(`[DETAIL] 🤖 Calling LLM for structured role extraction (model: ${extractionModel})...`);

            try {
                const extraction = await extractRoleFromHtml(html, detailUrl, extractionModel);
                extractionTracker.add(extraction.usage);

                logMessage(`[DETAIL] ✓ Extraction successful!`);
                logMessage(`[DETAIL]   Title: "${extraction.role.title}"`);
                logMessage(`[DETAIL]   Location: ${extraction.role.location || 'N/A'}`);
                logMessage(`[DETAIL]   Program type: ${extraction.role.program_type || 'N/A'}`);
                logMessage(`[DETAIL]   Role type: ${extraction.role.role_type || 'N/A'}`);
                logMessage(`[DETAIL]   Deadline: ${extraction.role.deadline || 'N/A'}`);
                logMessage(`[DETAIL]   Tokens used: ${extraction.usage.totalTokens}`);

                // Programme suggestion
                logMessage('[DETAIL] 🎯 Calling programme suggestion engine...');
                logMessage(`[DETAIL] Suggestion context:`);
                logMessage(`[DETAIL]   - Role title: "${extraction.role.title}"`);
                logMessage(`[DETAIL]   - All roles in scan: ${allRolesInScan.length} roles`);
                logMessage(`[DETAIL]   - Expected programmes: ${expectedProgrammes.length}`);
                logMessage(`[DETAIL]   - Existing programmes: ${existingProgrammes.length}`);

                const suggestion = await suggestProgramme({
                    scrapedRole: extraction.role,
                    allRolesInScan: allRolesInScan,
                    expectedProgrammes: expectedProgrammes,
                    existingProgrammes: existingProgrammes,
                    firmName: firmName,
                });

                suggestionTracker.add(suggestion.usage);

                logMessage(`[DETAIL] ========== Programme Suggestion Result ==========`);
                if (suggestion.is_new) {
                    logMessage(`[DETAIL] ✨ NEW PROGRAMME SUGGESTED`);
                    logMessage(`[DETAIL]   Suggested name: "${suggestion.suggested_name}"`);
                    logMessage(`[DETAIL]   Normalized name: "${suggestion.normalized_name}"`);
                    logMessage(`[DETAIL]   Program type: ${suggestion.program_type}`);
                } else {
                    logMessage(`[DETAIL] ✓ MATCHED TO EXISTING PROGRAMME`);
                    logMessage(`[DETAIL]   Matched: "${suggestion.matched_program_name}"`);
                    logMessage(`[DETAIL]   Programme ID: ${suggestion.matched_program_id}`);
                }
                logMessage(`[DETAIL]   Confidence: ${suggestion.confidence.toUpperCase()}`);
                logMessage(`[DETAIL]   Reasoning: ${suggestion.reasoning}`);
                logMessage(`[DETAIL]   Tokens used: ${suggestion.usage.totalTokens}`);
                logMessage(`[DETAIL] ===============================================`);

                // Deduplication: Check if this programme name already exists in this scrape
                if (suggestion.is_new && suggestion.suggested_name) {
                    logMessage('[DETAIL] 🔍 Checking for duplicate programme names in this scrape...');

                    try {
                        const supabase = createClient(
                            process.env.NEXT_PUBLIC_SUPABASE_URL!,
                            process.env.SUPABASE_SERVICE_ROLE_KEY!
                        );

                        // Query existing programme drafts from this scrape
                        const { data: existingDrafts, error: queryError } = await supabase
                            .from('programme_discovery_drafts')
                            .select('suggested_name, normalized_name, program_type')
                            .eq('scrape_url_id', scrapeUrlId)
                            .eq('status', 'pending');

                        if (queryError) {
                            logMessage(`[DETAIL] ⚠️  Warning: Failed to query existing drafts: ${queryError.message}`);
                        } else if (existingDrafts && existingDrafts.length > 0) {
                            logMessage(`[DETAIL] Found ${existingDrafts.length} existing programme drafts in this scrape`);

                            // Normalize the current suggestion
                            const normalizedSuggestion = normalizeProgrammeName(suggestion.suggested_name);
                            logMessage(`[DETAIL] Current suggestion normalized: "${normalizedSuggestion}"`);

                            // Check for match
                            const match = existingDrafts.find((draft) => {
                                const normalizedDraft = normalizeProgrammeName(draft.suggested_name);
                                return normalizedDraft === normalizedSuggestion && draft.program_type === suggestion.program_type;
                            });

                            if (match) {
                                logMessage(`[DETAIL] ✅ DUPLICATE FOUND! Reusing first occurrence:`);
                                logMessage(`[DETAIL]   Original: "${suggestion.suggested_name}"`);
                                logMessage(`[DETAIL]   Reusing: "${match.suggested_name}"`);

                                // Reuse the first occurrence
                                suggestion.suggested_name = match.suggested_name;
                                suggestion.normalized_name = match.normalized_name;
                            } else {
                                logMessage(`[DETAIL] ✓ No duplicate found - this is a unique programme name`);
                            }
                        } else {
                            logMessage(`[DETAIL] ✓ No existing programme drafts yet in this scrape`);
                        }
                    } catch (error) {
                        logMessage(`[DETAIL] ⚠️  Warning: Deduplication failed: ${error instanceof Error ? error.message : String(error)}`);
                        // Continue with original suggestion if deduplication fails
                    }
                }

                // Save to discovery drafts
                logMessage('[DETAIL] 💾 Saving discovery to database...');
                logMessage(`[DETAIL] Update type: ${updateType}`);
                logMessage(`[DETAIL] Existing role ID: ${existingRoleId || 'N/A (new role)'}`);

                const saved = await saveDiscovery({
                    firmId: firmId,
                    sourceUrlId: scrapeUrlId,
                    scrapedRole: extraction.role,
                    programmeSuggestion: suggestion,
                    url: detailUrl,
                    updateType: updateType,
                    existingRoleId: existingRoleId,
                });

                if (saved) {
                    logMessage(`[DETAIL] ✓ Successfully saved to DB!`);
                    logMessage(`[DETAIL]   Programme draft ID: ${saved.programmeDraftId || 'N/A (matched existing)'}`);
                    logMessage(`[DETAIL]   Role draft ID: ${saved.roleDraftId || 'N/A'}`);
                } else {
                    logMessage('[DETAIL] ⚠️  WARNING: Failed to save to DB - discovery may be lost');
                }
                logMessage(`[DETAIL] ========== Detail Processing Complete ==========`);
            } catch (error) {
                logMessage(`[DETAIL] ❌ ERROR: Extraction/saving failed`);
                logMessage(`[DETAIL] Error: ${error instanceof Error ? error.message : String(error)}`);
                logMessage(`[DETAIL] Stack: ${error instanceof Error ? error.stack : 'N/A'}`);
            }
        });

        // Create and run the crawler
        const crawler = new PlaywrightCrawler(
            {
                requestHandler: router,
                headless: true,
                maxRequestsPerCrawl: 100, // Safety limit
                maxConcurrency: 2,
                navigationTimeoutSecs: 60,
                requestHandlerTimeoutSecs: 120,
                browserPoolOptions: {
                    useFingerprints: true,
                },
                launchContext: {
                    launchOptions: {
                        args: ['--disable-blink-features=AutomationControlled'],
                    },
                },
            },
            crawleeConfig
        );

        // Use a flag to coordinate two-phase processing
        let listPhaseComplete = false;

        // Check if LIST phase is complete and trigger DETAIL phase
        const checkAndStartDetailPhase = async () => {
            if (listPhaseComplete) return; // Already triggered
            listPhaseComplete = true;

            logMessage('='.repeat(50));
            logMessage(`PHASE 1 COMPLETE: Found ${collectedLinks.length} roles to extract`);
            logMessage('='.repeat(50));

            if (collectedLinks.length > 0) {
                logMessage('='.repeat(50));
                logMessage('PHASE 2: Extracting role details...');
                logMessage('='.repeat(50));

                // Apply maxRoles limit across all collected links
                let linksToExtract = collectedLinks;
                if (maxRoles !== null && collectedLinks.length > maxRoles) {
                    logMessage(`⚠️  Limiting extraction to ${maxRoles} roles (found ${collectedLinks.length})`);
                    linksToExtract = collectedLinks.slice(0, maxRoles);
                }

                // Update final metrics
                const extractingNew = linksToExtract.filter(l => l.action === 'NEW_ROLE').length;
                const extractingUrlChanged = linksToExtract.filter(l => l.action === 'URL_CHANGED').length;
                const extractingReopened = linksToExtract.filter(l => l.action === 'REOPENING').length;
                const skippedDueToLimit = collectedLinks.length - linksToExtract.length;

                rolesNew = extractingNew;
                rolesUrlChanged = extractingUrlChanged;
                rolesReopened = extractingReopened;
                rolesSkipped += skippedDueToLimit;

                logMessage(`📊 Extraction plan:`);
                logMessage(`   - NEW_ROLE: ${extractingNew}`);
                logMessage(`   - URL_CHANGED: ${extractingUrlChanged}`);
                logMessage(`   - REOPENING: ${extractingReopened}`);
                if (skippedDueToLimit > 0) {
                    logMessage(`   - Skipped (maxRoles limit): ${skippedDueToLimit}`);
                }
                logMessage(`   - Total to extract: ${linksToExtract.length}`);

                // Enqueue DETAIL handlers
                logMessage(`📝 Enqueueing ${linksToExtract.length} DETAIL extraction jobs...`);
                await crawler.addRequests(
                    linksToExtract.map((job) => ({
                        url: job.url,
                        label: 'DETAIL',
                        userData: {
                            expectedTitle: job.title,
                            updateType: job.action,
                            existingRoleId: job.existingRoleId,
                            urlChanged: job.urlChanged,
                            firmId: input.firmId,
                            scrapeUrlId: input.scrapeUrlId,
                            firmName: input.firmName,
                            expectedProgrammes: input.expectedProgrammes,
                            existingProgrammes: input.existingProgrammes,
                            allRolesInScan: allRolesInScan,
                        },
                    }))
                );

                logMessage(`🚀 DETAIL extraction jobs enqueued - crawler will process them automatically`);
            } else {
                logMessage('ℹ️  No new or changed roles found - skipping Phase 2');
            }
        };

        // ========== Run the crawler (single run, two phases coordinated internally) ==========
        logMessage('='.repeat(50));
        logMessage('PHASE 1: Scanning all listing pages...');
        logMessage('='.repeat(50));
        await crawler.run([{ url: input.url, label: 'LIST' }]);

        // Calculate total cost
        const extractionCost = extractionTracker.getCost('gpt-5-mini');
        const classificationCost = classificationTracker.getCost('gpt-4o-mini');
        const suggestionCost = suggestionTracker.getCost('gpt-5-mini');
        const totalCost = extractionCost.totalCost + classificationCost.totalCost + suggestionCost.totalCost;
        const totalTokens = extractionCost.totalTokens + classificationCost.totalTokens + suggestionCost.totalTokens;

        const durationSeconds = (Date.now() - startTime) / 1000;

        logMessage('='.repeat(50));
        logMessage(`Exploration completed in ${durationSeconds.toFixed(2)}s`);
        logMessage(`Pages processed: ${pagesProcessed}`);
        logMessage(`Roles found: ${rolesFound}`);
        logMessage(`  - Skipped (unchanged): ${rolesSkipped}`);
        logMessage(`  - New: ${rolesNew}`);
        logMessage(`  - URL changed: ${rolesUrlChanged}`);
        logMessage(`  - Reopened: ${rolesReopened}`);
        logMessage(`Total tokens: ${totalTokens.toLocaleString()}`);
        logMessage(`Total cost: $${totalCost.toFixed(4)}`);

        const metrics = {
            roles_found: rolesFound,
            roles_skipped: rolesSkipped,
            roles_new: rolesNew,
            roles_url_changed: rolesUrlChanged,
            roles_reopened: rolesReopened,
            total_tokens_used: totalTokens,
            total_cost_usd: totalCost,
            duration_seconds: durationSeconds,
        };

        // Update scrape_urls metrics (skip for manual test runs)
        if (input.scrapeUrlId !== 'manual-test') {
            await updateScrapeUrlMetrics({
                scrapeUrlId: input.scrapeUrlId,
                metrics,
            });
        }

        return {
            success: true,
            metrics,
            logs,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logMessage(`✗ Exploration failed: ${errorMessage}`);

        // Update scrape_urls with error (skip for manual test runs)
        if (input.scrapeUrlId !== 'manual-test') {
            await updateScrapeUrlMetrics({
                scrapeUrlId: input.scrapeUrlId,
                metrics: {
                    roles_found: 0,
                    roles_skipped: 0,
                    roles_new: 0,
                    roles_url_changed: 0,
                    roles_reopened: 0,
                    total_tokens_used: 0,
                    total_cost_usd: 0,
                    duration_seconds: (Date.now() - startTime) / 1000,
                },
                error: errorMessage,
            });
        }

        return {
            success: false,
            metrics: {
                roles_found: 0,
                roles_skipped: 0,
                roles_new: 0,
                roles_url_changed: 0,
                roles_reopened: 0,
                total_tokens_used: 0,
                total_cost_usd: 0,
                duration_seconds: (Date.now() - startTime) / 1000,
            },
            error: errorMessage,
            logs,
        };
    }
}
