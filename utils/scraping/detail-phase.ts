/**
 * Detail Phase Runner
 *
 * Phase 2 of the exploration pipeline.
 * Processes a single role detail page - extracts structured data,
 * suggests programme, and saves to DB.
 *
 * Designed to run in parallel via Trigger.dev batchTrigger.
 */

import { PlaywrightCrawler, createPlaywrightRouter, Configuration } from 'crawlee';
import { extractRoleFromHtml } from './extractor';
import { suggestProgramme, normalizeProgrammeName } from './programme-suggester';
import { UsageTracker } from './cost-calculator';
import { saveDiscovery } from './save-discoveries';
import { createClient } from '@supabase/supabase-js';
import type { RoleAction } from '@/packages/schemas/careers-scraping';
import { ExpectedProgramme } from './programme-suggester';

export interface DetailPhaseInput {
    url: string;
    title: string;
    action: RoleAction;
    existingRoleId?: string;
    firmId: string;
    firmName: string;
    firmSlug: string;
    scrapeUrlId: string;
    expectedProgrammes: ExpectedProgramme[];
    existingProgrammes: Array<{
        id: string;
        name: string;
        normalized_name: string | null;
        program_type: string;
    }>;
    allRolesInScan: Array<{ title: string; url: string }>;
    scraperConfig?: any;
}

export interface DetailPhaseResult {
    success: boolean;
    url: string;
    title?: string;
    programmeDraftId?: string;
    roleDraftId?: string;
    metrics: {
        totalTokensUsed: number;
        totalCostUsd: number;
        durationSeconds: number;
    };
    error?: string;
    logs: string[];
}

/**
 * Run the DETAIL phase for a single role URL
 * Extracts structured data, suggests programme, saves to DB
 */
export async function runDetailPhase(input: DetailPhaseInput): Promise<DetailPhaseResult> {
    const startTime = Date.now();
    const logs: string[] = [];

    const log = (msg: string) => {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] ${msg}`);
        logs.push(`[${timestamp}] ${msg}`);
    };

    const extractionModel = input.scraperConfig?.extractionModel ?? 'gpt-4o-mini';
    const extractionTracker = new UsageTracker();
    const suggestionTracker = new UsageTracker();

    try {
        log(`[DETAIL] Processing: ${input.url}`);
        log(`[DETAIL] Title: "${input.title}"`);
        log(`[DETAIL] Action: ${input.action}${input.existingRoleId ? ` (updating ${input.existingRoleId})` : ''}`);

        const crawleeConfig = new Configuration({ persistStorage: false });
        const router = createPlaywrightRouter();

        let extractionResult: DetailPhaseResult | null = null;

        router.addDefaultHandler(async ({ page }) => {
            // Wait for content
            try {
                await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
                await page.waitForLoadState('networkidle', { timeout: 10000 });
            } catch {
                log('[DETAIL] Page load timeout - continuing with available content');
            }

            await page.waitForTimeout(2000);
            const html = await page.content();
            log(`[DETAIL] Page loaded (${html.length} chars)`);

            // Extract structured data with LLM
            log(`[DETAIL] 🤖 Extracting role data (model: ${extractionModel})...`);
            const extraction = await extractRoleFromHtml(html, input.url, extractionModel);
            extractionTracker.add(extraction.usage);

            log(`[DETAIL] ✓ Extracted: "${extraction.role.title}"`);
            log(`[DETAIL]   Location: ${extraction.role.location || 'N/A'}`);
            log(`[DETAIL]   Program type: ${extraction.role.program_type || 'N/A'}`);
            log(`[DETAIL]   Deadline: ${extraction.role.deadline || 'N/A'}`);

            // Suggest programme
            log('[DETAIL] 🎯 Suggesting programme...');
            const suggestion = await suggestProgramme({
                scrapedRole: extraction.role,
                allRolesInScan: input.allRolesInScan,
                expectedProgrammes: input.expectedProgrammes,
                existingProgrammes: input.existingProgrammes,
                firmName: input.firmName,
            });
            suggestionTracker.add(suggestion.usage);

            if (suggestion.is_new) {
                log(`[DETAIL] ✨ New programme: "${suggestion.suggested_name}"`);
            } else {
                log(`[DETAIL] ✓ Matched: "${suggestion.matched_program_name}" (${suggestion.matched_program_id})`);
            }

            // Deduplication check for new programmes
            if (suggestion.is_new && suggestion.suggested_name) {
                try {
                    const supabase = createClient(
                        process.env.NEXT_PUBLIC_SUPABASE_URL!,
                        process.env.SUPABASE_SERVICE_ROLE_KEY!
                    );

                    const { data: existingDrafts } = await supabase
                        .from('programme_discovery_drafts')
                        .select('suggested_name, normalized_name, program_type')
                        .eq('scrape_url_id', input.scrapeUrlId)
                        .eq('status', 'pending');

                    if (existingDrafts && existingDrafts.length > 0) {
                        const normalizedSuggestion = normalizeProgrammeName(suggestion.suggested_name);
                        const match = existingDrafts.find((draft: any) => {
                            return normalizeProgrammeName(draft.suggested_name) === normalizedSuggestion
                                && draft.program_type === suggestion.program_type;
                        });

                        if (match) {
                            log(`[DETAIL] 🔄 Dedup: reusing "${match.suggested_name}"`);
                            suggestion.suggested_name = match.suggested_name;
                            suggestion.normalized_name = match.normalized_name;
                        }
                    }
                } catch (error) {
                    log(`[DETAIL] ⚠️ Dedup check failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            // Save to DB
            log('[DETAIL] 💾 Saving to database...');
            const saved = await saveDiscovery({
                firmId: input.firmId,
                sourceUrlId: input.scrapeUrlId,
                scrapedRole: extraction.role,
                programmeSuggestion: suggestion,
                url: input.url,
                updateType: input.action,
                existingRoleId: input.existingRoleId,
            });

            if (saved) {
                log(`[DETAIL] ✓ Saved! Programme draft: ${saved.programmeDraftId || 'matched existing'}, Role draft: ${saved.roleDraftId}`);
                extractionResult = {
                    success: true,
                    url: input.url,
                    title: extraction.role.title,
                    programmeDraftId: saved.programmeDraftId,
                    roleDraftId: saved.roleDraftId,
                    metrics: {
                        totalTokensUsed: 0, // filled below
                        totalCostUsd: 0,
                        durationSeconds: 0,
                    },
                    logs,
                };
            } else {
                log('[DETAIL] ⚠️ Failed to save to DB');
            }
        });

        const crawler = new PlaywrightCrawler(
            {
                requestHandler: router,
                headless: true,
                maxConcurrency: 1,
                navigationTimeoutSecs: 60,
                requestHandlerTimeoutSecs: 120,
                browserPoolOptions: { useFingerprints: true },
                launchContext: {
                    launchOptions: {
                        args: ['--disable-blink-features=AutomationControlled'],
                    },
                },
            },
            crawleeConfig
        );

        await crawler.run([{ url: input.url }]);

        const extractionCost = extractionTracker.getCost('gpt-4o-mini');
        const suggestionCost = suggestionTracker.getCost('gpt-4o-mini');
        const totalCost = extractionCost.totalCost + suggestionCost.totalCost;
        const totalTokens = extractionCost.totalTokens + suggestionCost.totalTokens;
        const durationSeconds = (Date.now() - startTime) / 1000;

        log(`✅ DETAIL complete in ${durationSeconds.toFixed(2)}s | Cost: $${totalCost.toFixed(4)}`);

        if (extractionResult) {
            extractionResult.metrics = { totalTokensUsed: totalTokens, totalCostUsd: totalCost, durationSeconds };
            return extractionResult;
        }

        return {
            success: false,
            url: input.url,
            metrics: { totalTokensUsed: totalTokens, totalCostUsd: totalCost, durationSeconds },
            error: 'Extraction completed but no result captured',
            logs,
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(`✗ DETAIL failed: ${errorMessage}`);
        return {
            success: false,
            url: input.url,
            metrics: {
                totalTokensUsed: 0,
                totalCostUsd: 0,
                durationSeconds: (Date.now() - startTime) / 1000,
            },
            error: errorMessage,
            logs,
        };
    }
}


















