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
        // ENTERPRISE TYPE SAFETY: Use discriminated union narrowing instead of
        // `as Record<string, unknown>` cast. Each `d.kind` narrows `d.data` to
        // the correct typed branch of the ProjectDelta union.
        if (d.kind === 'ClipDuplicated') {
            ids.push(d.data.new_clip_id);
        } else if (d.kind === 'ClipAdded') {
            // BUG-018 FIX: Also capture ClipAdded for cross-project paste.
            ids.push(d.data.clip_id);
        }
    }
    // Fallback for legacy single-clip duplicate responses that don't emit ClipDuplicated deltas.
    if (ids.length === 0 && fallbackId) {
        ids.push(fallbackId);
    }
    return ids;
}
