/**
 * Canonical name extraction for role matching
 *
 * Purpose: Identify roles by their core identity, ignoring URL and temporal variations.
 * Used to detect:
 * - URL changes (same role, different URL)
 * - Reopenings (role was closed, now reopened)
 *
 * Location is typically already embedded in the title (e.g., "2026 Summer Analyst - London"),
 * so we canonicalize the full title without appending location separately.
 */

/**
 * Extract canonical name from a role title
 *
 * Normalization:
 * - Remove years (2024, 2025, 2026, etc.)
 * - Replace punctuation with spaces (-, (), /, etc.)
 * - Normalize whitespace and lowercase
 *
 * @param title - Raw role title (e.g., "2026 Summer Analyst - London")
 * @returns Canonical name (e.g., "summer analyst london")
 *
 * @example
 * extractCanonicalName("2026 Summer Analyst - London")
 * // => "summer analyst london"
 *
 * @example
 * extractCanonicalName("Investment Banking Summer Analyst (2025) - New York")
 * // => "investment banking summer analyst new york"
 *
 * @example
 * extractCanonicalName("Off-Cycle Internship – Sales & Trading – Paris")
 * // => "off cycle internship sales trading paris"
 */
export function extractCanonicalName(title: string): string {
    if (!title) return '';

    // Remove years (2024, 2025, 2026, etc.)
    let canonical = title.replace(/\b20\d{2}\b/g, '').trim();

    // Replace punctuation with spaces (-, (), /, &, etc.)
    canonical = canonical.replace(/[^\w\s]/g, ' ');

    // Normalize whitespace and lowercase
    canonical = canonical.replace(/\s+/g, ' ').trim().toLowerCase();

    return canonical;
}

/**
 * Batch extract canonical names for multiple titles
 * Useful for preprocessing existing roles during skip-DETAIL optimization
 */
export function extractCanonicalNames(titles: string[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const title of titles) {
        if (title) {
            map.set(title, extractCanonicalName(title));
        }
    }
    return map;
}
