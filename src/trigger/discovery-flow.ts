import { task, logger } from "@trigger.dev/sdk/v3";
import { createClient } from "@supabase/supabase-js";
import { runListPhase } from "../../utils/scraping/list-phase";
import { runDetailPhase, DetailPhaseInput } from "../../utils/scraping/detail-phase";
import { updateScrapeUrlMetrics } from "../../utils/scraping/save-discoveries";

// ============================================================
// Task 1: Discovery Flow - scans listing pages, fans out to detail tasks
// ============================================================
export const discoveryFlowTask = task({
    id: "discovery-flow",
    maxDuration: 3600,
    queue: {
        name: "scraping-queue",
        concurrencyLimit: 3,
    },
    run: async (payload: { scrapeUrlId: string }) => {
        const { scrapeUrlId } = payload;

        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        );

        // Fetch scrape URL with firm info
        const { data: scrapeUrl, error: scrapeUrlError } = await supabase
            .from("scrape_urls")
            .select(`
        id, url, firm_id, expected_programmes, scraper_config,
        firms!scrape_urls_firm_id_fkey(id, name, slug)
    `)
            .eq("id", scrapeUrlId)
            .single();

        if (scrapeUrlError || !scrapeUrl) {
            throw new Error(`Failed to fetch scrape URL ${scrapeUrlId}: ${scrapeUrlError?.message}`);
        }

        const firm = scrapeUrl.firms as any;

        // Fetch existing programmes for the firm
        const { data: existingProgrammes } = await supabase
            .from("programs")
            .select("id, name, normalized_name, program_type")
            .eq("firm_id", scrapeUrl.firm_id);

        logger.info(`Starting discovery for ${firm.name}`, { url: scrapeUrl.url });

        // Phase 1: Scan listing pages, collect role links
        const listResult = await runListPhase({
            scrapeUrlId: scrapeUrl.id,
            url: scrapeUrl.url,
            firmId: scrapeUrl.firm_id,
            firmName: firm.name,
            scraperConfig: scrapeUrl.scraper_config || {},
        });

        if (!listResult.success) {
            throw new Error(`LIST phase failed: ${listResult.error}`);
        }

        logger.info(`LIST phase complete`, {
            rolesFound: listResult.collectedLinks.length,
            pagesProcessed: listResult.metrics.pagesProcessed,
        });

        if (listResult.collectedLinks.length === 0) {
            logger.info("No new roles found, skipping detail extraction");
            return {
                firmName: firm.name,
                url: scrapeUrl.url,
                rolesFound: 0,
                batchId: null,
            };
        }

        // Apply maxRoles limit
        const maxRoles = scrapeUrl.scraper_config?.maxRoles ?? null;
        const linksToExtract = maxRoles
            ? listResult.collectedLinks.slice(0, maxRoles)
            : listResult.collectedLinks;

        logger.info(`Triggering ${linksToExtract.length} parallel detail extractions...`);

        // Phase 2: Fan out detail extraction tasks in parallel
        const batch = await roleExtractionTask.batchTrigger(
            linksToExtract.map(link => ({
                payload: {
                    url: link.url,
                    title: link.title,
                    action: link.action,
                    existingRoleId: link.existingRoleId,
                    firmId: scrapeUrl.firm_id,
                    firmName: firm.name,
                    firmSlug: firm.slug,
                    scrapeUrlId: scrapeUrl.id,
                    expectedProgrammes: scrapeUrl.expected_programmes || [],
                    existingProgrammes: existingProgrammes || [],
                    allRolesInScan: listResult.allRolesInScan,
                    scraperConfig: scrapeUrl.scraper_config || {},
                } satisfies DetailPhaseInput,
            }))
        );

        logger.info(`Batch triggered`, { batchId: batch.batchId, count: linksToExtract.length });

        return {
            firmName: firm.name,
            url: scrapeUrl.url,
            rolesFound: linksToExtract.length,
            batchId: batch.batchId,
            listMetrics: listResult.metrics,
        };
    },
});

// ============================================================
// Task 2: Role Extraction - processes a single detail page
// ============================================================
export const roleExtractionTask = task({
    id: "role-extraction",
    maxDuration: 300,
    queue: {
        name: "extraction-queue",
        concurrencyLimit: 5, // 5 detail pages processed in parallel
    },
    run: async (payload: DetailPhaseInput) => {
        logger.info(`Extracting role`, { url: payload.url, action: payload.action });

        const result = await runDetailPhase(payload);

        if (!result.success) {
            throw new Error(`Detail extraction failed for ${payload.url}: ${result.error}`);
        }

        logger.info(`✅ Role extracted`, {
            url: payload.url,
            title: result.title,
            cost: `$${result.metrics.totalCostUsd.toFixed(4)}`,
        });

        return result;
    },
});


















