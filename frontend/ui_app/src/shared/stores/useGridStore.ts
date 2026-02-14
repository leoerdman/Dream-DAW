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
import * as engine from '@/shared/api/engine';
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

    /** Whether magnetic snap is enabled (magnet toggle). */
    snapEnabled: boolean;

    /** True = fixed grid, false = adaptive grid mode. */
    fixedMode: boolean;

    /** Persisted fixed-grid numerator (usually 1). */
    fixedNumerator: number;

    /** Persisted fixed-grid denominator (1,2,4,8,16,32...). */
    fixedDenominator: number;
}

export interface GridActions {
    /** Set the grid division. */
    setDivision: (d: GridDivision) => void;

    /** Toggle or set triplet mode. */
    setTriplet: (t: boolean) => void;

    /** Toggle or set magnetic snap on/off. */
    setSnapEnabled: (enabled: boolean) => void;

    /** Apply grid settings loaded from backend project (no write-back). */
    applyProjectGrid: (cfg: {
        numerator: number;
        denominator: number;
        ntoles: number;
        snapToGrid: boolean;
        fixed: boolean;
    }) => void;

    /** Cycle through divisions: 1/4 → 1/8 → 1/16 → 1/32 → OFF → 1/4. */
    cycleDivision: () => void;

    /**
     * Snap a beat value to the nearest grid line.
     *
     * @param rawBeat - Unsnapped beat position
     * @param beatsPerBar - Beats per bar (default 4 for 4/4)
     * @param ppb - Pixels per beat (required for ADAPTIVE division)
     * @returns Snapped beat (or rawBeat if division is OFF or snap disabled)
     */
    snapBeat: (rawBeat: number, beatsPerBar?: number, ppb?: number) => number;

    /**
     * Get the current grid interval in beats.
     *
     * @param beatsPerBar - Beats per bar (default 4)
     * @param ppb - Pixels per beat (required for ADAPTIVE division)
     * @returns Interval in beats (0 if OFF)
     */
    gridInterval: (beatsPerBar?: number, ppb?: number) => number;
}

export type GridStore = GridState & GridActions;

// ── Cycle Order ──────────────────────────────────────────────────────────

const CYCLE_ORDER: GridDivision[] = ['ADAPTIVE', '1/4', '1/8', '1/16', '1/32', '1/1', '1/2', 'OFF'];

// ── Store Implementation ─────────────────────────────────────────────────

export const useGridStore = create<GridStore>((set, get) => ({
    // ── State ──────────────────────────────────────────────────────────
    division: '1/1',
    triplet: false,
    snapEnabled: true,
    fixedMode: true,
    fixedNumerator: 1,
    fixedDenominator: 1,

    // ── Actions ────────────────────────────────────────────────────────

    setDivision: (d: GridDivision) => {
        const nextFixed = d !== 'ADAPTIVE';
        const nextNumerator = d === '1/1' ? 1 : 1;
        const nextDenominator = d === '1/1'
            ? 1
            : d === '1/2'
                ? 2
                : d === '1/4'
                    ? 4
                    : d === '1/8'
                        ? 8
                        : d === '1/16'
                            ? 16
                            : d === '1/32'
                                ? 32
                                : get().fixedDenominator;
        set({
            division: d,
            triplet: false,
            fixedMode: nextFixed,
            fixedNumerator: nextFixed ? nextNumerator : get().fixedNumerator,
            fixedDenominator: nextFixed ? nextDenominator : get().fixedDenominator,
        });
        const st = get();
        void engine
            .setArrangementGrid(
                Math.max(1, Math.round(st.fixedNumerator)),
                Math.max(1, Math.round(st.fixedDenominator)),
                st.triplet ? 3 : 2,
                st.snapEnabled,
                st.fixedMode,
            )
            .catch((err) => console.error('[GridStore] setArrangementGrid(setDivision) failed:', err));
    },

    setTriplet: (t: boolean) => {
        set({ triplet: t });
        const st = get();
        void engine
            .setArrangementGrid(
                Math.max(1, Math.round(st.fixedNumerator)),
                Math.max(1, Math.round(st.fixedDenominator)),
                st.triplet ? 3 : 2,
                st.snapEnabled,
                st.fixedMode,
            )
            .catch((err) => console.error('[GridStore] setArrangementGrid(setTriplet) failed:', err));
    },

    setSnapEnabled: (enabled: boolean) => {
        set({ snapEnabled: enabled });
        const st = get();
        void engine
            .setArrangementGrid(
                Math.max(1, Math.round(st.fixedNumerator)),
                Math.max(1, Math.round(st.fixedDenominator)),
                st.triplet ? 3 : 2,
                st.snapEnabled,
                st.fixedMode,
            )
            .catch((err) => console.error('[GridStore] setArrangementGrid(setSnapEnabled) failed:', err));
    },

    applyProjectGrid: (cfg) => {
        const numerator = Math.max(1, Math.round(cfg.numerator || 1));
        const denominator = Math.max(1, Math.round(cfg.denominator || 16));
        const ntoles = Math.max(1, Math.round(cfg.ntoles || 2));
        const fixed = Boolean(cfg.fixed);
        const division: GridDivision = !fixed
            ? 'ADAPTIVE'
            : denominator === 1
                ? '1/1'
                : denominator === 2
                    ? '1/2'
                    : denominator === 4
                        ? '1/4'
                        : denominator === 8
                            ? '1/8'
                            : denominator === 16
                                ? '1/16'
                                : denominator === 32
                                    ? '1/32'
                                    : '1/16';
        set({
            division,
            triplet: ntoles === 3,
            snapEnabled: Boolean(cfg.snapToGrid),
            fixedMode: fixed,
            fixedNumerator: numerator,
            fixedDenominator: denominator,
        });
    },

    cycleDivision: () => {
        const { division, triplet } = get();
        // If triplet is on, first turn it off and keep same division
        if (triplet) {
            get().setTriplet(false);
            return;
        }
        const idx = CYCLE_ORDER.indexOf(division);
        const next = CYCLE_ORDER[(idx + 1) % CYCLE_ORDER.length];
        get().setDivision(next);
    },

    snapBeat: (rawBeat: number, beatsPerBar: number = 4, ppb?: number) => {
        const { division, triplet, snapEnabled } = get();
        if (!snapEnabled) return Math.max(0, rawBeat);
        const interval = divisionToInterval(division, beatsPerBar, triplet, ppb);
        return snapToGrid(rawBeat, interval);
    },

    gridInterval: (beatsPerBar: number = 4, ppb?: number) => {
        const { division, triplet } = get();
        return divisionToInterval(division, beatsPerBar, triplet, ppb);
    },
}));
