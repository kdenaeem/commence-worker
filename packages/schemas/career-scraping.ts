import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

/**
 * Schema for role data extracted from a career detail page.
 * Mirrors the target structure for the extended `program_roles` table.
 */
export const ScrapedRoleSchema = z.object({
    title: z.string().describe('Raw role title as seen on the page'),
    role_type: z.string().nullable().optional().describe('Mapped to standard role slug from: investment-banking, sales-and-trading, private-equity, hedge-fund-prop-trading, consulting, asset-management, research, risk-management, wealth-management. If none match, leave null.'),
    suggested_new_role_type: z.string().nullable().optional().describe('If role_type is null, suggest a new role type label that would fit this role'),
    program_type: z.enum(['summer_internship', 'spring_week', 'graduate', 'off_cycle_internship', 'apprenticeship']).nullable().optional().describe('Type of program: summer_internship (8-12 week summer vacation programmes), spring_week (1 week insight programmes), graduate (full-time structured programmes), off_cycle_internship (internships outside summer period), or apprenticeship (multi-year work+study programmes)'),
    location: z.string().nullable().optional().describe('Location string if available'),
    description: z.string().nullable().optional().describe('Full or summarized role description'),

    // Timeline & Status
    opening_date: z.string().nullable().optional().describe('Opening date in ISO format (YYYY-MM-DD)'),
    deadline: z.string().nullable().optional().describe('Application deadline in ISO format (YYYY-MM-DD)'),
    is_rolling: z.boolean().nullable().optional().describe('Whether applications are reviewed on a rolling basis'),
    is_open: z.boolean().nullable().optional().describe('Whether the role appears to be currently accepting applications'),
    current_round: z.string().nullable().optional().describe('Current application round if specified'),

    // Requirements & Process
    process: z.array(z.string()).nullable().optional().describe('List of application steps'),
    requirements: z.object({
        degree_required: z.string().nullable().optional(),
        min_year_of_study: z.string().nullable().optional(),
        skills: z.array(z.string()).nullable().optional(),
    }).nullable().optional().describe('Structured requirements'),

    // Flags
    cv_required: z.boolean().nullable().optional(),
    cover_letter_required: z.boolean().nullable().optional(),
    written_answers_required: z.boolean().nullable().optional(),

    // Links
    info_test_prep_url: z.string().nullable().optional(),
}).openapi('ScrapedRole');

/**
 * Schema for the output of the scraping playground.
 */
export const ScrapingResultSchema = z.object({
    url: z.string(),
    extracted_at: z.string(),
    status: z.enum(['success', 'error']),
    error: z.string().optional(),
    data: ScrapedRoleSchema.optional(),
    raw_html: z.string().optional().describe('Snippet of raw HTML for debugging'),
}).openapi('ScrapingResult');

export type ScrapedRole = z.infer<typeof ScrapedRoleSchema>;
export type ScrapingResult = z.infer<typeof ScrapingResultSchema>;

/**
 * Schema for a link with its surrounding context.
 * Used as input for LLM-based link classification.
 */
export const LinkWithContextSchema = z.object({
    url: z.string().describe('The absolute URL of the link'),
    text: z.string().describe('The text content of the anchor element'),
    headings: z.array(z.string()).describe('Array of headings (h1-h6) found in the containing card/section'),
    cardText: z.string().describe('Text content from the card/section containing this link'),
    ariaLabel: z.string().describe('The aria-label attribute if present'),
}).openapi('LinkWithContext');

export type LinkWithContext = z.infer<typeof LinkWithContextSchema>;

/**
 * Schema for the LLM response when classifying job links.
 */
export const LinkClassificationSchema = z.object({
    jobLinks: z.array(z.object({
        url: z.string().describe('The URL of the job posting'),
        title: z.string().describe('The inferred job title from link text'),
        confidence: z.enum(['high', 'medium', 'low']).describe('Confidence that this is a job detail link'),
    })).describe('Links identified as individual job postings'),
}).openapi('LinkClassification');

export type LinkClassification = z.infer<typeof LinkClassificationSchema>;

/**
 * Schema for expected programme configuration in scrape_urls
 */
export const ExpectedProgrammeSchema = z.object({
    name: z.string().describe('Expected programme name (e.g., "2026 Summer Analyst")'),
    program_type: z.enum(['summer_internship', 'spring_week', 'graduate', 'off_cycle_internship', 'apprenticeship']),
    normalized_name: z.string().optional().describe('Normalized name for matching'),
}).openapi('ExpectedProgramme');

export type ExpectedProgramme = z.infer<typeof ExpectedProgrammeSchema>;

/**
 * Schema for scraper configuration in scrape_urls
 */
export const ScraperConfigSchema = z.object({
    filters: z.object({
        includeKeywords: z.array(z.string()).optional(),
        excludeKeywords: z.array(z.string()).optional(),
    }).optional(),
    selectors: z.object({
        listContainer: z.string().optional(),
        jobLinks: z.string().optional(),
    }).optional(),
    notes: z.string().optional(),
}).openapi('ScraperConfig');

export type ScraperConfig = z.infer<typeof ScraperConfigSchema>;

/**
 * Schema for programme suggestion output from LLM
 */
export const ProgrammeSuggestionSchema = z.object({
    // If matched to existing programme
    matched_program_id: z.string().uuid().nullable(),

    // If new programme suggested
    suggested_name: z.string().nullable().describe('Display name using firm\'s terminology'),
    normalized_name: z.string().nullable().describe('Lowercase, no year/location/firm'),
    program_type: z.enum(['summer_internship', 'spring_week', 'graduate', 'off_cycle_internship', 'apprenticeship']).nullable(),

    // Metadata
    confidence: z.enum(['high', 'medium', 'low']),
    reasoning: z.string(),
    is_new: z.boolean(),
}).openapi('ProgrammeSuggestion');

export type ProgrammeSuggestion = z.infer<typeof ProgrammeSuggestionSchema>;

/**
 * Schema for inputs to the programme suggester
 */
export const SuggestProgrammeInputsSchema = z.object({
    scrapedRole: ScrapedRoleSchema,
    allRolesInScan: z.array(z.object({
        url: z.string(),
        title: z.string(),
    })),
    expectedProgrammes: z.array(ExpectedProgrammeSchema).optional(),
    existingProgrammes: z.array(z.object({
        id: z.string(),
        name: z.string(),
        normalized_name: z.string().nullable(),
        program_type: z.string(),
    })).optional(),
    firmName: z.string().optional(),
    firmId: z.string(),
}).openapi('SuggestProgrammeInputs');

export type SuggestProgrammeInputs = z.infer<typeof SuggestProgrammeInputsSchema>;

/**
 * Schema for role action classification (skip, new, update, reopen)
 */
export const RoleActionSchema = z.enum(['SKIP', 'NEW_ROLE', 'URL_CHANGED', 'REOPENING']);
export type RoleAction = z.infer<typeof RoleActionSchema>;

/**
 * Schema for a classified role link during exploration
 */
export const ClassifiedRoleLinkSchema = z.object({
    url: z.string(),
    title: z.string(),
    action: RoleActionSchema,
    existingRoleId: z.string().uuid().optional(),
    urlChanged: z.boolean().optional(),
}).openapi('ClassifiedRoleLink');

export type ClassifiedRoleLink = z.infer<typeof ClassifiedRoleLinkSchema>;

/**
 * Schema for metrics tracked per scrape job
 */
export const ScrapeMetricsSchema = z.object({
    roles_found: z.number(),
    roles_skipped: z.number(),
    roles_new: z.number(),
    roles_url_changed: z.number(),
    roles_reopened: z.number(),
    total_tokens_used: z.number(),
    total_cost_usd: z.number(),
    duration_seconds: z.number(),
    success_rate: z.number().optional(),
}).openapi('ScrapeMetrics');

export type ScrapeMetrics = z.infer<typeof ScrapeMetricsSchema>;
