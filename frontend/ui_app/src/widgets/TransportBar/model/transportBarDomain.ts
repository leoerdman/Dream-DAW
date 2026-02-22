import type * as engineApi from '@/shared/api/engine';

export const PDC_PANEL_POS_KEY = 'dream_daw.pdc_panel_pos.v1';
export const DEFAULT_PDC_PANEL_POS = { right: 10, top: 44 };

export const KEY_TONICS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as const;
export const KEY_MODES = ['Major', 'Minor', 'Dorian', 'Mixolydian', 'Phrygian', 'Lydian'] as const;
export const TIME_SIGNATURES: ReadonlyArray<[number, number]> = [[4, 4], [3, 4], [6, 8], [5, 4]];

export interface TransportPosition {
    bar: number;
    beat: number;
    sub: number;
}

export function computeTransportPosition(posBeats: number, timeSigNum: number): TransportPosition {
    const bar = Math.floor(posBeats / timeSigNum) + 1;
    const beat = Math.floor(posBeats % timeSigNum) + 1;
    const sub = Math.floor((posBeats % 1) * 96);
    return { bar, beat, sub };
}

export function resolveKeyTonicIndex(tonic: string): number {
    const idx = KEY_TONICS.findIndex((k) => k.toLowerCase() === tonic.toLowerCase());
    return idx >= 0 ? idx : 0;
}

export function resolveKeyModeIndex(mode: string): number {
    const idx = KEY_MODES.findIndex((m) => m.toLowerCase() === mode.toLowerCase());
    return idx >= 0 ? idx : 0;
}

export interface DebugPanelData {
    pdcSnapshot: engineApi.PdcDebugSnapshot | null;
    rtSnapshot: engineApi.RtDebugSnapshot | null;
    sandboxSnapshot: engineApi.PluginSandboxSnapshot | null;
    sandboxRuntime: engineApi.PluginSandboxSnapshot | null;
    engineConnected: boolean;
    telemetryRunning: boolean;
    isPlaying: boolean;
    bpm: number;
    posString: string;
    sampleRate: number;
    trackCount: number;
    engineLastError: string;
    pdcLoading: boolean;
    rtLoading: boolean;
    sandboxLoading: boolean;
    pdcError: string | null;
    rtError: string | null;
    sandboxError: string | null;
}
