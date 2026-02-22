/**
 * URL normalization for role deduplication
 *
 * Purpose: Normalize URLs to prevent false "URL changed" detections
 * Addresses Edge Case #8: URL parameters or tracking codes change
 *
 * Example:
 * - `/careers?id=123` vs `/careers?id=123&utm_source=email`
 * - These are the same page, should be treated as same URL
 */

/**
 * Normalize a URL by removing query parameters and fragments
 *
 * @param url - Raw URL from careers page
 * @returns Normalized URL (protocol + hostname + pathname only)
 *
 * @example
 * normalizeUrl("https://example.com/careers?id=123&utm_source=email")
 * // => "https://example.com/careers"
 *
 * @example
 * normalizeUrl("https://example.com/jobs/analyst#details")
 * // => "https://example.com/jobs/analyst"
 */
export function normalizeUrl(url: string): string {
    if (!url) return '';

    try {
        const parsed = new URL(url);
        // Return protocol + hostname + pathname only (no query params, no hash)
        return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
    } catch (error) {
        // If URL parsing fails, return original URL
        console.warn(`Failed to parse URL: ${url}`, error);
        return url;
    }
}

/**
 * Check if two URLs are equivalent after normalization
 */
export function areUrlsEquivalent(url1: string, url2: string): boolean {
    return normalizeUrl(url1) === normalizeUrl(url2);
}

/**
 * Batch normalize URLs for multiple entries
 * Useful for preprocessing existing roles during skip-DETAIL optimization
 */
export function normalizeUrls(urls: string[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const url of urls) {
        if (url) {
            map.set(url, normalizeUrl(url));
        }
    }
    return map;
}
