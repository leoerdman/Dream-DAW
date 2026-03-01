import { create } from 'zustand';

export interface TimelineRegionBox {
    startBeat: number;
    endBeat: number;
    startTrack: number;
    endTrack: number;
}

interface RegionEditState {
    regionA: TimelineRegionBox | null;
    regionB: TimelineRegionBox | null;
    setRegionA: (region: TimelineRegionBox | null) => void;
    setRegionB: (region: TimelineRegionBox | null) => void;
    clear: () => void;
}

const validateRegion = (r: TimelineRegionBox | null) => {
    if (!r) return null;
    return {
        startBeat: Math.min(r.startBeat, r.endBeat),
        endBeat: Math.max(r.startBeat, r.endBeat),
        startTrack: Math.min(r.startTrack, r.endTrack),
        endTrack: Math.max(r.startTrack, r.endTrack),
    };
};

export const useRegionEditStore = create<RegionEditState>((set) => ({
    regionA: null,
    regionB: null,
    setRegionA: (region) => set({ regionA: validateRegion(region) }),
    setRegionB: (region) => set({ regionB: validateRegion(region) }),
    clear: () => set({ regionA: null, regionB: null }),
}));
