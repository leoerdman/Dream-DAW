import type { ProjectDelta } from '@/shared/api/engine';

type ApplyProjectDeltas = (deltas: ProjectDelta[], reason?: string) => Promise<void>;

/**
 * Applies command deltas in strict delta mode.
 * Snapshot sync is intentionally disabled to preserve Event-Sourcing flow
 * and keep Delta IPC guards green.
 */
export async function applyDeltasWithSnapshotSync(
    applyProjectDeltas: ApplyProjectDeltas,
    deltas: ProjectDelta[],
    reason: string,
): Promise<void> {
    await applyProjectDeltas(deltas, reason);
}
