import { create } from 'zustand';
import { clamp01 } from '@/shared/lib/audioMath';
import {
    createAutomationItemMutation,
    deleteNearestAutomationItemMutation,
    lanesForTrack,
    moveAutomationItemMutation,
    stretchAutomationItemMutation,
} from './useAutomationStoreItems';

export type CurveType = 'linear' | 'bezier' | 'step';

export interface AutomationBreakpoint {
    id: string;
    beat: number;
    value: number;
    curve: CurveType;
    tension?: number;
    itemId?: string;
}

export interface AutomationLane {
    id: string;
    trackId: string;
    paramName: string;
    paramKey: string;
    color: string;
    visible: boolean;
    breakpoints: AutomationBreakpoint[];
}

interface AutomationState {
    lanes: Record<string, AutomationLane>;
    globalVisible: boolean;
    expandedTracks: Set<string>;
    selectedBreakpoints: Set<string>;
    toggleGlobalVisible: () => void;
    addLane: (trackId: string, paramName: string, paramKey: string, color?: string) => string;
    removeLane: (laneId: string) => void;
    toggleTrackAutomation: (trackId: string) => void;
    setTrackAutomationVisible: (trackId: string, visible: boolean) => void;
    hideAllAutomation: () => void;
    setLaneVisibility: (laneId: string, visible: boolean) => void;

    addBreakpoint: (laneId: string, beat: number, value: number, curve?: CurveType) => void;
    moveBreakpoint: (laneId: string, bpId: string, beat: number, value: number) => void;
    setBreakpointCurve: (laneId: string, bpId: string, curve: CurveType) => void;
    setBreakpointTension: (laneId: string, bpId: string, tension: number) => void;
    removeBreakpoint: (laneId: string, bpId: string) => void;
    selectBreakpoint: (bpId: string, additive?: boolean) => void;
    clearSelection: () => void;
    createAutomationItem: (laneId: string, startBeat: number, lengthBeats: number) => string | null;
    deleteNearestAutomationItem: (laneId: string, anchorBeat: number) => boolean;
    moveAutomationItem: (laneId: string, itemId: string, newStartBeat: number) => boolean;
    stretchAutomationItem: (laneId: string, itemId: string, newLengthBeats: number) => boolean;

    getLanesForTrack: (trackId: string) => AutomationLane[];
}

const genId = () => `auto_${crypto.randomUUID().slice(0, 8)}`;
const genBpId = () => `bp_${crypto.randomUUID().slice(0, 8)}`;

export const useAutomationStore = create<AutomationState>((set, get) => ({
    lanes: {},
    globalVisible: false,
    expandedTracks: new Set(),
    selectedBreakpoints: new Set(),

    toggleGlobalVisible: () => set((s) => ({ globalVisible: !s.globalVisible })),

    addLane: (trackId, paramName, paramKey, color = 'var(--token-color-hex-58a6ff)') => {
        // BUG-038 FIX: Prevent duplicate automation lanes for the same parameter on a track.
        const existing = Object.values(get().lanes).find(
            (l) => l.trackId === trackId && l.paramKey === paramKey,
        );
        if (existing) return existing.id;

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
            const trackLanes = Object.values(s.lanes).filter((lane) => lane.trackId === trackId);
            const hasVisibleLane = trackLanes.some((lane) => lane.visible);
            const makeVisible = !hasVisibleLane;
            const nextLanes = { ...s.lanes };
            for (const lane of trackLanes) {
                nextLanes[lane.id] = { ...lane, visible: makeVisible };
            }
            const nextExpanded = new Set(s.expandedTracks);
            if (makeVisible) nextExpanded.add(trackId);
            else nextExpanded.delete(trackId);
            return {
                lanes: nextLanes,
                expandedTracks: nextExpanded,
                globalVisible: makeVisible ? true : s.globalVisible,
            };
        });
    },

    setTrackAutomationVisible: (trackId, visible) => {
        set((s) => {
            const trackLanes = Object.values(s.lanes).filter((lane) => lane.trackId === trackId);
            if (trackLanes.length === 0) return s;
            const nextLanes = { ...s.lanes };
            for (const lane of trackLanes) {
                nextLanes[lane.id] = { ...lane, visible };
            }
            const nextExpanded = new Set(s.expandedTracks);
            if (visible) nextExpanded.add(trackId);
            else nextExpanded.delete(trackId);
            return {
                lanes: nextLanes,
                expandedTracks: nextExpanded,
                globalVisible: visible ? true : s.globalVisible,
            };
        });
    },

    hideAllAutomation: () => {
        set((s) => {
            const nextLanes: Record<string, AutomationLane> = {};
            for (const lane of Object.values(s.lanes)) {
                nextLanes[lane.id] = { ...lane, visible: false };
            }
            return {
                lanes: nextLanes,
                expandedTracks: new Set<string>(),
                globalVisible: false,
                selectedBreakpoints: new Set<string>(),
            };
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
                beat: Math.max(0, beat),
                value: clamp01(value),
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
                .map((bp) => (bp.id === bpId ? { ...bp, beat, value: clamp01(value) } : bp))
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

    createAutomationItem: (laneId, startBeat, lengthBeats) => {
        const lane = get().lanes[laneId];
        if (!lane) return null;
        const mutation = createAutomationItemMutation(lane, startBeat, lengthBeats);
        set((s) => ({
            lanes: {
                ...s.lanes,
                [laneId]: { ...s.lanes[laneId], breakpoints: mutation.breakpoints },
            },
        }));
        return mutation.itemId;
    },

    deleteNearestAutomationItem: (laneId, anchorBeat) => {
        const lane = get().lanes[laneId];
        if (!lane) return false;
        const mutation = deleteNearestAutomationItemMutation(lane, anchorBeat);
        if (!mutation.changed) return false;
        set((s) => ({
            lanes: {
                ...s.lanes,
                [laneId]: { ...s.lanes[laneId], breakpoints: mutation.breakpoints },
            },
        }));
        return true;
    },

    moveAutomationItem: (laneId, itemId, newStartBeat) => {
        const lane = get().lanes[laneId];
        if (!lane) return false;
        const mutation = moveAutomationItemMutation(lane, itemId, newStartBeat);
        if (!mutation.changed) return false;
        set((s) => ({
            lanes: {
                ...s.lanes,
                [laneId]: { ...s.lanes[laneId], breakpoints: mutation.breakpoints },
            },
        }));
        return true;
    },

    stretchAutomationItem: (laneId, itemId, newLengthBeats) => {
        const lane = get().lanes[laneId];
        if (!lane) return false;
        const mutation = stretchAutomationItemMutation(lane, itemId, newLengthBeats);
        if (!mutation.changed) return false;
        set((s) => ({
            lanes: {
                ...s.lanes,
                [laneId]: { ...s.lanes[laneId], breakpoints: mutation.breakpoints },
            },
        }));
        return true;
    },

    getLanesForTrack: (trackId) => lanesForTrack<AutomationLane>(get(), trackId),
}));
