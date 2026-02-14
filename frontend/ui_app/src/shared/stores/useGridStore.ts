// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Grid Store (Magnetic Snap & Quantization)
// ═══════════════════════════════════════════════════════════════════════════
//
// Global Zustand store managing the timeline's snap/quantize settings.
//
// Consumed by:
//   - TransportBar (quantize selector)
//   - Timeline (clip drag, drop, split, double-click)
//   - DawShell (browser→timeline drag drop)
//
// All snap math is delegated to pure functions in `gridSnap.ts`.
//
// ═══════════════════════════════════════════════════════════════════════════

import { create } from 'zustand';
import {
    type GridDivision,
    divisionToInterval,
    snapToGrid,
} from '@/shared/lib/gridSnap';

// ── Store Interface ──────────────────────────────────────────────────────

export interface GridState {
    /** Current grid division (1/4, 1/8, 1/16, etc.). Default: 1/4. */
    division: GridDivision;

    /** Triplet mode — multiplies interval by 2/3. */
    triplet: boolean;
}

export interface GridActions {
    /** Set the grid division. */
    setDivision: (d: GridDivision) => void;

    /** Toggle or set triplet mode. */
    setTriplet: (t: boolean) => void;

    /** Cycle through divisions: 1/4 → 1/8 → 1/16 → 1/32 → OFF → 1/4. */
    cycleDivision: () => void;

    /**
     * Snap a beat value to the nearest grid line.
     *
     * @param rawBeat - Unsnapped beat position
     * @param beatsPerBar - Beats per bar (default 4 for 4/4)
     * @returns Snapped beat (or rawBeat if division is OFF)
     */
    snapBeat: (rawBeat: number, beatsPerBar?: number) => number;

    /**
     * Get the current grid interval in beats.
     *
     * @param beatsPerBar - Beats per bar (default 4)
     * @returns Interval in beats (0 if OFF)
     */
    gridInterval: (beatsPerBar?: number) => number;
}

export type GridStore = GridState & GridActions;

// ── Cycle Order ──────────────────────────────────────────────────────────

const CYCLE_ORDER: GridDivision[] = ['1/4', '1/8', '1/16', '1/32', '1/1', '1/2', 'OFF'];

// ── Store Implementation ─────────────────────────────────────────────────

export const useGridStore = create<GridStore>((set, get) => ({
    // ── State ──────────────────────────────────────────────────────────
    division: '1/1',
    triplet: false,

    // ── Actions ────────────────────────────────────────────────────────

    setDivision: (d: GridDivision) => set({ division: d, triplet: false }),

    setTriplet: (t: boolean) => set({ triplet: t }),

    cycleDivision: () => {
        const { division, triplet } = get();
        // If triplet is on, first turn it off and keep same division
        if (triplet) {
            set({ triplet: false });
            return;
        }
        const idx = CYCLE_ORDER.indexOf(division);
        const next = CYCLE_ORDER[(idx + 1) % CYCLE_ORDER.length];
        set({ division: next, triplet: false });
    },

    snapBeat: (rawBeat: number, beatsPerBar: number = 4) => {
        const { division, triplet } = get();
        const interval = divisionToInterval(division, beatsPerBar, triplet);
        return snapToGrid(rawBeat, interval);
    },

    gridInterval: (beatsPerBar: number = 4) => {
        const { division, triplet } = get();
        return divisionToInterval(division, beatsPerBar, triplet);
    },
}));
