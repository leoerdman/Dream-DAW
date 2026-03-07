import type * as engine from '@/shared/api/engine';
import type { PluginSandboxSnapshot, ProjectHistoryEvent } from '@/shared/api/engine';

export interface EntityState<T> {
    byId: Record<string, T>;
    allIds: string[];
}

export interface TrackStatePatch<T> {
    tracks: EntityState<T>;
}

export const PROJECT_HISTORY_WINDOW = 1024;
export const PROJECT_HISTORY_SYNC_EVERY_TICKS = 15; // telemetry is ~30fps
// PERF-OPT: Throttle meter store updates to every 2nd binary packet.
// At ~60fps backend rate this yields ~30fps store updates — still buttery
// smooth for VU meters (Ableton runs at 24fps VU, Logic at ~25fps).
// Saves 50% of meter allocation + rendering cost across all mixer components.
export const METER_STATE_UPDATE_EVERY_TICKS = 2;
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
    // BUG-036 FIX: Short-circuit if no instances match the requested IDs.
    const hasMatch = snapshot.instances.some((inst) => ids.has(inst.plugin_instance_id));
    if (!hasMatch) return snapshot;
    return {
        ...snapshot,
        instances: snapshot.instances.map((inst) =>
            ids.has(inst.plugin_instance_id) ? patch(inst) : inst,
        ),
    };
}

// BUG-033 FIX: Use for-loop instead of Object.fromEntries + double .map()
// for O(N) allocation instead of O(2N) intermediate array entries.
export function toEntityState<T extends { id: string }>(items: T[]): EntityState<T> {
    const byId: Record<string, T> = {};
    const allIds: string[] = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        byId[item.id] = item;
        allIds[i] = item.id;
    }
    return { byId, allIds };
}

// BUG-091 FIX: Single-pass loop avoids creating two intermediate arrays from .map().filter().
export function materializeByIds<T>(allIds: string[], byId: Record<string, T>): T[] {
    const result: T[] = [];
    for (let i = 0, len = allIds.length; i < len; i++) {
        const item = byId[allIds[i]];
        if (item) result.push(item);
    }
    return result;
}

export function buildTrackStatePatch<T>(
    allIds: string[],
    byId: Record<string, T>,
): TrackStatePatch<T> {
    return {
        tracks: { byId, allIds },
    };
}
