import type { ProjectDelta } from '@/shared/api/engine';

/**
 * ENTERPRISE: Single Source of Truth for extracting new clip IDs from
 * ClipDuplicated and ClipAdded deltas. Replaces 6+ duplicated `(d: any) => ...`
 * patterns scattered across shortcut handlers and drag handlers.
 *
 * @param deltas — Array of project deltas from a duplication/paste response
 * @param fallbackId — Optional fallback ID (from `response.new_id`) for legacy single-clip responses
 * @returns Array of newly created clip IDs
 */
export function extractNewClipIdsFromDeltas(
    deltas: ProjectDelta[],
    fallbackId?: string | null,
): string[] {
    const ids: string[] = [];
    for (const d of deltas) {
        if (typeof d.data === 'object' && d.data !== null) {
            const data = d.data as Record<string, unknown>;
            if (d.kind === 'ClipDuplicated' && typeof data.new_clip_id === 'string') {
                ids.push(data.new_clip_id);
            } else if (d.kind === 'ClipAdded' && typeof data.clip_id === 'string') {
                // BUG-018 FIX: Also capture ClipAdded for cross-project paste.
                ids.push(data.clip_id);
            }
        }
    }
    // Fallback for legacy single-clip duplicate responses that don't emit ClipDuplicated deltas.
    if (ids.length === 0 && fallbackId) {
        ids.push(fallbackId);
    }
    return ids;
}
