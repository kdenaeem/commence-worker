import { generateObject } from 'ai';
import { z } from 'zod';
import { createOpenAI } from '@ai-sdk/openai';
import type { ScrapedRole } from '@/packages/schemas/careers-scraping';
import { TokenUsage } from './cost-calculator';

// Schema for programme suggestion output
export const ProgrammeSuggestionSchema = z.object({
    // If matched to existing programme
    matched_program_id: z.string().uuid().nullable()
        .describe('UUID of matched existing programme, if any'),
    matched_program_name: z.string().nullable()
        .describe('Name of matched existing programme'),

    // If new programme suggested
    suggested_name: z.string().nullable()
        .describe('Display name for new programme (e.g., "2026 Summer Internship")'),
    normalized_name: z.string().nullable()
        .describe('Canonical name with year/location/firm stripped (e.g., "summer internship")'),
    program_type: z.enum(['summer_internship', 'spring_week', 'graduate', 'off_cycle_internship', 'apprenticeship']).nullable()
        .describe('Type of programme'),

    // Metadata
    confidence: z.enum(['high', 'medium', 'low'])
        .describe('Confidence level in this suggestion'),
    reasoning: z.string()
        .describe('Explanation for this suggestion'),
    is_new: z.boolean()
        .describe('True if suggesting a new programme, false if matched to existing'),
});

export type ProgrammeSuggestion = z.infer<typeof ProgrammeSuggestionSchema>;

export interface ExpectedProgramme {
    id?: string;
    name: string;
    normalized_name?: string;
    program_type?: string;
}

export interface SuggestProgrammeInputs {
    scrapedRole: ScrapedRole;
    allRolesInScan: Array<{ title: string; url: string }>;
    expectedProgrammes?: ExpectedProgramme[];
    existingProgrammes?: ExpectedProgramme[];
    firmName?: string;
}

const PROGRAMME_SUGGESTION_SYSTEM_PROMPT = `You are an expert at categorizing student/graduate job roles into programmes.

A programme has TWO key components:
1. **Programme name** (suggested_name/normalized_name): What the FIRM calls it (e.g., "Summer Analyst", "Graduate Scheme")
2. **Program type** (program_type): Our categorization (summer_internship, spring_week, graduate, off_cycle_internship, apprenticeship)

Program types explained (for categorization only):
- summer_internship: 8-12 week programmes during summer vacation (June-September), structured cohort-based
- spring_week: 1-week insight/introductory programmes during spring/Easter break
- graduate: Full-time structured programmes for graduates (1-3 year rotational/development programmes)
- off_cycle_internship: Internships outside summer period (spring, autumn, winter, or longer placements)
- apprenticeship: Multi-year work+study programmes with formal qualifications

Programme naming rules:
✅ USE THE FIRM'S TERMINOLOGY (extract common pattern from role titles):
- If firm uses "Summer Analyst": suggest "2026 Summer Analyst" (NOT "Summer Internship")
- If firm uses "Graduate Scheme": suggest "2026 Graduate Scheme" (NOT "Graduate Programme")
- If firm uses "Off-Cycle Analyst": suggest "2026 Off-Cycle Analyst" (NOT "Off-Cycle Internship")
- If firm uses "Insight Week": suggest "2026 Insight Week" (NOT "Spring Week")

✅ Good examples (extracting firm's common pattern):
- Roles: "2026 Summer Analyst - Equities", "2026 Summer Analyst - M&A"
  → Programme: "2026 Summer Analyst" (display), "summer analyst" (normalized)
  → program_type: summer_internship

- Roles: "2026 Technology Graduate Programme", "2026 Operations Graduate Programme"
  → Programme: "2026 Graduate Programme" (display), "graduate programme" (normalized)
  → program_type: graduate

- Roles: "2026 Off-Cycle Internship - Sales", "2026 Off-Cycle Internship - Trading"
  → Programme: "2026 Off-Cycle Internship" (display), "off cycle internship" (normalized)
  → program_type: off_cycle_internship

❌ Bad examples (DO NOT suggest these):
- "Summer Analyst - London" (location should NOT be in programme name)
- "2026 Institutional Equities Off-Cycle Analyst" (division should NOT be included when other divisions exist)
- "2026 Sales & Trading Summer Analyst" (too specific when other divisions exist)
- "Goldman Sachs Summer Analyst" (firm name should NOT be in programme name)

CRITICAL PATTERN ANALYSIS RULES:
1. **Extract the COMMON pattern from role titles using the FIRM'S terminology**
2. If you see multiple roles with SAME program_type but DIFFERENT divisions:
   → Programme name = common pattern WITHOUT division (using firm's terms)
   → DO NOT include division-specific terms

   Example:
   - "2026 Institutional Equities Off Cycle Internship - TMG"
   - "2026 Sales & Trading Off Cycle Internship - BCU"
   - "2026 Investment Management Off-cycle Internship - Sales"
   → Common pattern: "Off Cycle Internship" or "Off-Cycle Internship"
   → Programme: "2026 Off-Cycle Internship", normalized: "off cycle internship"
   → program_type: off_cycle_internship

   Example 2:
   - "2026 Summer Analyst - Investment Banking"
   - "2026 Summer Analyst - Global Markets"
   → Common pattern: "Summer Analyst"
   → Programme: "2026 Summer Analyst", normalized: "summer analyst"
   → program_type: summer_internship

3. Include division ONLY when:
   - ALL roles share the SAME division (e.g., all are "Technology Graduate")
   - OR there's only ONE role and no pattern suggests a broader programme
   - OR the division represents a genuinely separate programme structure

4. Priority matching: Expected programmes (if given) > Existing programmes > New suggestion

5. Confidence levels:
   - high: Clear match to expected/existing OR strong common pattern across multiple roles
   - medium: Probable match but some ambiguity
   - low: Uncertain, needs manual review`;

function buildProgrammeSuggestionPrompt(inputs: SuggestProgrammeInputs): string {
    const {
        scrapedRole,
        allRolesInScan,
        expectedProgrammes = [],
        existingProgrammes = [],
        firmName,
    } = inputs;

    // Build role titles list for pattern analysis
    const roleTitlesList = allRolesInScan
        .map((r, i) => `${i + 1}. "${r.title}"`)
        .join('\n');

    // Build expected programmes list (HINTS ONLY)
    const expectedList = expectedProgrammes.length > 0
        ? expectedProgrammes.map(p => `- ${p.name} (type: ${p.program_type || 'unknown'}) [HINT - NOT in database]`).join('\n')
        : 'None provided';

    // Build existing programmes list (ACTUAL DATABASE RECORDS WITH IDs)
    const existingList = existingProgrammes.length > 0
        ? existingProgrammes.map(p => {
            const id = (p as any).id || 'NO ID';
            return `- ${p.name} (ID: ${id}, normalized: ${p.normalized_name || 'N/A'}) [DATABASE RECORD]`;
        }).join('\n')
        : 'None in database';

    return `Task: Suggest which programme this role belongs to.

CONTEXT:${firmName ? `
Firm: ${firmName}` : ''}

Existing Programmes (ACTUAL DATABASE RECORDS - HIGHEST PRIORITY):
${existingList}
⚠️ CRITICAL: Only set is_new=false if matching to one of these WITH a valid ID.

Expected Programmes (HINTS/SUGGESTIONS - these are NOT in the database):
${expectedList}
⚠️ These are naming hints only. If you use one of these, treat it as a NEW programme (is_new=true).

All roles found on the same page (for pattern analysis):
${roleTitlesList}

ROLE TO CATEGORIZE:
Title: "${scrapedRole.title}"
Program Type: ${scrapedRole.program_type || 'unknown'}
Role Type: ${scrapedRole.role_type || 'unknown'}
Location: ${scrapedRole.location || 'unknown'}
${scrapedRole.description ? `Description (first 200 chars): "${scrapedRole.description.substring(0, 200)}..."` : ''}

INSTRUCTIONS:
1. FIRST, check if this role matches any EXISTING programmes (with IDs) in the database
   - Look at the "Existing Programmes" list above
   - If you find a match AND it has a valid ID: set matched_program_id=<UUID>, matched_program_name, is_new=false
   - If no valid ID exists: treat as NEW programme instead

2. If no existing match, analyze the pattern across ALL roles on the page (CRITICAL STEP)
   - Use "Expected Programmes" as naming hints/guidance
   - But the result will be a NEW programme (is_new=true)
   - Extract the COMMON PATTERN from role titles using the FIRM'S terminology
   - Count how many roles share the same program_type (categorization, not name)
   - Identify what the firm calls this programme (e.g., "Summer Analyst", "Graduate Scheme", "Off-Cycle Internship")

   - If multiple roles have SAME program_type but DIFFERENT divisions/specializations:
     → Programme name = firm's common term WITHOUT division
     → Examples:
       - Firm uses "Summer Analyst" → suggest "2026 Summer Analyst" (NOT "Summer Internship")
       - Firm uses "Off Cycle Internship" → suggest "2026 Off-Cycle Internship"
       - Firm uses "Graduate Programme" → suggest "2026 Graduate Programme"

   - If ALL roles with same program_type share the SAME division:
     → MAY include division using firm's terminology (e.g., "2026 Technology Graduate Programme")

   - If only ONE role for this program_type:
     → Consider including division if it seems like a distinct programme
     → But prefer broader name if unsure

   Example analysis:
   Roles found:
   - "2026 Institutional Equities Off Cycle Internship - TMG"
   - "2026 Sales & Trading Off Cycle Internship - BCU"
   - "2026 Investment Management Off-cycle Internship - Sales"

   Firm's terminology: "Off Cycle Internship" or "Off-Cycle Internship"
   Pattern: 3 roles, all off_cycle_internship, different divisions
   → suggested_name: "2026 Off-Cycle Internship"
   → normalized_name: "off cycle internship"
   → program_type: off_cycle_internship

   Example 2:
   Roles found:
   - "2026 Summer Analyst - Equities"
   - "2026 Summer Analyst - Fixed Income"

   Firm's terminology: "Summer Analyst"
   Pattern: 2 roles, both summer_internship, different divisions
   → suggested_name: "2026 Summer Analyst"
   → normalized_name: "summer analyst"
   → program_type: summer_internship

3. Suggest a NEW programme (is_new=true)
   - Set suggested_name: firm's terminology + year (e.g., "2026 Summer Analyst", "2026 Graduate Scheme")
   - Set normalized_name: lowercase, no year/location/firm (e.g., "summer analyst", "graduate scheme")
   - Set program_type: our categorization enum (summer_internship, spring_week, graduate, off_cycle_internship, apprenticeship)
   - Set is_new=true

5. Provide clear reasoning for your decision
   - Mention pattern analysis (e.g., "Found 3 roles with common pattern 'Off-Cycle Internship', different divisions")
   - Explain why you included/excluded division names
   - Mention the firm's terminology you identified

CRITICAL RULES:
- USE THE FIRM'S TERMINOLOGY for programme names (e.g., "Summer Analyst" if that's what they call it)
- DO NOT force programme names to match our program_type enums (suggested_name ≠ program_type)
- DO NOT include location in programme name (e.g., "Paris", "London", "New York")
- ONLY include division if ALL roles for that program_type share it, or it's a single unique programme
- When in doubt, prefer BROADER programme names using firm's terms
- Normalized name: lowercase version of firm's terminology (e.g., "summer analyst", "off cycle internship")
- Programmes are broad intake categories; divisions/roles are tracked separately per role

NAMING CONSISTENCY (for deduplication):
- Prefer "Programme" over "Program" (but use firm's terminology if they explicitly use "Program")
- For compound adjectives, use hyphens consistently (e.g., "Full-Time", "Off-Cycle")
- Capitalize major words (e.g., "Summer Analyst", not "Summer analyst")
- If you see an already-suggested programme that matches, use its EXACT name for consistency

REQUIRED OUTPUT FORMAT:
You MUST provide ALL of the following fields in your response:
- confidence: REQUIRED - Must be exactly "high", "medium", or "low"
- reasoning: REQUIRED - String explaining your decision (at least one sentence)
- is_new: REQUIRED - Boolean (true if suggesting new programme, false if matched existing)

If matched to EXISTING programme from database (is_new=false):
- matched_program_id: REQUIRED - MUST be a valid UUID from the "Existing Programmes" list
- matched_program_name: REQUIRED - Name of the matched existing programme
- suggested_name: null
- normalized_name: null
- program_type: null
⚠️ CRITICAL RULE: If you don't have a valid UUID, you CANNOT use is_new=false!

If suggesting NEW programme (is_new=true):
- suggested_name: REQUIRED - Display name with year (e.g., "2026 Summer Analyst")
- normalized_name: REQUIRED - Canonical name without year/location (e.g., "summer analyst")
- program_type: REQUIRED - Must be one of: "summer_internship", "spring_week", "graduate", "off_cycle_internship", "apprenticeship"
- matched_program_id: null
- matched_program_name: null

⚠️ COMMON MISTAKE TO AVOID:
DO NOT match to "Expected Programmes" and set is_new=false.
Expected programmes are naming hints, NOT database records.
If you want to use an expected programme name → set is_new=true and use it as suggested_name.

Example of WRONG output:
- is_new: false, matched_program_name: "off-cycle analyst", matched_program_id: null ❌ WRONG!
(This matches an Expected Programme, not an Existing Programme)

Example of CORRECT output:
- is_new: true, suggested_name: "2026 Off-Cycle Analyst", matched_program_id: null ✅ CORRECT!`;
}

/**
 * Suggests which programme a scraped role belongs to using LLM.
 * Uses a priority system: Expected programmes > Existing programmes > New suggestion
 */
export async function suggestProgramme(
    inputs: SuggestProgrammeInputs
): Promise<ProgrammeSuggestion & { usage: TokenUsage }> {
    try {
        const openaiProvider = process.env.OPENAI_API_KEY
            ? createOpenAI({ apiKey: process.env.OPENAI_API_KEY })
            : createOpenAI();

        const { object, usage } = await generateObject({
            model: openaiProvider('gpt-4o-mini'),
            schema: ProgrammeSuggestionSchema,
            schemaName: 'ProgrammeSuggestion',
            schemaDescription: 'A programme suggestion with matched or new programme details',
            system: PROGRAMME_SUGGESTION_SYSTEM_PROMPT,
            prompt: buildProgrammeSuggestionPrompt(inputs),
            maxRetries: 3, // Retry up to 3 times on schema validation failures
        });

        // Handle token usage with fallback
        const usageAny = usage as any;
        const promptTokens = usageAny.promptTokens ?? usageAny.prompt_tokens ?? usageAny.inputTokens ?? 0;
        const completionTokens = usageAny.completionTokens ?? usageAny.completion_tokens ?? usageAny.outputTokens ?? 0;
        const totalTokens = usageAny.totalTokens ?? usageAny.total_tokens ?? 0;

        let correctedObject = { ...object };

        // CRITICAL FIX: Always regenerate normalized_name using our function
        // Don't trust LLM's normalized_name - ensure consistency
        if (correctedObject.is_new && correctedObject.suggested_name) {
            const regeneratedNormalized = normalizeProgrammeName(correctedObject.suggested_name);
            console.log('[suggestProgramme] 📝 Regenerating normalized_name:');
            console.log('[suggestProgramme]   From:', correctedObject.suggested_name);
            console.log('[suggestProgramme]   To:', regeneratedNormalized);
            correctedObject.normalized_name = regeneratedNormalized;
        }

        // CRITICAL VALIDATION: Enforce invariant
        // is_new=false MUST have a valid UUID, otherwise it should be is_new=true

        if (!correctedObject.is_new && !correctedObject.matched_program_id) {
            console.warn('[suggestProgramme] ⚠️  LLM set is_new=false but matched_program_id=null');
            console.warn('[suggestProgramme] This means it matched to an Expected Programme (hint), not an Existing Programme (database)');
            console.warn('[suggestProgramme] Auto-correcting: Converting to NEW programme suggestion');
            console.warn('[suggestProgramme] Matched name was:', correctedObject.matched_program_name);

            // Auto-correct: Convert to new programme
            const currentYear = new Date().getFullYear();
            const matchedName = correctedObject.matched_program_name || 'Programme';

            correctedObject = {
                ...correctedObject,
                is_new: true,
                suggested_name: matchedName.includes(String(currentYear))
                    ? matchedName
                    : `${currentYear} ${matchedName}`,
                normalized_name: normalizeProgrammeName(matchedName),
                program_type: inputs.scrapedRole.program_type || 'summer_internship',
                matched_program_id: null,
                matched_program_name: null,
                reasoning: `${correctedObject.reasoning} [Auto-corrected from expected programme hint to new programme]`,
            };

            console.warn('[suggestProgramme] Corrected to:', {
                is_new: true,
                suggested_name: correctedObject.suggested_name,
                normalized_name: correctedObject.normalized_name,
                program_type: correctedObject.program_type,
            });
        }

        return {
            ...correctedObject,
            usage: {
                promptTokens,
                completionTokens,
                totalTokens,
            },
        };
    } catch (error) {
        console.error('[suggestProgramme] ❌ Schema validation failed after 3 retries');
        console.error('[suggestProgramme] Role title:', inputs.scrapedRole.title);
        console.error('[suggestProgramme] Firm:', inputs.firmName);
        console.error('[suggestProgramme] Program type:', inputs.scrapedRole.program_type);
        console.error('[suggestProgramme] Error details:', error);

        // If error has response data, log it for debugging
        if (error && typeof error === 'object' && 'text' in error) {
            console.error('[suggestProgramme] Raw LLM response:', (error as any).text);
        }

        // Re-throw to let the exploration runner handle it
        throw error;
    }
}

/**
 * Helper to normalize programme name for matching
 * Light normalization to catch common variations while preserving meaning
 */
export function normalizeProgrammeName(name: string): string {
    return name
        .toLowerCase()
        .replace(/\bprogramme\b/g, 'program') // Standardize UK vs US spelling
        .replace(/\b(20\d{2})\b/g, '') // Remove years like 2024, 2025, 2026
        .replace(/\b(london|new york|nyc|birmingham|manchester|edinburgh|dublin)\b/gi, '') // Remove common locations
        .replace(/[^\w\s]/g, ' ') // Replace punctuation (including hyphens) with spaces
        .replace(/\s+/g, ' ') // Collapse multiple spaces
        .trim();
}
