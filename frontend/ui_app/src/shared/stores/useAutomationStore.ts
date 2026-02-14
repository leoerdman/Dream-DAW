// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Automation Store (Zustand)
// ═══════════════════════════════════════════════════════════════════════════
//
// Manages automation lane data for all tracks. Each track can have
// multiple automation parameters (volume, pan, send levels, plugin params).
// Breakpoints are stored as {beat, value, curveType} tuples.
//
// This is a UI-only store — automation playback is handled by the engine.
// Changes are serialized into the project file on save.
//
// ═══════════════════════════════════════════════════════════════════════════

import { create } from 'zustand';

// ── Types ────────────────────────────────────────────────────────────────

/** Curve type between two breakpoints. */
export type CurveType = 'linear' | 'bezier' | 'step';

/** A single automation breakpoint on the timeline. */
export interface AutomationBreakpoint {
    /** Unique ID for React keys and selection. */
    id: string;
    /** Position in beats (horizontal). */
    beat: number;
    /** Normalized value 0..1 (vertical). */
    value: number;
    /** Curve type TO THE NEXT breakpoint. */
    curve: CurveType;
    /** Bézier tension TO THE NEXT breakpoint (0..1). */
    tension?: number;
}

/** An automation lane for a single parameter on a single track. */
export interface AutomationLane {
    /** Unique lane ID. */
    id: string;
    /** Track this lane belongs to. */
    trackId: string;
    /** Human-readable parameter name (e.g. "Volume", "Pan"). */
    paramName: string;
    /** Parameter key for engine mapping. */
    paramKey: string;
    /** Color for the lane line and fill. */
    color: string;
    /** Whether this lane is visible in the timeline. */
    visible: boolean;
    /** Ordered breakpoints (sorted by beat). */
    breakpoints: AutomationBreakpoint[];
}

// ── Store ────────────────────────────────────────────────────────────────

interface AutomationState {
    /** All automation lanes, keyed by lane ID. */
    lanes: Record<string, AutomationLane>;

    /** Global toggle — shows/hides ALL automation lanes at once. */
    globalVisible: boolean;

    /** Which tracks have automation expanded in UI. */
    expandedTracks: Set<string>;

    /** Currently selected breakpoint IDs. */
    selectedBreakpoints: Set<string>;

    // ── Actions ──
    toggleGlobalVisible: () => void;
    addLane: (trackId: string, paramName: string, paramKey: string, color?: string) => string;
    removeLane: (laneId: string) => void;
    toggleTrackAutomation: (trackId: string) => void;
    setLaneVisibility: (laneId: string, visible: boolean) => void;

    addBreakpoint: (laneId: string, beat: number, value: number, curve?: CurveType) => void;
    moveBreakpoint: (laneId: string, bpId: string, beat: number, value: number) => void;
    setBreakpointCurve: (laneId: string, bpId: string, curve: CurveType) => void;
    setBreakpointTension: (laneId: string, bpId: string, tension: number) => void;
    removeBreakpoint: (laneId: string, bpId: string) => void;
    selectBreakpoint: (bpId: string, additive?: boolean) => void;
    clearSelection: () => void;

    getLanesForTrack: (trackId: string) => AutomationLane[];
}

let nextId = 1;
const genId = () => `auto_${nextId++}`;
const genBpId = () => `bp_${nextId++}`;

export const useAutomationStore = create<AutomationState>((set, get) => ({
    lanes: {},
    globalVisible: false,
    expandedTracks: new Set(),
    selectedBreakpoints: new Set(),

    toggleGlobalVisible: () => set((s) => ({ globalVisible: !s.globalVisible })),

    addLane: (trackId, paramName, paramKey, color = '#58a6ff') => {
        const id = genId();
        const lane: AutomationLane = {
            id,
            trackId,
            paramName,
            paramKey,
            color,
            visible: true,
            breakpoints: [],
        };
        set((s) => ({ lanes: { ...s.lanes, [id]: lane } }));
        return id;
    },

    removeLane: (laneId) => {
        set((s) => {
            const rest = { ...s.lanes };
            delete rest[laneId];
            return { lanes: rest };
        });
    },

    toggleTrackAutomation: (trackId) => {
        set((s) => {
            const next = new Set(s.expandedTracks);
            if (next.has(trackId)) next.delete(trackId);
            else next.add(trackId);
            return { expandedTracks: next };
        });
    },

    setLaneVisibility: (laneId, visible) => {
        set((s) => {
            const lane = s.lanes[laneId];
            if (!lane) return s;
            return { lanes: { ...s.lanes, [laneId]: { ...lane, visible } } };
        });
    },

    addBreakpoint: (laneId, beat, value, curve = 'linear') => {
        set((s) => {
            const lane = s.lanes[laneId];
            if (!lane) return s;
            const bp: AutomationBreakpoint = {
                id: genBpId(),
                beat,
                value,
                curve,
                tension: curve === 'bezier' ? 0.5 : undefined,
            };
            const bps = [...lane.breakpoints, bp].sort((a, b) => a.beat - b.beat);
            return { lanes: { ...s.lanes, [laneId]: { ...lane, breakpoints: bps } } };
        });
    },

    moveBreakpoint: (laneId, bpId, beat, value) => {
        set((s) => {
            const lane = s.lanes[laneId];
            if (!lane) return s;
            const bps = lane.breakpoints
                .map((bp) => (bp.id === bpId ? { ...bp, beat, value: Math.max(0, Math.min(1, value)) } : bp))
                .sort((a, b) => a.beat - b.beat);
            return { lanes: { ...s.lanes, [laneId]: { ...lane, breakpoints: bps } } };
        });
    },

    setBreakpointCurve: (laneId, bpId, curve) => {
        set((s) => {
            const lane = s.lanes[laneId];
            if (!lane) return s;
            const bps = lane.breakpoints.map((bp) =>
                bp.id === bpId
                    ? {
                        ...bp,
                        curve,
                        tension: curve === 'bezier' ? (bp.tension ?? 0.5) : undefined,
                    }
                    : bp,
            );
            return { lanes: { ...s.lanes, [laneId]: { ...lane, breakpoints: bps } } };
        });
    },

    setBreakpointTension: (laneId, bpId, tension) => {
        set((s) => {
            const lane = s.lanes[laneId];
            if (!lane) return s;
            const nextTension = Math.max(0.05, Math.min(0.95, tension));
            const bps = lane.breakpoints.map((bp) =>
                bp.id === bpId ? { ...bp, curve: 'bezier' as const, tension: nextTension } : bp,
            );
            return { lanes: { ...s.lanes, [laneId]: { ...lane, breakpoints: bps } } };
        });
    },

    removeBreakpoint: (laneId, bpId) => {
        set((s) => {
            const lane = s.lanes[laneId];
            if (!lane) return s;
            const bps = lane.breakpoints.filter((bp) => bp.id !== bpId);
            return { lanes: { ...s.lanes, [laneId]: { ...lane, breakpoints: bps } } };
        });
    },

    selectBreakpoint: (bpId, additive = false) => {
        set((s) => {
            const next = additive ? new Set(s.selectedBreakpoints) : new Set<string>();
            if (next.has(bpId)) next.delete(bpId);
            else next.add(bpId);
            return { selectedBreakpoints: next };
        });
    },

    clearSelection: () => set({ selectedBreakpoints: new Set() }),

    getLanesForTrack: (trackId) => {
        return Object.values(get().lanes).filter((l) => l.trackId === trackId);
    },
}));
