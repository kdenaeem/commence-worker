import { task } from "@trigger.dev/sdk/v3";
import { createClient } from "@supabase/supabase-js";
import { runExplorationJob } from "@/utils/scraping/exploration-runner";

export const discoveryFlowTask = task({
    id: "discovery-flow",
    maxDuration: 3600,
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
        id,
        url,
        firm_id,
        expected_programmes,
        scraper_config,
        firms!inner(id, name, slug)
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

        const result = await runExplorationJob({
            scrapeUrlId: scrapeUrl.id,
            url: scrapeUrl.url,
            firmId: scrapeUrl.firm_id,
            firmName: firm.name,
            firmSlug: firm.slug,
            expectedProgrammes: scrapeUrl.expected_programmes || [],
            existingProgrammes: existingProgrammes || [],
            scraperConfig: scrapeUrl.scraper_config || {},
        });

        if (!result.success) {
            throw new Error(`Exploration failed for ${firm.name}: ${result.error}`);
        }

        return {
            firmName: firm.name,
            url: scrapeUrl.url,
            metrics: result.metrics,
        };
    },
});
