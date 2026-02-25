import { generateObject } from 'ai';
import { ScrapedRoleSchema, ScrapedRole, LinkClassificationSchema, LinkWithContext } from '@/packages/schemas/careers-scraping';
import * as cheerio from 'cheerio';
import { createOpenAI } from '@ai-sdk/openai';
import TurndownService from 'turndown';
import { TokenUsage, ExtractionModel } from './cost-calculator';

// Initialize turndown for HTML -> Markdown conversion
const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
});

// Remove images and media from markdown output (not useful for LLM)
// Using 'remove' with tag names that turndown supports
turndown.remove(['img', 'iframe', 'video', 'audio', 'picture', 'source']);

/**
 * Cleans HTML by removing noise elements and converts to Markdown.
 * No truncation - sends full content to LLM.
 */
export function cleanHtmlToMarkdown(html: string): string {
    const $ = cheerio.load(html);

    // Remove noise elements
    const selectorsToRemove = [
        'script',
        'style',
        'noscript',
        'nav',
        'header',
        'footer',
        'aside',
        'iframe',
        'svg',
        'canvas',
        'video',
        'audio',
        '.cookie-banner',
        '.cookie-consent',
        '[class*="cookie"]',
        '[class*="Cookie"]',
        '[class*="gdpr"]',
        '[class*="GDPR"]',
        '[class*="popup"]',
        '[class*="modal"]',
        '[class*="advertisement"]',
        '[class*="social-share"]',
        '[class*="share-button"]',
        '[aria-hidden="true"]',
        '[role="navigation"]',
        '[role="banner"]',
        '[role="contentinfo"]',
        '.ads',
        '.ad-container',
        '#ads',
    ];

    selectorsToRemove.forEach((selector) => {
        try {
            $(selector).remove();
        } catch {
            // Ignore invalid selectors
        }
    });

    // Try to find main content area first
    const mainContentSelectors = [
        'main',
        'article',
        '[role="main"]',
        '.job-details',
        '.job-description',
        '.job-content',
        '.posting-content',
        '.position-details',
        '#job-details',
        '#job-description',
        '.content-main',
        '.main-content',
    ];

    let contentHtml = '';
    for (const selector of mainContentSelectors) {
        const mainContent = $(selector).first();
        if (mainContent.length > 0) {
            contentHtml = mainContent.html() || '';
            break;
        }
    }

    // Fallback to body if no main content found
    if (!contentHtml) {
        contentHtml = $('body').html() || html;
    }

    // Convert to markdown
    const markdown = turndown.turndown(contentHtml);

    // Clean up excessive whitespace while preserving structure
    return markdown
        .replace(/\n{3,}/g, '\n\n') // Max 2 newlines
        .replace(/[ \t]+/g, ' ') // Collapse horizontal whitespace
        .trim();
}

/**
 * Extracts structured role data from HTML content using an LLM.
 * Converts HTML to clean Markdown first for better LLM comprehension.
 */
export async function extractRoleFromHtml(
    html: string,
    url: string,
    model: ExtractionModel = 'gpt-4o-mini'
): Promise<{
    role: ScrapedRole;
    usage: TokenUsage;
}> {
    const markdown = cleanHtmlToMarkdown(html);

    const systemPrompt = `You are an expert job posting data extractor. Your task is to extract structured information from job posting pages.

IMPORTANT INSTRUCTIONS:
- Extract ONLY information that is explicitly stated on the page
- For dates, convert to ISO format (YYYY-MM-DD) if possible
- For process steps, list them in order (e.g., "Online Application", "Assessment", "Interview")
- If a field is not present or unclear, leave it undefined/null
- is_open should be true if the posting appears to accept applications, false if it says "closed" or "no longer accepting"
- is_rolling should be true if it mentions "rolling basis", "reviewed as received", etc.

ROLE TYPE MAPPING:
Try to map the role to one of these STANDARD role types (use the slug):
- investment-banking: Investment Banking / IBD / M&A / Corporate Finance
- sales-and-trading: Sales & Trading / Markets / Trading
- private-equity: Private Equity / PE / Buyout
- hedge-fund-prop-trading: Hedge Fund / Prop Trading / Quant Trading
- consulting: Consulting / Strategy / Management Consulting
- asset-management: Asset Management / Buy-side / Portfolio Management
- research: Research / Equity Research / Market Research
- risk-management: Risk Management / Risk Analytics / Compliance
- wealth-management: Wealth Management / Private Wealth / Private Banking

If the role clearly fits one of these, set role_type to that slug.
If it doesn't fit any of these categories, leave role_type as null and provide a suggested_new_role_type as a label.

PROGRAM TYPE:
Determine if this is:
- summer_internship: Summer internship/analyst program (typically 8-12 weeks in summer)
- spring_week: Spring week / insight program (typically 1 week)
- graduate: Graduate program / full-time new grad role / rotational program
- off_cycle_internship: Off-cycle internship (internships outside summer, e.g., winter, fall, spring)
- apprenticeship: Multi-year work+study programmes with formal qualifications

DESCRIPTION:
Give detailed summary of the job description text. Include responsibilities, what the role entails, team info, etc.`;
    const openaiProvider = process.env.OPENAI_API_KEY
        ? createOpenAI({ apiKey: process.env.OPENAI_API_KEY })
        : createOpenAI();

    try {
        const { object, usage } = await generateObject({
            model: openaiProvider(model),
            schema: ScrapedRoleSchema,
            system: systemPrompt,
            prompt: `Extract job role details from the following job posting page.

URL: ${url}

PAGE CONTENT:
${markdown}`,
        });

        // Log the raw usage object to debug
        console.log('Raw usage object:', JSON.stringify(usage, null, 2));

        // Handle different possible property names (AI SDK uses inputTokens/outputTokens)
        const usageAny = usage as any;
        let promptTokens = usageAny.promptTokens ?? usageAny.prompt_tokens ?? usageAny.inputTokens ?? 0;
        let completionTokens = usageAny.completionTokens ?? usageAny.completion_tokens ?? usageAny.outputTokens ?? 0;
        const totalTokens = usageAny.totalTokens ?? usageAny.total_tokens ?? 0;

        // Fallback: if breakdown not available but total is, estimate 80/20 split (prompt/completion)
        if (promptTokens === 0 && completionTokens === 0 && totalTokens > 0) {
            console.warn('Token breakdown not available, using 80/20 estimate');
            promptTokens = Math.floor(totalTokens * 0.8);
            completionTokens = totalTokens - promptTokens;
        }

        return {
            role: object,
            usage: {
                promptTokens,
                completionTokens,
                totalTokens,
            },
        };
    } catch (error) {
        console.error('LLM Extraction failed:', error);

        // Retry once on failure
        try {
            console.log('Retrying extraction...');
            const { object, usage } = await generateObject({
                model: openaiProvider('gpt-4o-mini'),
                schema: ScrapedRoleSchema,
                system: systemPrompt,
                prompt: `Extract job role details from the following job posting page.

URL: ${url}

PAGE CONTENT:
${markdown}`,
            });

            // Handle different possible property names (AI SDK uses inputTokens/outputTokens)
            const usageAny = usage as any;
            let promptTokens = usageAny.promptTokens ?? usageAny.prompt_tokens ?? usageAny.inputTokens ?? 0;
            let completionTokens = usageAny.completionTokens ?? usageAny.completion_tokens ?? usageAny.outputTokens ?? 0;
            const totalTokens = usageAny.totalTokens ?? usageAny.total_tokens ?? 0;

            // Fallback: if breakdown not available but total is, estimate 80/20 split
            if (promptTokens === 0 && completionTokens === 0 && totalTokens > 0) {
                console.warn('Token breakdown not available on retry, using 80/20 estimate');
                promptTokens = Math.floor(totalTokens * 0.8);
                completionTokens = totalTokens - promptTokens;
            }

            return {
                role: object,
                usage: {
                    promptTokens,
                    completionTokens,
                    totalTokens,
                },
            };
        } catch (retryError) {
            console.error('Retry also failed:', retryError);
            return {
                role: {
                    title: 'Extraction Failed',
                    description: `Failed to extract: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
                },
                usage: {
                    promptTokens: 0,
                    completionTokens: 0,
                    totalTokens: 0,
                },
            };
        }
    }
}

/**
 * Classifies which links from a page are likely job detail pages.
 * Uses LLM to understand context rather than relying on URL patterns.
 */
export async function classifyJobLinks(links: LinkWithContext[]): Promise<{
    jobLinks: Array<{ url: string; title: string; confidence: 'high' | 'medium' | 'low' }>;
    usage: TokenUsage;
}> {
    if (links.length === 0) {
        return {
            jobLinks: [],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
    }
    const openaiProvider = process.env.OPENAI_API_KEY
        ? createOpenAI({ apiKey: process.env.OPENAI_API_KEY })
        : createOpenAI();

    // Prepare links for classification (include all context)
    const linksForLLM = links.map((link, index) => ({
        index,
        url: link.url,
        linkText: link.text,
        headings: link.headings,
        cardText: link.cardText,
        ariaLabel: link.ariaLabel,
    }));

    try {
        const { object, usage } = await /* The above code is a comment block in TypeScript. It appears
        to be documenting a function called `generateObject`. */
            generateObject({
                model: openaiProvider('gpt-4o-mini'), // Use mini for speed/cost on classification
                schema: LinkClassificationSchema,
                system: `You are an expert at identifying job posting links and extracting specific role titles from career pages.

Your task:
1. Identify which links lead to INDIVIDUAL JOB ROLE DETAIL PAGES
2. Extract the actual role title corresponding to each job posting link

For each link, you have:
- url: The link URL
- linkText: Button/link text (often generic like "Apply Now", "Learn More")
- headings: Array of headings found in the card/section containing this link
- cardText: Full text content from the card
- ariaLabel: Accessibility label if present

How to identify job postings:
- Has a specific role title in headings or card text
- Is NOT navigation (Home, About, Contact)
- Is NOT a filter/category (All Jobs, Engineering)
- Is NOT social media or external links

How to extract role title:
1. Check 'headings' array first - role title is usually the first or second heading
2. If unclear from headings, extract from 'cardText'
3. DO NOT use 'linkText' as the title (it's generic button text)
4. Extract the full role title as it appears (e.g., "2026 Summer Analyst - Investment Banking")

Confidence levels:
- high: Clear job posting with obvious role title in headings
- medium: Likely job posting, title extracted from card text
- low: Uncertain if it's a job posting`,
                prompt: `Analyze these links from a careers page. For each job posting, extract the actual role title.

LINKS TO ANALYZE:
${JSON.stringify(linksForLLM, null, 2)}

Return only the links that are individual job postings, with their extracted role titles.`,
            });

        // Log the raw usage object to debug
        console.log('Classification raw usage:', JSON.stringify(usage, null, 2));

        // Handle different possible property names (AI SDK uses inputTokens/outputTokens)
        const usageAny = usage as any;
        let promptTokens = usageAny.promptTokens ?? usageAny.prompt_tokens ?? usageAny.inputTokens ?? 0;
        let completionTokens = usageAny.completionTokens ?? usageAny.completion_tokens ?? usageAny.outputTokens ?? 0;
        const totalTokens = usageAny.totalTokens ?? usageAny.total_tokens ?? 0;

        // Fallback: if breakdown not available but total is, estimate 70/30 split (classification uses less output)
        if (promptTokens === 0 && completionTokens === 0 && totalTokens > 0) {
            console.warn('Token breakdown not available for classification, using 70/30 estimate');
            promptTokens = Math.floor(totalTokens * 0.7);
            completionTokens = totalTokens - promptTokens;
        }

        return {
            jobLinks: object.jobLinks,
            usage: {
                promptTokens,
                completionTokens,
                totalTokens,
            },
        };
    } catch (error) {
        console.error('Link classification failed:', error);
        return {
            jobLinks: [],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
    }
}

/**
 * Finds the job card container for a link using structural heuristics.
 *
 * Strategy:
 * 1. Try semantic HTML first (article, li)
 * 2. Find nearest parent containing a heading (structural heuristic)
 * 3. Fallback: go up 3 levels
 */
function findJobCardContainer($link: cheerio.Cheerio<any>): cheerio.Cheerio<any> {
    // Strategy 1: Semantic HTML (fast path if present)
    const $semantic = $link.closest('article, li');
    if ($semantic.length > 0) {
        return $semantic;
    }

    // Strategy 2: Structural heuristic - find parent with heading
    // Traverse up looking for container that has both link AND heading
    let $current = $link.parent();
    let depth = 0;
    const maxDepth = 4; // Start conservative, can adjust based on testing

    while ($current.length > 0 && depth < maxDepth) {
        // Does this container have a heading?
        const hasHeading = $current.find('h1, h2, h3, h4, h5, h6').length > 0;

        if (hasHeading) {
            return $current; // Found container with both link and heading
        }

        $current = $current.parent();
        depth++;
    }

    // Strategy 3: Fallback - go up 3 levels
    return $link.parent().parent().parent();
}

/**
 * Extracts all links from page HTML with their surrounding context.
 * This is used as input for the LLM link classifier.
 *
 * Uses broad structural heuristics to find job card context:
 * - Extracts all headings from the card/section containing the link
 * - Extracts full card text for LLM context
 * - Let LLM figure out which heading is the actual role title
 */
export function extractLinksWithContext(html: string, baseUrl: string): LinkWithContext[] {
    const $ = cheerio.load(html);
    const links: LinkWithContext[] = [];
    const seenUrls = new Set<string>();

    $('a[href]').each((_, element) => {
        const $el = $(element);
        const href = $el.attr('href');

        if (!href) return;

        // Resolve relative URLs
        let absoluteUrl: string;
        try {
            absoluteUrl = new URL(href, baseUrl).href;
        } catch {
            return; // Invalid URL
        }

        // Skip non-http links and duplicates
        if (!absoluteUrl.startsWith('http')) return;
        if (seenUrls.has(absoluteUrl)) return;
        seenUrls.add(absoluteUrl);

        // Skip obvious non-job links
        const lowerUrl = absoluteUrl.toLowerCase();
        if (
            lowerUrl.includes('linkedin.com') ||
            lowerUrl.includes('facebook.com') ||
            lowerUrl.includes('twitter.com') ||
            lowerUrl.includes('instagram.com') ||
            lowerUrl.includes('youtube.com') ||
            lowerUrl.includes('mailto:') ||
            lowerUrl.includes('tel:') ||
            lowerUrl.endsWith('.pdf') ||
            lowerUrl.endsWith('.doc') ||
            lowerUrl.endsWith('.docx')
        ) {
            return;
        }

        const text = $el.text().trim();
        const ariaLabel = $el.attr('aria-label') || '';

        // Skip empty text links (likely icons)
        if (!text && !ariaLabel) return;

        // Find the job card container using structural heuristics
        const $container = findJobCardContainer($el);

        // Extract all headings from the container
        const headings = $container
            .find('h1, h2, h3, h4, h5, h6')
            .map((_: any, el: any) => $(el).text().trim())
            .get()
            .filter((heading: any) => heading.length > 0);

        // Extract full card text (truncated to avoid overwhelming LLM)
        let cardText = $container
            .text()
            .trim()
            .replace(/\s+/g, ' '); // Normalize whitespace

        if (cardText.length > 500) {
            cardText = cardText.substring(0, 500) + '...';
        }

        links.push({
            url: absoluteUrl,
            text,
            headings,
            cardText,
            ariaLabel,
        });
    });

    return links;
}

/**
 * Normalizes a URL for deduplication purposes.
 * Strips tracking parameters and normalizes format.
 */
export function normalizeUrl(url: string): string {
    try {
        const parsed = new URL(url);

        // Remove common tracking parameters
        const trackingParams = [
            'utm_source',
            'utm_medium',
            'utm_campaign',
            'utm_term',
            'utm_content',
            'ref',
            'source',
            'fbclid',
            'gclid',
            '_ga',
        ];
        trackingParams.forEach((param) => parsed.searchParams.delete(param));

        // Normalize: lowercase host, remove trailing slash
        parsed.hostname = parsed.hostname.toLowerCase();
        let normalized = parsed.href;
        if (normalized.endsWith('/')) {
            normalized = normalized.slice(0, -1);
        }

        return normalized;
    } catch {
        return url;
    }
}
