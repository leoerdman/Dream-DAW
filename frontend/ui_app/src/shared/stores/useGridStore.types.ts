import type { GridDivision } from '@/shared/lib/gridSnap';

export interface GridState {
    division: GridDivision;
    triplet: boolean;
    snapEnabled: boolean;
    fixedMode: boolean;
    fixedNumerator: number;
    fixedDenominator: number;
    pianoPencilMode: boolean;
    pendingSync: {
        numerator: number;
        denominator: number;
        ntoles: number;
        snapToGrid: boolean;
        fixed: boolean;
        expiresAtMs: number;
    } | null;
}

export interface GridActions {
    setDivision: (d: GridDivision) => void;
    stepDivisionFiner: () => void;
    stepDivisionCoarser: () => void;
    setTriplet: (t: boolean) => void;
    setSnapEnabled: (enabled: boolean) => void;
    applyProjectGrid: (cfg: {
        numerator: number;
        denominator: number;
        ntoles: number;
        snapToGrid: boolean;
        fixed: boolean;
    }) => void;
    applyUiPreferences: (cfg: {
        division?: GridDivision;
        triplet?: boolean;
        snapEnabled?: boolean;
        pianoPencilMode?: boolean;
    }) => void;
    cycleDivision: () => void;
    snapBeat: (rawBeat: number, beatsPerBar?: number, ppb?: number) => number;
    gridInterval: (beatsPerBar?: number, ppb?: number) => number;
    setPianoPencilMode: (enabled: boolean) => void;
    togglePianoPencilMode: () => void;
}

export type GridStore = GridState & GridActions;
