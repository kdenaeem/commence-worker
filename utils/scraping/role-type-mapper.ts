/**
 * Role Type Mapper
 *
 * Maps extracted role_type strings to actual role IDs from the roles table.
 * Uses fuzzy matching to handle variations in role type names.
 */

import { createClient } from '@supabase/supabase-js';

// Cache to avoid repeated DB queries
let rolesCache: Array<{ id: string; slug: string; label: string }> | null = null;

/**
 * Load all roles from the database (with caching)
 */
async function loadRoles(): Promise<Array<{ id: string; slug: string; label: string }>> {
    if (rolesCache) {
        return rolesCache;
    }

    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const { data: roles, error } = await supabase
        .from('roles')
        .select('id, slug, label')
        .eq('is_active', true)
        .order('display_order');

    if (error) {
        console.error('Error loading roles:', error);
        return [];
    }

    rolesCache = roles || [];
    return rolesCache;
}

/**
 * Normalize a role type string for matching
 */
function normalizeRoleType(roleType: string): string {
    return roleType
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ') // Replace special chars with spaces
        .replace(/\s+/g, ' ') // Collapse multiple spaces
        .trim();
}

/**
 * Calculate similarity score between two strings (0-1)
 * Uses Levenshtein-like approach
 */
function calculateSimilarity(str1: string, str2: string): number {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;

    if (longer.length === 0) {
        return 1.0;
    }

    // Check if one contains the other (high score)
    if (longer.includes(shorter)) {
        return 0.9;
    }

    // Calculate edit distance
    const editDistance = calculateEditDistance(str1, str2);
    return (longer.length - editDistance) / longer.length;
}

/**
 * Calculate Levenshtein edit distance
 */
function calculateEditDistance(str1: string, str2: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= str2.length; i++) {
        matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
        for (let j = 1; j <= str1.length; j++) {
            if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    matrix[i][j - 1] + 1,     // insertion
                    matrix[i - 1][j] + 1      // deletion
                );
            }
        }
    }

    return matrix[str2.length][str1.length];
}

/**
 * Map a role type string to a role ID from the roles table
 *
 * Returns the best matching role ID, or null if no good match found.
 * Uses fuzzy matching with a minimum similarity threshold of 0.6
 */
export async function mapRoleTypeToRoleId(
    roleType: string | null | undefined
): Promise<string | null> {
    if (!roleType) {
        return null;
    }

    const roles = await loadRoles();
    if (roles.length === 0) {
        return null;
    }

    const normalizedInput = normalizeRoleType(roleType);

    // Try exact slug match first
    const exactMatch = roles.find(r => r.slug === normalizedInput);
    if (exactMatch) {
        console.log(`[role-mapper] Exact match: "${roleType}" -> ${exactMatch.slug} (${exactMatch.id})`);
        return exactMatch.id;
    }

    // Try fuzzy matching on both slug and label
    let bestMatch: { role: typeof roles[0]; score: number } | null = null;

    for (const role of roles) {
        const slugScore = calculateSimilarity(normalizedInput, normalizeRoleType(role.slug));
        const labelScore = calculateSimilarity(normalizedInput, normalizeRoleType(role.label));
        const score = Math.max(slugScore, labelScore);

        if (score > 0.6 && (!bestMatch || score > bestMatch.score)) {
            bestMatch = { role, score };
        }
    }

    if (bestMatch) {
        console.log(
            `[role-mapper] Fuzzy match: "${roleType}" -> ${bestMatch.role.slug} (${bestMatch.role.id}) [score: ${bestMatch.score.toFixed(2)}]`
        );
        return bestMatch.role.id;
    }

    console.log(`[role-mapper] No match found for: "${roleType}"`);
    return null;
}

/**
 * Clear the roles cache (useful for testing or after role updates)
 */
export function clearRolesCache(): void {
    rolesCache = null;
}
