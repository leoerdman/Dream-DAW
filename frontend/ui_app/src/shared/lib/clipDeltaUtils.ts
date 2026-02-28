import type { ProjectDelta } from '@/shared/api/engine';

/**
 * ENTERPRISE: Single Source of Truth for extracting new clip IDs from
 * ClipDuplicated deltas. Replaces 6 duplicated `(d: any) => d.kind === 'ClipDuplicated'`
 * patterns scattered across shortcut handlers and drag handlers.
 *
 * @param deltas — Array of project deltas from a duplication response
 * @param fallbackId — Optional fallback ID (from `response.new_id`) for legacy single-clip responses
 * @returns Array of newly created clip IDs
 */
export function extractNewClipIdsFromDeltas(
    deltas: ProjectDelta[],
    fallbackId?: string | null,
): string[] {
    const ids: string[] = [];
    for (const d of deltas) {
        if (
            d.kind === 'ClipDuplicated'
            && typeof d.data === 'object'
            && d.data !== null
            && typeof (d.data as Record<string, unknown>).new_clip_id === 'string'
        ) {
            ids.push((d.data as Record<string, unknown>).new_clip_id as string);
        }
    }
    // Fallback for legacy single-clip duplicate responses that don't emit ClipDuplicated deltas.
    if (ids.length === 0 && fallbackId) {
        ids.push(fallbackId);
    }
    return ids;
}
