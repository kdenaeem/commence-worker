/**
 * Database functions for saving programme and role discoveries
 *
 * These functions are called by the scraper to persist discoveries
 * for admin review before being applied to the main tables.
 */

import { createClient } from '@supabase/supabase-js';
import type {
    ProgrammeDiscoveryDraftInsert,
    RoleDiscoveryDraftInsert
} from '@/types/database.types';
import type {
    ScrapedRole,
    ProgrammeSuggestion,
    RoleAction
} from '@/packages/schemas/careers-scraping';

/**
 * Save a programme discovery draft
 */
export async function saveProgrammeDiscoveryDraft(data: {
    firmId: string;
    sourceUrlId: string;
    suggestedName: string;
    normalizedName: string;
    programType: string;
    confidence: 'high' | 'medium' | 'low';
    matchedProgramId?: string | null;
    rolesPreview: ScrapedRole[];
    reasoning: string;
}): Promise<{ id: string } | null> {
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Check for existing pending draft with same normalized name and firm
    const { data: existingDraft } = await supabase
        .from('programme_discovery_drafts')
        .select('id')
        .eq('firm_id', data.firmId)
        .eq('normalized_name', data.normalizedName)
        .eq('status', 'pending')
        .single();

    if (existingDraft) {
        return existingDraft;
    }

    const draft: ProgrammeDiscoveryDraftInsert = {
        firm_id: data.firmId,
        source_url_id: data.sourceUrlId === 'manual-test' ? null : data.sourceUrlId,
        suggested_name: data.suggestedName,
        normalized_name: data.normalizedName,
        program_type: data.programType,
        confidence: data.confidence,
        matched_existing_program_id: data.matchedProgramId,
        roles_preview: data.rolesPreview as any,
        reasoning: data.reasoning,
        status: 'pending',
        source: 'careers-scraper',
    };

    const { data: inserted, error } = await supabase
        .from('programme_discovery_drafts')
        .insert(draft)
        .select('id')
        .single();

    if (error) {
        console.error('Error saving programme discovery draft:', error);
        return null;
    }

    return inserted;
}

/**
 * Save a role discovery draft with smart deduplication
 *
 * If an existing draft is found for the same role, it will be updated to pending
 * with fresh data. This handles REOPENING, URL_CHANGED, and NEW_ROLE cases.
 */
export async function saveRoleDiscoveryDraft(data: {
    firmId: string;
    scrapedRole: ScrapedRole;
    programmeSuggestion: ProgrammeSuggestion;
    url: string;
    updateType: RoleAction;
    existingRoleId?: string | null;
    programmeDraftId?: string | null;
}): Promise<{ id: string } | null> {
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Step 1: Check for existing draft to update instead of creating duplicate
    let existingDraft = null;

    if (data.existingRoleId) {
        // For REOPENING and URL_CHANGED: Find by existing_role_id (program_role id)
        const { data: found } = await supabase
            .from('role_discovery_drafts')
            .select('id, status')
            .eq('firm_id', data.firmId)
            .eq('existing_role_id', data.existingRoleId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        existingDraft = found;
    } else {
        // For NEW_ROLE: Find by URL (no existing_role_id yet)
        const { data: found } = await supabase
            .from('role_discovery_drafts')
            .select('id, status')
            .eq('firm_id', data.firmId)
            .eq('url', data.url)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        existingDraft = found;
    }

    const draftData = {
        firm_id: data.firmId,
        programme_discovery_draft_id: data.programmeDraftId,
        program_id: data.programmeSuggestion.matched_program_id,
        existing_role_id: data.existingRoleId, // Use program_role id directly
        update_type: data.updateType === 'SKIP' ? null : data.updateType,
        scraped_data: data.scrapedRole as any,
        url: data.url,
        confidence: data.programmeSuggestion.confidence,
        status: 'pending' as const,
        source: 'careers-scraper' as const,
    };

    // Step 2: Handle existing drafts
    if (existingDraft) {
        // Skip if draft is already pending (under review)
        if (existingDraft.status === 'pending') {
            console.log(`[saveRoleDiscoveryDraft] Found existing draft ${existingDraft.id} with status=pending, skipping (preserving draft under review)`);
            return existingDraft;
        }

        // For approved/dismissed drafts: Create NEW draft to preserve history
        console.log(`[saveRoleDiscoveryDraft] Found existing draft ${existingDraft.id} with status=${existingDraft.status}, creating new draft (preserving approval history)`);
    } else {
        console.log(`[saveRoleDiscoveryDraft] No existing draft found, creating new one`);
    }

    // Create new draft (either no existing draft, or existing was approved/dismissed)
    const { data: inserted, error } = await supabase
        .from('role_discovery_drafts')
        .insert(draftData)
        .select('id')
        .single();

    if (error) {
        console.error('Error inserting role discovery draft:', error);
        return null;
    }

    return inserted;
}

/**
 * Save a complete discovery (programme + role) in a transaction
 *
 * This is the main function called by the scraper for each discovered role.
 */
export async function saveDiscovery(data: {
    firmId: string;
    sourceUrlId: string;
    scrapedRole: ScrapedRole;
    programmeSuggestion: ProgrammeSuggestion;
    url: string;
    updateType: RoleAction;
    existingRoleId?: string | null;
}): Promise<{
    programmeDraftId?: string;
    roleDraftId?: string;
} | null> {
    // Skip saving if action is SKIP
    if (data.updateType === 'SKIP') {
        return null;
    }

    let programmeDraftId: string | undefined;

    // Step 1: If programme is new, create programme draft first
    if (data.programmeSuggestion.is_new && data.programmeSuggestion.suggested_name) {
        const programmeDraft = await saveProgrammeDiscoveryDraft({
            firmId: data.firmId,
            sourceUrlId: data.sourceUrlId,
            suggestedName: data.programmeSuggestion.suggested_name,
            normalizedName: data.programmeSuggestion.normalized_name || data.programmeSuggestion.suggested_name.toLowerCase(),
            programType: data.programmeSuggestion.program_type || 'summer_internship',
            confidence: data.programmeSuggestion.confidence,
            matchedProgramId: null,
            rolesPreview: [data.scrapedRole],
            reasoning: data.programmeSuggestion.reasoning,
        });

        if (!programmeDraft) {
            console.error('Failed to create programme draft');
            return null;
        }

        programmeDraftId = programmeDraft.id;
    }

    // Step 2: Create role draft
    const roleDraft = await saveRoleDiscoveryDraft({
        firmId: data.firmId,
        scrapedRole: data.scrapedRole,
        programmeSuggestion: data.programmeSuggestion,
        url: data.url,
        updateType: data.updateType,
        existingRoleId: data.existingRoleId,
        programmeDraftId: programmeDraftId,
    });

    if (!roleDraft) {
        console.error('Failed to create role draft');
        return null;
    }

    return {
        programmeDraftId,
        roleDraftId: roleDraft.id,
    };
}

/**
 * Update scrape_urls metrics after a scrape job completes
 */
export async function updateScrapeUrlMetrics(data: {
    scrapeUrlId: string;
    metrics: {
        roles_found: number;
        roles_skipped: number;
        roles_new: number;
        roles_url_changed: number;
        roles_reopened: number;
        total_tokens_used: number;
        total_cost_usd: number;
        duration_seconds: number;
    };
    error?: string | null;
}): Promise<void> {
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // First, fetch current scrape URL to append to runs_history
    const { data: currentScrapeUrl, error: fetchError } = await supabase
        .from('scrape_urls')
        .select('runs_history, metrics, last_scraped_at')
        .eq('id', data.scrapeUrlId)
        .single();

    if (fetchError) {
        console.error('Error fetching current scrape URL:', fetchError);
    }

    // Append current run to runs_history
    const currentRunsHistory = (currentScrapeUrl?.runs_history as any[]) || [];
    const newRunEntry = {
        timestamp: new Date().toISOString(),
        metrics: data.metrics,
        error: data.error || null,
    };

    // Keep last 50 runs only (prevent unbounded growth)
    const updatedRunsHistory = [...currentRunsHistory, newRunEntry].slice(-50);

    const update: any = {
        last_scraped_at: new Date().toISOString(),
        metrics: data.metrics,
        runs_history: updatedRunsHistory,
        updated_at: new Date().toISOString(),
    };

    if (data.error) {
        update.last_error = data.error;
        update.error_count = { increment: 1 }; // Increment error count
        update.status = 'failed';
    } else {
        update.error_count = 0; // Reset error count on success
        update.status = 'active';
    }

    const { error } = await supabase
        .from('scrape_urls')
        .update(update)
        .eq('id', data.scrapeUrlId);

    if (error) {
        console.error('Error updating scrape_urls metrics:', error);
    }
}
