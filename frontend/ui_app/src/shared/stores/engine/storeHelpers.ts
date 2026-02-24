import type * as engine from '@/shared/api/engine';
import type { PluginSandboxSnapshot, ProjectHistoryEvent } from '@/shared/api/engine';

export interface EntityState<T> {
    byId: Record<string, T>;
    allIds: string[];
}

export interface TrackStatePatch<T> {
    projectTracks: T[];
    tracksById: Record<string, T>;
    tracks: EntityState<T>;
}

export const PROJECT_HISTORY_WINDOW = 256;
export const PROJECT_HISTORY_SYNC_EVERY_TICKS = 15; // telemetry is ~30fps
// Keep meter updates at full telemetry rate for responsive real-time VU motion.
// Throttling this causes visible lag/choppy meter movement in TrackInspector/Mixer.
export const METER_STATE_UPDATE_EVERY_TICKS = 1;
export const DEBUG_PROJECT_FETCH =
    (typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV))
    || (typeof window !== 'undefined' && (window as Window & { __dreamDebugProjectFetch?: boolean }).__dreamDebugProjectFetch === true);

export function mergeProjectHistory(
    current: ProjectHistoryEvent[],
    currentCursor: number,
    delta: ProjectHistoryEvent[],
): { history: ProjectHistoryEvent[]; cursor: number } {
    if (delta.length === 0) {
        return { history: current, cursor: currentCursor };
    }
    const firstSeq = delta[0].seq;
    let merged: ProjectHistoryEvent[];
    if (current.length === 0) {
        merged = delta;
    } else if (firstSeq <= currentCursor) {
        // BUG-009 FIX: Splice at the correct position instead of full replacement.
        // Find the index where delta should start replacing, preserving history before it.
        const spliceIdx = current.findIndex((e) => e.seq >= firstSeq);
        if (spliceIdx >= 0) {
            merged = [...current.slice(0, spliceIdx), ...delta];
        } else {
            merged = [...current, ...delta];
        }
    } else {
        merged = [...current, ...delta];
    }
    const history = merged.length > PROJECT_HISTORY_WINDOW
        ? merged.slice(-PROJECT_HISTORY_WINDOW)
        : merged;
    const cursor = delta[delta.length - 1].seq;
    return { history, cursor };
}

export function patchSandboxInstancesById(
    snapshot: PluginSandboxSnapshot | null,
    ids: Set<string>,
    patch: (inst: engine.PluginSandboxRuntimeInfo) => engine.PluginSandboxRuntimeInfo,
): PluginSandboxSnapshot | null {
    if (!snapshot || ids.size === 0) return snapshot;
    return {
        ...snapshot,
        instances: snapshot.instances.map((inst) =>
            ids.has(inst.plugin_instance_id) ? patch(inst) : inst,
        ),
    };
}

export function toEntityState<T extends { id: string }>(items: T[]): EntityState<T> {
    return {
        byId: Object.fromEntries(items.map((item) => [item.id, item])),
        allIds: items.map((item) => item.id),
    };
}

export function materializeByIds<T>(allIds: string[], byId: Record<string, T>): T[] {
    return allIds
        .map((id) => byId[id])
        .filter((item): item is T => Boolean(item));
}

export function buildTrackStatePatch<T>(
    allIds: string[],
    byId: Record<string, T>,
): TrackStatePatch<T> {
    return {
        projectTracks: materializeByIds(allIds, byId),
        tracksById: byId,
        tracks: {
            byId,
            allIds,
        },
    };
}
