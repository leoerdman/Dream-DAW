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

export const useRegionEditStore = create<RegionEditState>((set) => ({
    regionA: null,
    regionB: null,
    setRegionA: (region) => set({ regionA: region }),
    setRegionB: (region) => set({ regionB: region }),
    clear: () => set({ regionA: null, regionB: null }),
}));
