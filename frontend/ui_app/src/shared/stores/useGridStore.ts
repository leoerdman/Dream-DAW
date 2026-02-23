import { create } from 'zustand';
import * as engine from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import {
    type GridDivision,
    divisionToInterval,
    snapToGrid,
} from '@/shared/lib/gridSnap';
import type { GridStore } from '@/shared/stores/useGridStore.types';
const CYCLE_ORDER: GridDivision[] = ['ADAPTIVE', '1/4', '1/8', '1/16', '1/32', '1/1', '1/2', 'OFF'];
const FIXED_DIVISION_ORDER: GridDivision[] = ['1/1', '1/2', '1/4', '1/8', '1/16', '1/32'];
function denominatorToDivision(denominator: number): GridDivision {
    if (denominator <= 1) return '1/1';
    if (denominator <= 2) return '1/2';
    if (denominator <= 4) return '1/4';
    if (denominator <= 8) return '1/8';
    if (denominator <= 16) return '1/16';
    return '1/32';
}
export const useGridStore = create<GridStore>((set, get) => ({
    // ── State ──────────────────────────────────────────────────────────
    division: '1/1',
    triplet: false,
    snapEnabled: true,
    fixedMode: true,
    fixedNumerator: 1,
    fixedDenominator: 1,
    pianoPencilMode: true,
    pendingSync: null,
    // ── Actions ────────────────────────────────────────────────────────
    setDivision: (d: GridDivision) => {
        const nextFixed = d !== 'ADAPTIVE';
        const nextNumerator = 1;
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
        const nextTriplet = false;
        const pending = {
            numerator: nextFixed ? nextNumerator : get().fixedNumerator,
            denominator: nextFixed ? nextDenominator : get().fixedDenominator,
            ntoles: nextTriplet ? 3 : 2,
            snapToGrid: get().snapEnabled,
            fixed: nextFixed,
            expiresAtMs: Date.now() + 1500,
        };
        set({
            division: d,
            triplet: nextTriplet,
            fixedMode: nextFixed,
            fixedNumerator: nextFixed ? nextNumerator : get().fixedNumerator,
            fixedDenominator: nextFixed ? nextDenominator : get().fixedDenominator,
            pendingSync: pending,
        });
        const st = get();
        void engine
            .setArrangementGridWithDeltas(
                Math.max(1, Math.round(st.fixedNumerator)),
                Math.max(1, Math.round(st.fixedDenominator)),
                st.triplet ? 3 : 2,
                st.snapEnabled,
                st.fixedMode,
            )
            .then((response) => useEngineStore.getState().applyProjectDeltas(response.deltas, 'grid:set-division'))
            .catch((err) => console.error('[GridStore] setArrangementGrid(setDivision) failed:', err));
    },
    stepDivisionFiner: () => {
        const st = get();
        const baseDivision = FIXED_DIVISION_ORDER.includes(st.division)
            ? st.division
            : denominatorToDivision(st.fixedDenominator);
        const currentIndex = FIXED_DIVISION_ORDER.indexOf(baseDivision);
        const safeIndex = currentIndex < 0 ? 0 : currentIndex;
        const nextIndex = Math.min(FIXED_DIVISION_ORDER.length - 1, safeIndex + 1);
        const nextDivision = FIXED_DIVISION_ORDER[nextIndex];
        get().setDivision(nextDivision);
    },
    stepDivisionCoarser: () => {
        const st = get();
        const baseDivision = FIXED_DIVISION_ORDER.includes(st.division)
            ? st.division
            : denominatorToDivision(st.fixedDenominator);
        const currentIndex = FIXED_DIVISION_ORDER.indexOf(baseDivision);
        const safeIndex = currentIndex < 0 ? 0 : currentIndex;
        const nextIndex = Math.max(0, safeIndex - 1);
        const nextDivision = FIXED_DIVISION_ORDER[nextIndex];
        get().setDivision(nextDivision);
    },
    setTriplet: (t: boolean) => {
        const stBefore = get();
        set({
            triplet: t,
            pendingSync: {
                numerator: Math.max(1, Math.round(stBefore.fixedNumerator)),
                denominator: Math.max(1, Math.round(stBefore.fixedDenominator)),
                ntoles: t ? 3 : 2,
                snapToGrid: stBefore.snapEnabled,
                fixed: stBefore.fixedMode,
                expiresAtMs: Date.now() + 1500,
            },
        });
        const st = get();
        void engine
            .setArrangementGridWithDeltas(
                Math.max(1, Math.round(st.fixedNumerator)),
                Math.max(1, Math.round(st.fixedDenominator)),
                st.triplet ? 3 : 2,
                st.snapEnabled,
                st.fixedMode,
            )
            .then((response) => useEngineStore.getState().applyProjectDeltas(response.deltas, 'grid:set-triplet'))
            .catch((err) => console.error('[GridStore] setArrangementGrid(setTriplet) failed:', err));
    },
    setSnapEnabled: (enabled: boolean) => {
        const stBefore = get();
        set({
            snapEnabled: enabled,
            pendingSync: {
                numerator: Math.max(1, Math.round(stBefore.fixedNumerator)),
                denominator: Math.max(1, Math.round(stBefore.fixedDenominator)),
                ntoles: stBefore.triplet ? 3 : 2,
                snapToGrid: enabled,
                fixed: stBefore.fixedMode,
                expiresAtMs: Date.now() + 1500,
            },
        });
        const st = get();
        void engine
            .setArrangementGridWithDeltas(
                Math.max(1, Math.round(st.fixedNumerator)),
                Math.max(1, Math.round(st.fixedDenominator)),
                st.triplet ? 3 : 2,
                st.snapEnabled,
                st.fixedMode,
            )
            .then((response) => useEngineStore.getState().applyProjectDeltas(response.deltas, 'grid:set-snap-enabled'))
            .catch((err) => console.error('[GridStore] setArrangementGrid(setSnapEnabled) failed:', err));
    },
    applyProjectGrid: (cfg) => {
        const numerator = Math.max(1, Math.round(cfg.numerator || 1));
        const denominator = Math.max(1, Math.round(cfg.denominator || 16));
        const ntoles = Math.max(1, Math.round(cfg.ntoles || 2));
        const fixed = Boolean(cfg.fixed);
        const snapToGrid = Boolean(cfg.snapToGrid);
        const pending = get().pendingSync;
        if (pending) {
            const now = Date.now();
            const matchesPending = pending.numerator === numerator
                && pending.denominator === denominator
                && pending.ntoles === ntoles
                && pending.snapToGrid === snapToGrid
                && pending.fixed === fixed;
            if (!matchesPending && now < pending.expiresAtMs) {
                return;
            }
        }
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
            snapEnabled: snapToGrid,
            fixedMode: fixed,
            fixedNumerator: numerator,
            fixedDenominator: denominator,
            pendingSync: null,
        });
    },
    applyUiPreferences: (cfg) => {
        const nextDivision = cfg.division ?? get().division;
        const nextTriplet = cfg.triplet ?? get().triplet;
        const nextSnapEnabled = cfg.snapEnabled ?? get().snapEnabled;
        const nextPianoPencilMode = cfg.pianoPencilMode ?? get().pianoPencilMode;
        const nextFixed = nextDivision !== 'ADAPTIVE';
        const nextNumerator = 1;
        const nextDenominator = nextDivision === '1/1'
            ? 1
            : nextDivision === '1/2'
                ? 2
                : nextDivision === '1/4'
                    ? 4
                    : nextDivision === '1/8'
                        ? 8
                        : nextDivision === '1/16'
                            ? 16
                            : nextDivision === '1/32'
                                ? 32
                                : get().fixedDenominator;
        set({
            division: nextDivision,
            triplet: Boolean(nextTriplet),
            snapEnabled: Boolean(nextSnapEnabled),
            fixedMode: nextFixed,
            fixedNumerator: nextFixed ? nextNumerator : get().fixedNumerator,
            fixedDenominator: nextFixed ? nextDenominator : get().fixedDenominator,
            pianoPencilMode: Boolean(nextPianoPencilMode),
            pendingSync: null,
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
        const interval = Math.max(0.001, divisionToInterval(division, beatsPerBar, triplet, ppb));
        return snapToGrid(rawBeat, interval);
    },
    gridInterval: (beatsPerBar: number = 4, ppb?: number) => {
        const { division, triplet } = get();
        return divisionToInterval(division, beatsPerBar, triplet, ppb);
    },
    setPianoPencilMode: (enabled: boolean) => {
        set({ pianoPencilMode: enabled });
    },
    togglePianoPencilMode: () => {
        const now = get().pianoPencilMode;
        set({ pianoPencilMode: !now });
    },
}));
