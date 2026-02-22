/**
 * Helper utilities for approving discoveries
 *
 * Handles the complex logic of creating programmes and roles from discovery drafts.
 */

import { createClient } from '@supabase/supabase-js';
import { extractCanonicalName } from './canonical-name';
import { mapRoleTypeToRoleId } from './role-type-mapper';
import type { ScrapedRole } from '@/packages/schemas/careers-scraping';

/**
 * Approve a programme discovery draft
 * Creates a new programme in the programs table
 */
export async function approveProgrammeDraft(draftId: string): Promise<{
    success: boolean;
    programmeId?: string;
    error?: string;
}> {
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Fetch the draft
    const { data: draft, error: fetchError } = await supabase
        .from('programme_discovery_drafts')
        .select('*')
        .eq('id', draftId)
        .single();

    if (fetchError || !draft) {
        return { success: false, error: 'Draft not found' };
    }

    // Check if already approved or if programme exists
    if (draft.status === 'approved') {
        // Try to find the existing programme
        const { data: existing } = await supabase
            .from('programs')
            .select('id')
            .eq('firm_id', draft.firm_id)
            .eq('normalized_name', draft.normalized_name)
            .single();

        if (existing) {
            return { success: true, programmeId: existing.id };
        }
    }

    // Check for existing programme with same name to avoid duplicates
    const { data: collision } = await supabase
        .from('programs')
        .select('id')
        .eq('firm_id', draft.firm_id)
        .eq('normalized_name', draft.normalized_name)
        .single();

    if (collision) {
        // Auto-link to existing
        await supabase
            .from('programme_discovery_drafts')
            .update({ status: 'approved', reviewed_at: new Date().toISOString() })
            .eq('id', draftId);

        return { success: true, programmeId: collision.id };
    }

    // Map program_type to DB enum values
    let programType = draft.program_type;
    if (programType === 'off_cycle_internship') {
        programType = 'off_cycle';
    }
    // apprenticeship is now a valid enum value, so no mapping needed

    // Create the programme
    const { data: programme, error: createError } = await supabase
        .from('programs')
        .insert({
            firm_id: draft.firm_id,
            name: draft.suggested_name,
            normalized_name: draft.normalized_name,
            program_type: programType,
            source: 'careers-scraper',
            source_url_id: draft.source_url_id,
            // Other fields can be populated from role data later
        })
        .select('id')
        .single();

    if (createError || !programme) {
        console.error('Error creating programme:', createError);
        return { success: false, error: 'Failed to create programme' };
    }

    // Update the draft status
    await supabase
        .from('programme_discovery_drafts')
        .update({ status: 'approved', reviewed_at: new Date().toISOString() })
        .eq('id', draftId);

    return { success: true, programmeId: programme.id };
}

/**
 * Approve a role discovery draft
 *
 * Behavior depends on update_type:
 * - NEW_ROLE: Create new program_roles entry
 * - URL_CHANGED: Update existing program_roles with new URL
 * - REOPENING: Update existing program_roles (set is_open=true, update metadata)
 */
export async function approveRoleDraft(
    draftId: string,
    programmeId: string // The programme this role belongs to (could be from draft or selected by admin)
): Promise<{
    success: boolean;
    roleId?: string;
    error?: string;
}> {
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Fetch the draft
    const { data: draft, error: fetchError } = await supabase
        .from('role_discovery_drafts')
        .select('*')
        .eq('id', draftId)
        .single();

    if (fetchError || !draft) {
        return { success: false, error: 'Draft not found' };
    }

    const scrapedData = draft.scraped_data as ScrapedRole;
    const updateType = draft.update_type;
    const existingRoleId = draft.existing_role_id;

    // Prepare role data
    const roleData = {
        title: scrapedData.title,
        canonical_name: extractCanonicalName(scrapedData.title),
        role_type: scrapedData.role_type || null,
        location: scrapedData.location || null,
        description: scrapedData.description || null,
        url: draft.url,
        opening_date: scrapedData.opening_date || null,
        deadline: scrapedData.deadline || null,
        rolling: scrapedData.is_rolling ?? null,
        is_open: scrapedData.is_open !== false, // Default to true if not explicitly false
        current_round: scrapedData.current_round || null,
        process: scrapedData.process || null,
        cv_required: scrapedData.cv_required ?? null,
        cover_letter_required: scrapedData.cover_letter_required ?? null,
        written_answers_required: scrapedData.written_answers_required ?? null,
        info_test_prep_url: scrapedData.info_test_prep_url || null,
        source: 'careers-scraper' as const,
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
    };

    if (updateType === 'NEW_ROLE') {
        // Create new role
        // Map role_type to actual role_id from roles table
        const roleId = await mapRoleTypeToRoleId(scrapedData.role_type);

        const { error: createError } = await supabase
            .from('program_roles')
            .insert({
                program_id: programmeId,
                role_id: roleId, // Mapped from role_type
                ...roleData,
            });

        if (createError) {
            console.error('Error creating role:', createError);
            return { success: false, error: 'Failed to create role' };
        }

        // Update draft status
        await supabase
            .from('role_discovery_drafts')
            .update({ status: 'approved', reviewed_at: new Date().toISOString() })
            .eq('id', draftId);

        // Fetch the created role ID if possible, but program_roles has composite PK.
        // We can try to fetch it by program_id and role_id
        const { data: createdRole } = await supabase
            .from('program_roles')
            .select('role_id') // We only need confirmation it exists
            .eq('program_id', programmeId)
            .eq('role_id', roleId)
            .single();

        return { success: true, roleId: createdRole ? `${programmeId}|${roleId}` : undefined };
    } else if (updateType === 'URL_CHANGED' || updateType === 'REOPENING') {
        // Update existing role
        if (!existingRoleId) {
            return { success: false, error: 'No existing role ID for update' };
        }

        const updateData: any = {
            ...roleData,
            last_status_change_at: new Date().toISOString(),
        };

        // For reopening, explicitly set is_open = true and clear closed_date
        if (updateType === 'REOPENING') {
            updateData.is_open = true;
            updateData.closed_date = null;
        }

        // Use the program_role id directly (not composite anymore)
        const { error: updateError } = await supabase
            .from('program_roles')
            .update(updateData)
            .eq('id', existingRoleId);

        if (updateError) {
            console.error('Error updating role:', updateError);
            return { success: false, error: 'Failed to update role' };
        }

        // Update draft status
        await supabase
            .from('role_discovery_drafts')
            .update({ status: 'approved', reviewed_at: new Date().toISOString() })
            .eq('id', draftId);

        return { success: true, roleId: existingRoleId };
    }

    return { success: false, error: 'Unknown update type' };
}

/**
 * Get diff preview for approving roles
 * Shows what will be kept, deleted, and added
 */
export async function getApprovalDiff(
    programmeId: string,
    roleDraftIds: string[]
): Promise<{
    toKeep: Array<{ id: string; title: string; source: string }>;
    toDelete: Array<{ id: string; title: string; source: string }>;
    toAdd: Array<{ draftId: string; title: string }>;
}> {
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Resolve programme ID if it's a draft that matches an existing programme
    let resolvedProgrammeId = programmeId;
    let firmId: string | null = null;

    // Check if it's a draft and has a match
    const { data: draft } = await supabase
        .from('programme_discovery_drafts')
        .select('firm_id, matched_existing_program_id')
        .eq('id', programmeId)
        .single();

    if (draft) {
        firmId = draft.firm_id;
        if (draft.matched_existing_program_id) {
            resolvedProgrammeId = draft.matched_existing_program_id;
        }
    } else {
        // Check if it's an existing program
        const { data: prog } = await supabase
            .from('programs')
            .select('firm_id')
            .eq('id', programmeId)
            .single();

        if (prog) {
            firmId = prog.firm_id;
        }
    }

    // Get existing roles for this SPECIFIC programme (to show what's being kept/modified)
    const { data: existingRoles } = await supabase
        .from('program_roles')
        .select('title, alias, source, program_id, role_id, roles(label)')
        .eq('program_id', resolvedProgrammeId);

    // Get ALL Trackr roles for the FIRM (to show what's being deleted)
    // We want to delete ALL legacy Trackr roles when approving new scraped data
    let firmTrackrRoles: any[] = [];
    if (firmId) {
        const { data: trackrRoles, error: trackrError } = await supabase
            .from('program_roles')
            .select('title, alias, source, program_id, role_id, programs!inner(firm_id), roles(label)')
            .eq('programs.firm_id', firmId)
            .eq('source', 'trackr');

        if (trackrError) {
            console.error('[getApprovalDiff] Error fetching trackr roles:', trackrError);
        }

        firmTrackrRoles = trackrRoles || [];
    }

    // Get role drafts to be added
    const { data: roleDrafts } = await supabase
        .from('role_discovery_drafts')
        .select('id, scraped_data')
        .in('id', roleDraftIds);

    const toKeep: Array<{ id: string; title: string; source: string }> = [];
    // Use a map for deletions to avoid duplicates and ensure unique listing
    const toDeleteMap = new Map<string, { id: string; title: string; source: string }>();

    // Helper to resolve display title
    const getDisplayTitle = (role: any, fallbackSuffix = '') => {
        const roleLabel = Array.isArray(role.roles) ? role.roles[0]?.label : role.roles?.label;
        const title = role.title || role.alias || roleLabel || 'Untitled Role';
        return fallbackSuffix ? `${title} ${fallbackSuffix}` : title;
    };

    // 1. Add ALL firm-wide Trackr roles to delete list
    firmTrackrRoles.forEach(role => {
        const key = `${role.program_id}|${role.role_id}`;
        toDeleteMap.set(key, {
            id: key,
            title: getDisplayTitle(role, '(Trackr Legacy)'),
            source: role.source,
        });
    });

    // 2. Classify existing roles for the specific programme
    for (const role of existingRoles || []) {
        const key = `${role.program_id}|${role.role_id}`;
        const displayTitle = getDisplayTitle(role);

        if (role.source === 'manual') {
            // Always keep manual roles
            toKeep.push({
                id: key,
                title: displayTitle,
                source: role.source,
            });
        } else if (role.source === 'trackr') {
            // Should already be in toDeleteMap, but ensure it is
            if (!toDeleteMap.has(key)) {
                toDeleteMap.set(key, {
                    id: key,
                    title: displayTitle,
                    source: role.source,
                });
            }
        } else if (role.source === 'careers-scraper') {
            // Keep existing scraped roles (will do smart diff)
            toKeep.push({
                id: key,
                title: displayTitle,
                source: role.source,
            });
        }
    }

    const toDelete = Array.from(toDeleteMap.values());

    const toAdd = (roleDrafts || []).map(draft => ({
        draftId: draft.id,
        title: (draft.scraped_data as ScrapedRole)?.title || 'Untitled',
    }));

    return { toKeep, toDelete, toAdd };
}

/**
 * Delete ALL Trackr roles for a firm
 * Called before adding new scraped roles to ensure clean transition
 */
async function deleteFirmTrackrRoles(firmId: string): Promise<void> {
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    console.log(`[approve] Deleting all Trackr roles for firm ${firmId}`);

    // We first find the program_roles to delete because Supabase delete with join constraints 
    // can be tricky.
    const { data: rolesToDelete } = await supabase
        .from('program_roles')
        .select('program_id, role_id, programs!inner(firm_id)')
        .eq('programs.firm_id', firmId)
        .eq('source', 'trackr');

    if (!rolesToDelete || rolesToDelete.length === 0) {
        console.log(`[approve] No Trackr roles found for firm ${firmId}`);
        return;
    }

    console.log(`[approve] Found ${rolesToDelete.length} Trackr roles to delete`);

    // Delete them by matching program_id and role_id
    // Or simpler: delete by program_id if we can iterate programs?
    // Let's use the composite delete approach or just loop if needed (safe for small numbers)
    // Actually, we can use the 'in' filter if we can identify them uniquely.
    // program_roles has no single ID column.

    // Best approach: Loop programs and delete trackr roles for each
    // Or: Delete where program_id IN (programs of firm) AND source = 'trackr'

    const { data: programs } = await supabase
        .from('programs')
        .select('id')
        .eq('firm_id', firmId);

    if (programs && programs.length > 0) {
        const programIds = programs.map(p => p.id);

        const { error } = await supabase
            .from('program_roles')
            .delete()
            .in('program_id', programIds)
            .eq('source', 'trackr');

        if (error) {
            console.error('Error deleting firm Trackr roles:', error);
            throw new Error('Failed to delete firm Trackr roles');
        }
    }

    console.log(`[approve] ✓ Deleted Trackr roles for firm`);
}

/**
 * Delete Trackr roles for a programme
 * Called before adding new scraped roles
 */
async function deleteTrackrRoles(programmeId: string): Promise<void> {
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    console.log(`[approve] Deleting Trackr roles for programme ${programmeId}`);

    const { error } = await supabase
        .from('program_roles')
        .delete()
        .eq('program_id', programmeId)
        .eq('source', 'trackr');

    if (error) {
        console.error('Error deleting Trackr roles:', error);
        throw new Error('Failed to delete Trackr roles');
    }

    console.log(`[approve] ✓ Deleted Trackr roles`);
}

/**
 * Approve a programme draft and all its associated role drafts
 *
 * This is the main approval function for the unified discoveries flow.
 * Implements source-based replacement logic:
 * - Deletes roles with source='trackr' (replaced by scraped data)
 * - Preserves roles with source='manual' (user-created)
 * - Smart diff for source='careers-scraper' (updates existing, adds new)
 */
export async function approveProgrammeWithRoles(programmeDraftId: string): Promise<{
    success: boolean;
    programmeId?: string;
    rolesCreated?: number;
    rolesDeleted?: number;
    error?: string;
}> {
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Step 1: Approve the programme draft
    const programmeResult = await approveProgrammeDraft(programmeDraftId);
    if (!programmeResult.success || !programmeResult.programmeId) {
        return { success: false, error: programmeResult.error };
    }

    const programmeId = programmeResult.programmeId;

    // Step 2: Delete Trackr roles (source-based replacement)
    let rolesDeleted = 0;
    try {
        // Get count before deletion
        const { count: trackrCount } = await supabase
            .from('program_roles')
            .select('*', { count: 'exact', head: true })
            .eq('program_id', programmeId)
            .eq('source', 'trackr');

        rolesDeleted = trackrCount || 0;

        if (rolesDeleted > 0) {
            await deleteTrackrRoles(programmeId);
            console.log(`[approve] Deleted ${rolesDeleted} Trackr roles`);
        }
    } catch (error) {
        console.error('Error during Trackr role deletion:', error);
        return {
            success: false,
            error: 'Failed to delete existing Trackr roles',
            programmeId,
        };
    }

    // Step 3: Fetch all role drafts linked to this programme draft
    const { data: roleDrafts, error: fetchError } = await supabase
        .from('role_discovery_drafts')
        .select('id')
        .eq('programme_discovery_draft_id', programmeDraftId)
        .eq('status', 'pending');

    if (fetchError) {
        console.error('Error fetching role drafts:', fetchError);
        return {
            success: false,
            error: 'Failed to fetch role drafts',
            programmeId,
        };
    }

    // Step 4: Approve all role drafts
    let rolesCreated = 0;
    for (const roleDraft of roleDrafts || []) {
        const roleResult = await approveRoleDraft(roleDraft.id, programmeId);
        if (roleResult.success) {
            rolesCreated++;
        } else {
            console.error(`Failed to approve role draft ${roleDraft.id}:`, roleResult.error);
        }
    }

    return {
        success: true,
        programmeId,
        rolesCreated,
        rolesDeleted,
    };
}

/**
 * Approve standalone role drafts (matched to existing programmes)
 */
export async function approveStandaloneRoles(
    roleDraftIds: string[],
    roleProgrammeMap?: Record<string, string> // Map of roleId -> programmeId/draftId
): Promise<{
    success: boolean;
    rolesCreated: number;
    errors: string[];
}> {
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    let rolesCreated = 0;
    const errors: string[] = [];

    // Cache for resolved programme IDs from drafts
    const draftResolutionCache = new Map<string, string>();
    // Track which firms we have cleaned up Trackr roles for
    const firmsCleaned = new Set<string>();

    for (const draftId of roleDraftIds) {
        // 1. Determine Target Programme ID
        let targetProgrammeId: string | null = null;
        let isDraftTarget = false;
        let firmId: string | null = null;

        // Check map first
        if (roleProgrammeMap && roleProgrammeMap[draftId]) {
            const mappedId = roleProgrammeMap[draftId];
            if (mappedId.startsWith('draft:')) {
                targetProgrammeId = mappedId.replace('draft:', '');
                isDraftTarget = true;
            } else {
                targetProgrammeId = mappedId;
                isDraftTarget = false;
            }

            // We still need to fetch the draft to get the firm_id for cleanup
            const { data: draft } = await supabase
                .from('role_discovery_drafts')
                .select('firm_id')
                .eq('id', draftId)
                .single();

            if (draft) firmId = draft.firm_id;
        } else {
            // Fallback to what's in the draft
            const { data: draft, error: fetchError } = await supabase
                .from('role_discovery_drafts')
                .select('program_id, programme_discovery_draft_id, firm_id')
                .eq('id', draftId)
                .single();

            if (fetchError || !draft) {
                errors.push(`Draft ${draftId}: Failed to fetch details`);
                continue;
            }

            firmId = draft.firm_id;

            if (draft.program_id) {
                targetProgrammeId = draft.program_id;
            } else if (draft.programme_discovery_draft_id) {
                targetProgrammeId = draft.programme_discovery_draft_id;
                isDraftTarget = true;
            }
        }

        // Clean up firm-wide Trackr roles if not done yet
        if (firmId && !firmsCleaned.has(firmId)) {
            try {
                await deleteFirmTrackrRoles(firmId);
                firmsCleaned.add(firmId);
            } catch (err) {
                console.error(`Failed to cleanup Trackr roles for firm ${firmId}:`, err);
            }
        }

        if (!targetProgrammeId) {
            errors.push(`Draft ${draftId}: No programme assigned`);
            continue;
        }

        // 2. Resolve Programme ID (if it's a draft)
        let realProgrammeId = targetProgrammeId;
        if (isDraftTarget) {
            // Check cache first
            if (draftResolutionCache.has(targetProgrammeId)) {
                realProgrammeId = draftResolutionCache.get(targetProgrammeId)!;
            } else {
                // Approve the programme draft to get a real programme ID
                // Check if it's already approved? approveProgrammeDraft handles idempotency via status check mostly,
                // but let's check if it exists as a draft first.

                // Note: approveProgrammeDraft returns success even if already approved (status check update).
                // BUT it creates a NEW programme every time if we are not careful.
                // We should check if this draft was already approved and has a linked programme?
                // The current implementation of approveProgrammeDraft ALWAYS creates a new programme.
                // This is dangerous if multiple roles point to same draft.

                // We must ensure we only approve a programme draft ONCE per batch.
                const result = await approveProgrammeDraft(targetProgrammeId);
                if (!result.success || !result.programmeId) {
                    errors.push(`Draft ${draftId}: Failed to approve linked programme draft ${targetProgrammeId}`);
                    continue;
                }

                realProgrammeId = result.programmeId;
                draftResolutionCache.set(targetProgrammeId, realProgrammeId);
            }
        }

        // 3. Approve the role
        const result = await approveRoleDraft(draftId, realProgrammeId);
        if (result.success) {
            rolesCreated++;
        } else {
            errors.push(`Draft ${draftId}: ${result.error}`);
        }
    }

    return {
        success: errors.length === 0,
        rolesCreated,
        errors,
    };
}

/**
 * Dismiss discovery drafts (mark as dismissed, don't create anything)
 */
export async function dismissDiscoveries(
    programmeDraftIds: string[],
    roleDraftIds: string[]
): Promise<{ success: boolean; error?: string }> {
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Dismiss programme drafts
    if (programmeDraftIds.length > 0) {
        const { error: programmeError } = await supabase
            .from('programme_discovery_drafts')
            .update({
                status: 'dismissed',
                reviewed_at: new Date().toISOString(),
            })
            .in('id', programmeDraftIds);

        if (programmeError) {
            console.error('Error dismissing programme drafts:', programmeError);
            return { success: false, error: 'Failed to dismiss programme drafts' };
        }
    }

    // Dismiss role drafts
    if (roleDraftIds.length > 0) {
        const { error: roleError } = await supabase
            .from('role_discovery_drafts')
            .update({
                status: 'dismissed',
                reviewed_at: new Date().toISOString(),
            })
            .in('id', roleDraftIds);

        if (roleError) {
            console.error('Error dismissing role drafts:', roleError);
            return { success: false, error: 'Failed to dismiss role drafts' };
        }
    }

    return { success: true };
}
