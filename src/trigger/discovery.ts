import { task, logger } from "@trigger.dev/sdk/v3";
import { chromium } from "playwright";
import * as cheerio from "cheerio";
import Anthropic from "@anthropic-ai/sdk";


interface JobData {
    title: string;
    company: string;
    description: string;
    location?: string;
    salary?: string;
    url: string;
    scrapedAt: string;
}

// Simple parser - we'll make this smarter later
function parseJobPage(html: string, url: string): JobData {
    const $ = cheerio.load(html);

    // Generic selectors - works on most job sites
    return {
        title: $('h1, [class*="title"], [class*="job-title"]').first().text().trim() || "Unknown Title",
        company: $('[class*="company"], [class*="employer"]').first().text().trim() || "Unknown Company",
        description: $('[class*="description"], .description, [id*="description"]').first().text().trim().slice(0, 1000) || "No description",
        location: $('[class*="location"]').first().text().trim(),
        salary: $('[class*="salary"], [class*="compensation"]').first().text().trim(),
        url,
        scrapedAt: new Date().toISOString(),
    };
}

// Validate and clean with Claude
async function validateWithClaude(jobData: JobData): Promise<JobData> {
    const anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
    });

    const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{
            role: "user",
            content: `Clean and validate this job posting data. Return ONLY valid JSON with these exact fields:

{
"title": "cleaned job title",
"company": "cleaned company name",
"description": "cleaned description (max 500 chars)",
"location": "standardized location or null",
"salary": "cleaned salary or null",
"url": "keep as-is",
"scrapedAt": "keep as-is"
}

Raw data:
${JSON.stringify(jobData, null, 2)}

Rules:
- Remove all HTML tags
- Trim whitespace
- Ensure title and company are not empty
- Standardize location format (City, Country)
- Extract salary range if present
- Keep description concise`
        }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const cleaned = text.replace(/```json\n?|\n?```/g, '').trim();

    return JSON.parse(cleaned);
}

// Main scraping task
export const discoveryFlow = task({
    id: "discovery-flow",
    maxDuration: 300, // 5 minutes per batch
    queue: {
        name: "scraping-queue",
        concurrencyLimit: 1, // Process 1 URL at a time (adjust later)
    },
    run: async (payload: { urls: string[] }) => {
        if (!payload.urls || payload.urls.length === 0) {
            logger.warn("No URLs provided for discovery flow");
            return { summary: { total: 0, successful: 0, failed: 0 }, results: [], error: "No URLs provided" };
        }

        if (!payload?.urls || !Array.isArray(payload.urls)) {
            logger.error("Invalid payload structure", { payload });
            return { summary: { total: 0, successful: 0, failed: 0 }, results: [], error: "Invalid payload structure. URLS must be a non-empty array" };
        }

        if (!process.env.ANTHROPIC_API_KEY) {
            logger.error("Anthropic API key not set in environment variables");
            return { summary: { total: 0, successful: 0, failed: 0 }, results: [], error: "Anthropic API key not configured" };
        }

        logger.info("🚀 Starting discovery flow", { urlCount: payload.urls.length });

        const browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // Important for low-memory VPS
            ],
        });

        const results = [];

        for (const url of payload.urls) {
            const page = await browser.newPage();

            try {
                logger.info("🌐 Navigating to URL", { url });

                await page.goto(url, {
                    timeout: 180000, // 3 minutes max per page
                    waitUntil: 'domcontentloaded', // Don't wait for everything
                });

                // Wait a bit for dynamic content
                await page.waitForTimeout(2000);

                const html = await page.content();

                logger.info("📝 Parsing job data", { url });
                const rawData = parseJobPage(html, url);

                logger.info("🤖 Validating with Claude", { url });
                const validated = await validateWithClaude(rawData);

                results.push({
                    url,
                    data: validated,
                    success: true,
                });

                logger.info("✅ Successfully processed", { url, title: validated.title });

            } catch (error: any) {
                logger.error("❌ Failed to process URL", {
                    url,
                    error: error.message,
                    stack: error.stack?.split('\n')[0],
                });

                results.push({
                    url,
                    success: false,
                    error: error.message,
                });
            } finally {
                await page.close();
            }
        }

        await browser.close();

        const successCount = results.filter(r => r.success).length;
        const failCount = results.filter(r => !r.success).length;

        logger.info("🏁 Discovery flow complete", {
            total: results.length,
            successful: successCount,
            failed: failCount,
            successRate: `${Math.round((successCount / results.length) * 100)}%`,
        });

        return {
            summary: {
                total: results.length,
                successful: successCount,
                failed: failCount,
            },
            results,
        };
    },
});
