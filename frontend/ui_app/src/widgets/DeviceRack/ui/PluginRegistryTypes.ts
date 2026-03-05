// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Plugin Registry Types
// Pure TypeScript types — zero runtime, zero React imports
// ═══════════════════════════════════════════════════════════════════════════

import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import type { ModulationWaveShape, SaturationCurveType } from '@/widgets/DeviceRack/ui/PluginModules';

// ── Visualization types ──────────────────────────────────────────────────

export type VizType =
    | 'modulationWave'
    | 'saturationCurve'
    | 'miniFilterEq'
    | 'gainReductionMeter'
    | 'compressionCurve'
    | 'spectrumBars'
    | 'waveformDisplay'
    | 'none';

export interface VizConfig {
    type: VizType;
    waveShape?: ModulationWaveShape;
    satType?: SaturationCurveType;
    waveMode?: 'bars' | 'line';
    compVariant?: 'standard' | 'glue' | 'multiband';
    barCount?: number;
    staticDataGenerator?: (device: DeviceSlot) => number[];
    depthParam?: string | string[];
    depthFallback?: number;
    depthMax?: number;
    rateParam?: string | string[];
    rateFallback?: number;
    rateMax?: number;
    driveParam?: string | string[];
    driveFallback?: number;
    driveMax?: number;
    hpParam?: string | string[];
    hpFallback?: number;
    lpParam?: string | string[];
    lpFallback?: number;
    thrParam?: string | string[];
    thrFallback?: number;
    ratioParam?: string | string[];
    ratioFallback?: number;
    grOrientation?: 'vertical' | 'horizontal';
}

// ── Meta readout descriptors ─────────────────────────────────────────────

export interface MetaParamDescriptor {
    label: string;
    paramNames: string | string[];
    fallback: number;
    suffix: string;
}

// ── Settings panel config ────────────────────────────────────────────────

export interface SettingsPanelConfig {
    /** Which param names to show in the settings panel (allowlisted extras). */
    params: string[];
    /** Max columns for the settings knob grid. Default: 3 */
    maxCols?: number;
    /**
     * Human-readable labels for discrete/enum params.
     * Keys: param name, Values: ordered array of labels for each integer index.
     * e.g. { 'mode': ['Analog', 'Tape', 'Tube', 'Diode', 'Sinefold'] }
     * When present, the settings panel should render a dropdown instead of a knob.
     */
    enumLabels?: Record<string, string[]>;
    /**
     * Params that should render as toggle switches (on/off) instead of continuous knobs.
     * e.g. ['cab sim', 'soft clip']
     */
    toggleParams?: string[];
}

// ── Button config ────────────────────────────────────────────────────────

export interface ButtonConfig {
    label: string;
    paramName: string;
    threshold?: number;
    scene?: 'center' | 'mono' | 'wide' | 'sync';
}

// ── Full plugin definition ───────────────────────────────────────────────

export interface PluginDefinition {
    background: string;
    accent: string;
    dryWetAccent?: string;
    viz: VizConfig;
    meta: MetaParamDescriptor[];
    isUtility?: boolean;
    buttons?: ButtonConfig[];
    /** Secondary settings panel for overflow params. */
    settingsPanel?: SettingsPanelConfig;
}
