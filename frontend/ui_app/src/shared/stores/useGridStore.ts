import { create } from 'zustand';
import * as engine from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { DEFAULT_TIME_SIG_NUMERATOR } from '@/shared/lib/audioMath';
import {
    type GridDivision,
    divisionToInterval,
    divisionToDenominator,
    denominatorToGridDivision,
    snapToGrid,
} from '@/shared/lib/gridSnap';
import type { GridStore } from '@/shared/stores/useGridStore.types';
// BUG-061: Added '1/64' for detailed MIDI editing.
const CYCLE_ORDER: GridDivision[] = ['ADAPTIVE', '1/4', '1/8', '1/16', '1/32', '1/64', '1/128', '1/1', '1/2', 'OFF'];
const FIXED_DIVISION_ORDER: GridDivision[] = ['1/1', '1/2', '1/4', '1/8', '1/16', '1/32', '1/64', '1/128'];
// BUG-L01-L05 SSOT: Local denominatorToDivision removed — now uses
// denominatorToGridDivision() imported from '@/shared/lib/gridSnap'.
// This was one of 5 duplicate mapping implementations.
export const useGridStore = create<GridStore>((set, get) => {
    // ── SSOT: Single grid→engine sync helper ────────────────────────────
    // Replaces 3 identical IPC call patterns in setDivision, setTriplet, setSnapEnabled.
    const syncGridToEngine = (reason: string): void => {
        const st = get();
        void engine
            .setArrangementGridWithDeltas(
                Math.max(1, Math.round(st.fixedNumerator)),
                Math.max(1, Math.round(st.fixedDenominator)),
                st.triplet ? 3 : 1,
                st.snapEnabled,
                st.fixedMode,
            )
            .then((response) => useEngineStore.getState().applyProjectDeltas(response.deltas, reason))
            .catch((err: unknown) => {
                set({ pendingSync: null });
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`[GridStore] setArrangementGrid(${reason}) failed:`, err);
                useStatusStore.getState().setError(`Grid sync failed: ${msg}`);
            });
    };

    return ({
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
            // BUG-L01-L05 SSOT: Use imported divisionToDenominator() from gridSnap.ts.
            const nextDenominator = divisionToDenominator(d, get().fixedDenominator);
            const nextTriplet = false;
            const pending = {
                numerator: nextFixed ? nextNumerator : get().fixedNumerator,
                denominator: nextFixed ? nextDenominator : get().fixedDenominator,
                // BUG-038 FIX: ntoles=1 means normal, ntoles=3 means triplet.
                // Was ntoles=2 (duplet) when triplets off, which is wrong.
                ntoles: nextTriplet ? 3 : 1,
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
            syncGridToEngine('grid:set-division');
        },
        stepDivisionFiner: () => {
            const st = get();
            const baseDivision = FIXED_DIVISION_ORDER.includes(st.division)
                ? st.division
                : denominatorToGridDivision(st.fixedDenominator);
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
                : denominatorToGridDivision(st.fixedDenominator);
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
                    ntoles: t ? 3 : 1,
                    snapToGrid: stBefore.snapEnabled,
                    fixed: stBefore.fixedMode,
                    expiresAtMs: Date.now() + 1500,
                },
            });
            syncGridToEngine('grid:set-triplet');
        },
        setSnapEnabled: (enabled: boolean) => {
            const stBefore = get();
            set({
                snapEnabled: enabled,
                pendingSync: {
                    numerator: Math.max(1, Math.round(stBefore.fixedNumerator)),
                    denominator: Math.max(1, Math.round(stBefore.fixedDenominator)),
                    ntoles: stBefore.triplet ? 3 : 1,
                    snapToGrid: enabled,
                    fixed: stBefore.fixedMode,
                    expiresAtMs: Date.now() + 1500,
                },
            });
            syncGridToEngine('grid:set-snap-enabled');
        },
        applyProjectGrid: (cfg) => {
            const numerator = Math.max(1, Math.round(cfg.numerator || 1));
            const denominator = Math.max(1, Math.round(cfg.denominator || 16));
            const ntoles = Math.max(1, Math.round(cfg.ntoles || 1));
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
            // BUG-C04 FIX: Use denominatorToDivision() — single source of truth.
            // Previously an 8-level nested ternary with wrong '1/16' fallback.
            const division: GridDivision = !fixed ? 'ADAPTIVE' : denominatorToGridDivision(denominator);
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
            // BUG-L01-L05 SSOT: Use imported divisionToDenominator() from gridSnap.ts.
            const nextDenominator = divisionToDenominator(nextDivision, get().fixedDenominator);
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
        // BUG-031: Derive default beatsPerBar from engine store instead of hardcoded 4,
        // so non-4/4 time signatures snap correctly even when caller omits the argument.
        snapBeat: (rawBeat: number, beatsPerBar?: number, ppb?: number) => {
            const { division, triplet, snapEnabled } = get();
            if (!snapEnabled) return Math.max(0, rawBeat);
            const effectiveBeatsPerBar = beatsPerBar ?? useEngineStore.getState().transport.time_sig_numerator ?? DEFAULT_TIME_SIG_NUMERATOR;
            const interval = Math.max(0.001, divisionToInterval(division, effectiveBeatsPerBar, triplet, ppb));
            return snapToGrid(rawBeat, interval);
        },
        gridInterval: (beatsPerBar?: number, ppb?: number) => {
            const { division, triplet } = get();
            const effectiveBeatsPerBar = beatsPerBar ?? useEngineStore.getState().transport.time_sig_numerator ?? DEFAULT_TIME_SIG_NUMERATOR;
            return divisionToInterval(division, effectiveBeatsPerBar, triplet, ppb);
        },
        setPianoPencilMode: (enabled: boolean) => {
            set({ pianoPencilMode: enabled });
        },
        togglePianoPencilMode: () => {
            const now = get().pianoPencilMode;
            set({ pianoPencilMode: !now });
        },
    });
});
