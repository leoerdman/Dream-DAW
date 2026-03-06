// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Entity Selectors (O(1) store accessors)
// ═══════════════════════════════════════════════════════════════════════════
//
// Typed selector helpers for canonical normalized `tracks` / `clips` entities.
// Use these instead of `projectTracks.find(t => t.id === id)` to get O(1)
// lookups and avoid full-array iteration in hot paths.
//
// ═══════════════════════════════════════════════════════════════════════════

import { useEngineStore } from '@/shared/stores/useEngineStore';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';

// ── Track selectors ──────────────────────────────────────────────────────

// BUG-AUDIT-003 FIX: Cache selectAllTracks result to prevent .map() from
// creating a new array reference on every call, which defeats Zustand shallow equality.
// BUG-012 FIX: Content-hash comparison — if allIds has the same elements as
// the previous key, reuse the previous WeakMap key to avoid cache misses.
const _allTracksCache = new WeakMap<string[], (ProjectTrack | undefined)[]>();
let _prevAllIdsRef: string[] | null = null;
/** Select all tracks as an ordered array (cached by allIds reference). */
export const selectAllTracks = (s: ReturnType<typeof useEngineStore.getState>) => {
    let key = s.tracks.allIds;
    // BUG-012 FIX: If the new allIds has the same content as the previous one
    // (e.g., [...state.allIds] spread in delta handler), reuse the old reference
    // so the WeakMap cache hits and we don't create a new mapped array.
    if (_prevAllIdsRef && key !== _prevAllIdsRef && key.length === _prevAllIdsRef.length) {
        let same = true;
        for (let i = 0; i < key.length; i++) {
            if (key[i] !== _prevAllIdsRef[i]) { same = false; break; }
        }
        if (same) key = _prevAllIdsRef;
    }
    let cached = _allTracksCache.get(key);
    if (!cached) {
        cached = key.map(id => s.tracks.byId[id]);
        _allTracksCache.set(key, cached);
    }
    _prevAllIdsRef = key;
    return cached;
};

/** Select a single track by ID. Returns undefined if not found. */
export const selectTrackById = (id: string) =>
    (s: ReturnType<typeof useEngineStore.getState>): ProjectTrack | undefined =>
        s.tracks.byId[id];

/** Select a track by its array index. */
export const selectTrackByIndex = (index: number) =>
    (s: ReturnType<typeof useEngineStore.getState>): ProjectTrack | undefined =>
        s.tracks.byId[s.tracks.allIds[index]];

/** Get track count without subscribing to the full array. */
export const selectTrackCount = (s: ReturnType<typeof useEngineStore.getState>) =>
    s.tracks.allIds.length;

// ── Clip selectors ───────────────────────────────────────────────────────

/** Select all clips as an ordered array (same as timelineClips). */
export const selectAllClips = (s: ReturnType<typeof useEngineStore.getState>) => s.timelineClips;

/** Select a single clip by ID. Returns undefined if not found. */
export const selectClipById = (id: string) =>
    (s: ReturnType<typeof useEngineStore.getState>): TimelineClip | undefined =>
        s.clips.byId[id];

/** Memoized cache for track index clip lookups, bound to the timelineClips array reference. */
const _clipsByTrackCache = new WeakMap<TimelineClip[], Record<number, TimelineClip[]>>();

/** Get clips filtered by track index. */
export const selectClipsByTrackIndex = (trackIndex: number) =>
    (s: ReturnType<typeof useEngineStore.getState>): TimelineClip[] => {
        const clips = s.timelineClips;
        let cache = _clipsByTrackCache.get(clips);
        if (!cache) {
            cache = {};
            _clipsByTrackCache.set(clips, cache);
        }
        if (!cache[trackIndex]) {
            cache[trackIndex] = clips.filter((c) => c.trackIndex === trackIndex);
        }
        return cache[trackIndex];
    };

// ── Imperative helpers (for callbacks, not hooks) ────────────────────────

/** Get track by ID from store state (non-reactive, for use in callbacks). */
export function getTrackById(id: string): ProjectTrack | undefined {
    return useEngineStore.getState().tracks.byId[id];
}

/** Get clip by ID from store state (non-reactive, for use in callbacks). */
export function getClipById(id: string): TimelineClip | undefined {
    return useEngineStore.getState().clips.byId[id];
}

/** Get track index by track ID. Returns -1 if not found. */
export function getTrackIndexById(id: string): number {
    return useEngineStore.getState().tracks.allIds.indexOf(id);
}
