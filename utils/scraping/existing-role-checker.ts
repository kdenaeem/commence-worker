/**
 * Helper utilities for checking existing roles in the database
 * Used during exploration to determine if a role should be skipped, updated, or reopened
 */

import { createClient } from '@supabase/supabase-js';
import { extractCanonicalName } from './canonical-name';
import { normalizeUrl } from './url-normalizer';
import type { RoleAction } from '@/packages/schemas/careers-scraping';

export interface ExistingRole {
    id: string; // NEW: program_role id (UUID primary key)
    program_id: string;
    role_id: string;
    url: string | null;
    canonical_name: string | null;
    is_open: boolean | null;
    title: string | null;
}

export interface ExistingRolesByUrl extends Map<string, ExistingRole> { }
export interface ExistingRolesByName extends Map<string, ExistingRole> { }

export interface DismissedDraft {
    url: string;
    canonical_name: string | null;
}

export interface DismissedDraftsByUrl extends Map<string, DismissedDraft> { }
export interface DismissedDraftsByName extends Map<string, DismissedDraft> { }

/**
 * Load all existing roles for a firm, indexed by URL and canonical name
 */
export async function loadExistingRoles(firmId: string): Promise<{
    byUrl: ExistingRolesByUrl;
    byName: ExistingRolesByName;
}> {
    // Create Supabase client with service role key
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Query program_roles with JOINs to get all available metadata
    // This includes both new scraper data (with title/url/canonical_name)
    // and old trackr data (which needs synthesis from program/role metadata)
    const { data: roles, error } = await supabase
        .from('program_roles')
        .select(`
      id,
      program_id,
      role_id,
      url,
      canonical_name,
      is_open,
      title,
      alias,
      programs!inner(
        firm_id,
        name,
        program_type
      ),
      roles!inner(
        slug,
        label
      )
    `)
        .eq('programs.firm_id', firmId);

    if (error) {
        console.error('Error loading existing roles:', error);
        return { byUrl: new Map(), byName: new Map() };
    }

    if (!roles || roles.length === 0) {
        console.log('No roles found for firm, returning empty role sets');
        return { byUrl: new Map(), byName: new Map() };
    }

    console.log(`Found ${roles.length} roles for firm, indexing for matching...`);

    const byUrl: ExistingRolesByUrl = new Map();
    const byName: ExistingRolesByName = new Map();

    let synthesizedCount = 0;
    let actualDataCount = 0;

    for (const role of roles) {
        // Determine title: use actual if exists, else synthesize from program + role metadata
        let effectiveTitle: string | null = role.title;
        let effectiveCanonicalName: string | null = role.canonical_name;

        if (!effectiveTitle) {
            // Synthesize title for trackr-sourced data
            const programName = (role.programs as any)?.name || '';
            const roleLabel = (role.roles as any)?.label || '';
            const alias = role.alias;

            if (programName) {
                effectiveTitle = alias
                    ? `${programName} - ${alias}`
                    : `${programName} - ${roleLabel}`;
                synthesizedCount++;
            }
        } else {
            actualDataCount++;
        }

        // Generate canonical name if not present
        if (!effectiveCanonicalName && effectiveTitle) {
            effectiveCanonicalName = extractCanonicalName(effectiveTitle);
        }

        // Create the role object for indexing
        const existingRole: ExistingRole = {
            id: role.id,
            program_id: role.program_id,
            role_id: role.role_id,
            url: role.url,
            canonical_name: effectiveCanonicalName,
            is_open: role.is_open,
            title: effectiveTitle,
        };

        // Index by URL (only if URL exists - new scraper data)
        if (role.url) {
            const normalized = normalizeUrl(role.url);
            byUrl.set(normalized, existingRole);
        }

        // Index by canonical name (works for both old and new data)
        if (effectiveCanonicalName) {
            byName.set(effectiveCanonicalName, existingRole);
        }
    }

    console.log(`Indexed ${roles.length} roles: ${actualDataCount} with actual data, ${synthesizedCount} synthesized from metadata`);
    console.log(`  - ${byUrl.size} roles indexed by URL`);
    console.log(`  - ${byName.size} roles indexed by canonical name`);

    return { byUrl, byName };
}

/**
 * Load all dismissed role discovery drafts for a firm, indexed by URL and canonical name
 */
export async function loadDismissedDrafts(firmId: string): Promise<{
    byUrl: DismissedDraftsByUrl;
    byName: DismissedDraftsByName;
}> {
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Query dismissed role discovery drafts
    const { data: drafts, error } = await supabase
        .from('role_discovery_drafts')
        .select('url, scraped_data')
        .eq('firm_id', firmId)
        .eq('status', 'dismissed');

    if (error) {
        console.error('Error loading dismissed drafts:', error);
        return { byUrl: new Map(), byName: new Map() };
    }

    if (!drafts || drafts.length === 0) {
        console.log('No dismissed drafts found for firm');
        return { byUrl: new Map(), byName: new Map() };
    }

    console.log(`Found ${drafts.length} dismissed drafts for firm, indexing for matching...`);

    const byUrl: DismissedDraftsByUrl = new Map();
    const byName: DismissedDraftsByName = new Map();

    for (const draft of drafts) {
        if (!draft.url) continue;

        // Extract canonical name from scraped_data if available
        let canonicalName: string | null = null;
        if (draft.scraped_data && typeof draft.scraped_data === 'object') {
            const scrapedData = draft.scraped_data as any;
            if (scrapedData.title) {
                canonicalName = extractCanonicalName(scrapedData.title);
            }
        }

        const dismissedDraft: DismissedDraft = {
            url: draft.url,
            canonical_name: canonicalName,
        };

        // Index by URL
        const normalizedUrl = normalizeUrl(draft.url);
        byUrl.set(normalizedUrl, dismissedDraft);

        // Index by canonical name if available
        if (canonicalName) {
            byName.set(canonicalName, dismissedDraft);
        }
    }

    console.log(`Indexed ${drafts.length} dismissed drafts:`);
    console.log(`  - ${byUrl.size} by URL`);
    console.log(`  - ${byName.size} by canonical name`);

    return { byUrl, byName };
}

/**
 * Determine what action to take for a discovered role link
 *
 * Returns:
 * - SKIP: Role exists with same URL and is still open, OR was explicitly dismissed
 * - REOPENING: Role exists but was closed (same URL OR same canonical name)
 * - URL_CHANGED: Role exists with same canonical name but different URL (still open)
 * - NEW_ROLE: Genuinely new role
 */
export function classifyRoleAction(
    roleUrl: string,
    roleTitle: string,
    existingByUrl: ExistingRolesByUrl,
    existingByName: ExistingRolesByName,
    dismissedByUrl?: DismissedDraftsByUrl,
    dismissedByName?: DismissedDraftsByName
): {
    action: RoleAction;
    existingRoleId?: string;
    urlChanged?: boolean;
} {
    const normalizedUrl = normalizeUrl(roleUrl);
    const canonicalName = extractCanonicalName(roleTitle);

    // Check 0: Dismissed drafts (highest priority - always skip)
    if (dismissedByUrl && dismissedByUrl.has(normalizedUrl)) {
        return {
            action: 'SKIP',
            existingRoleId: undefined, // No existing role ID for dismissed drafts
        };
    }

    if (dismissedByName && dismissedByName.has(canonicalName)) {
        return {
            action: 'SKIP',
            existingRoleId: undefined,
        };
    }

    // Check 1: Exact URL match
    const existingByUrlMatch = existingByUrl.get(normalizedUrl);
    if (existingByUrlMatch) {
        // If role is explicitly open, skip
        if (existingByUrlMatch.is_open === true) {
            return {
                action: 'SKIP',
                existingRoleId: existingByUrlMatch.id, // Use program_role id directly
            };
        }
        // If role was closed, this is a reopening (same URL)
        if (existingByUrlMatch.is_open === false) {
            return {
                action: 'REOPENING',
                existingRoleId: existingByUrlMatch.id,
                urlChanged: false,
            };
        }
        // If is_open is null/undefined, treat as URL_CHANGED to re-extract
        return {
            action: 'URL_CHANGED',
            existingRoleId: existingByUrlMatch.id,
        };
    }

    // Check 2: Canonical name match (URL different)
    const existingByNameMatch = existingByName.get(canonicalName);
    if (existingByNameMatch) {
        // If role is closed, this is a reopening (with URL change)
        if (existingByNameMatch.is_open === false) {
            return {
                action: 'REOPENING',
                existingRoleId: existingByNameMatch.id,
                urlChanged: true, // URL changed during reopening
            };
        }
        // If role is open, this is just a URL change
        return {
            action: 'URL_CHANGED',
            existingRoleId: existingByNameMatch.id,
        };
    }

    // Check 3: Genuinely new role
    return {
        action: 'NEW_ROLE',
    };
}

/**
 * Get existing programme URLs for a firm to help with deduplication
 */
export async function getExistingProgrammeUrls(firmId: string): Promise<Set<string>> {
    // Create Supabase client with service role key
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const { data: programmes, error } = await supabase
        .from('programs')
        .select('listings_page_url')
        .eq('firm_id', firmId);

    if (error) {
        console.error('Error loading existing programme URLs:', error);
        return new Set();
    }

    const urls = new Set<string>();
    for (const prog of programmes || []) {
        if (prog.listings_page_url) {
            urls.add(normalizeUrl(prog.listings_page_url));
        }
    }

    return urls;
}
