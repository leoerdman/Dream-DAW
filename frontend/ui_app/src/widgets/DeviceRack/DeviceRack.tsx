import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import throttle from 'lodash.throttle';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useDragStore } from '@/shared/stores/useDragStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import * as engineApi from '@/shared/api/engine';
import { PluginWindow } from '@/widgets/PluginWindow/PluginWindow';
import {
    PluginKnob,
    PluginSlider,
    type PluginParam,
} from '@/widgets/DeviceRack/StandardPluginControls';
import type { BrowserDragItem } from '@/shared/types/Arrangement';
import { canDropInZone } from '@/shared/lib/dndMatrix';
import {
    defaultInternalPluginForTrack,
    getInternalPluginById,
    normalizeInternalPluginId,
    waveformIndexFromSamplePath,
    waveformLabel,
} from '@/shared/lib/internalPlugins';

/**
 * DeviceRack — Bottom panel: instrument & effects signal chain.
 *
 * Each track has its own Instrument & Effects chain (currently empty until
 * the user drops devices). IN/OUT meters show real-time signal levels
 * from the engine's MeterBank.
 *
 * Layout: [Title Bar] → [IN meter] → [...devices...] → [OUT meter] → [+ Add]
 */

// ── Types ──────────────────────────────────────────────────

interface DeviceSlot {
    id: string;
    name: string;
    effectType:
    | 'eq'
    | 'compressor'
    | 'delay'
    | 'reverb'
    | 'chorus'
    | 'utility'
    | 'limiter'
    | 'gate'
    | 'autoFilter'
    | 'phaser'
    | 'flanger'
    | 'distortion'
    | 'bitcrusher'
    | 'vst'
    | 'instrument'
    | 'sampler'
    | 'saturator'
    | 'waveSynth';
    isEnabled: boolean;
    params: PluginParam[];
    vuLevel: number;
    pluginId: string;
    isVst: boolean;
    source: 'internal' | 'vst' | 'unknown';
    samplePath?: string;
}

const RUNTIME_PARAM_INDEX_BY_EFFECT: Partial<Record<
    DeviceSlot['effectType'],
    Record<string, number>
>> = {
    eq: {
        lowfreq: 4,
        low: 5,
        lowq: 6,
        midfreq: 12,
        mid: 13,
        midq: 14,
        highfreq: 24,
        high: 25,
        highq: 26,
        out: 32,
    },
    utility: { gain: 0, pan: 1, width: 2, mono: 3 },
    compressor: { thr: 0, ratio: 1, atk: 2, rel: 3 },
    delay: { time: 0, fb: 1, 'dry/wet': 2, mix: 2 },
    reverb: { decay: 0, tone: 1, 'dry/wet': 2, mix: 2 },
    chorus: { rate: 0, depth: 1, mix: 2 },
    saturator: { drive: 0, tone: 1, mix: 2 },
    limiter: { thr: 0, rel: 1, ceil: 2 },
    gate: { thr: 0, atk: 1, hold: 2, rel: 3, range: 4 },
    autoFilter: { cutoff: 0, res: 1, rate: 2, depth: 3, env: 4, type: 5, mix: 6 },
    phaser: { rate: 0, depth: 1, fb: 2, stages: 3, center: 4, mix: 5 },
    flanger: { rate: 0, depth: 1, fb: 2, delay: 3, mix: 4 },
    distortion: { drive: 0, tone: 1, mix: 2, mode: 3 },
    bitcrusher: { bits: 0, down: 1, mix: 2 },
};

const DEVICE_PARAM_PRESETS: Record<
    DeviceSlot['effectType'],
    Array<Omit<PluginParam, 'value'> & { value: number }>
> = {
    eq: [
        { name: 'LowFreq', value: 120, min: 20, max: 1200, suffix: 'Hz', step: 1 },
        { name: 'Low', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'LowQ', value: 0.71, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'MidFreq', value: 1800, min: 120, max: 9000, suffix: 'Hz', step: 1 },
        { name: 'Mid', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'MidQ', value: 1.0, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'HighFreq', value: 9500, min: 1200, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'High', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'HighQ', value: 0.71, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'Out', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
    ],
    compressor: [
        { name: 'Thr', value: -18, min: -60, max: 0, suffix: 'dB', step: 0.1 },
        { name: 'Ratio', value: 4, min: 1, max: 20, suffix: ':1', step: 0.1 },
        { name: 'Atk', value: 10, min: 0.1, max: 200, suffix: 'ms', step: 0.1 },
        { name: 'Rel', value: 80, min: 10, max: 1000, suffix: 'ms', step: 1 },
    ],
    delay: [
        { name: 'Time', value: 280, min: 1, max: 2000, suffix: 'ms', step: 1 },
        { name: 'Fb', value: 30, min: 0, max: 95, suffix: '%', step: 1 },
        { name: 'Dry/Wet', value: 35, min: 0, max: 100, suffix: '%', step: 1 },
    ],
    reverb: [
        { name: 'Decay', value: 45, min: 0, max: 100, suffix: '%', step: 1 },
        { name: 'Tone', value: 0, min: -100, max: 100, suffix: '%', step: 1 },
        { name: 'Dry/Wet', value: 22, min: 0, max: 100, suffix: '%', step: 1 },
    ],
    chorus: [
        { name: 'Rate', value: 1.2, min: 0.1, max: 10, suffix: 'Hz', step: 0.1 },
        { name: 'Depth', value: 40, min: 0, max: 100, suffix: '%', step: 1 },
        { name: 'Mix', value: 35, min: 0, max: 100, suffix: '%', step: 1 },
    ],
    utility: [
        { name: 'Gain', value: 0, min: -30, max: 30, suffix: 'dB', step: 0.1 },
        { name: 'Pan', value: 0, min: -100, max: 100, suffix: '%', step: 1 },
        { name: 'Width', value: 100, min: 0, max: 200, suffix: '%', step: 1 },
        { name: 'Mono', value: 0, min: 0, max: 1, suffix: '', step: 1 },
    ],
    vst: [],
    instrument: [
        { name: 'Gain', value: 0, min: -24, max: 12, suffix: 'dB', step: 0.1 },
        { name: 'Atk', value: 5, min: 0, max: 2000, suffix: 'ms', step: 1 },
        { name: 'Rel', value: 50, min: 0, max: 4000, suffix: 'ms', step: 1 },
    ],
    sampler: [
        { name: 'Vol', value: 1, min: 0, max: 2, suffix: '', step: 0.01 },
        { name: 'Attack', value: 0.005, min: 0.001, max: 2.0, suffix: 's', step: 0.001 },
        { name: 'Decay', value: 0.1, min: 0.001, max: 4.0, suffix: 's', step: 0.001 },
        { name: 'Sustain', value: 1.0, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Release', value: 0.05, min: 0.001, max: 8.0, suffix: 's', step: 0.001 },
        { name: 'Root', value: 60, min: 0, max: 127, suffix: '', step: 1 },
    ],
    waveSynth: [
        { name: 'Osc1Wave', value: 0, min: 0, max: 3, suffix: '', step: 1 },
        { name: 'Osc2Wave', value: 0, min: 0, max: 3, suffix: '', step: 1 },
        { name: 'Mix', value: 0.35, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Detune', value: 0, min: -50, max: 50, suffix: 'ct', step: 0.1 },
        { name: 'Sub', value: 0, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Cutoff', value: 20000, min: 20, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'Res', value: 0, min: 0, max: 0.99, suffix: '', step: 0.01 },
        { name: 'FiltType', value: 0, min: 0, max: 3, suffix: '', step: 1 },
        { name: 'Vol', value: 1, min: 0, max: 2, suffix: '', step: 0.01 },
        { name: 'Attack', value: 0.005, min: 0.001, max: 2.0, suffix: 's', step: 0.001 },
        { name: 'Decay', value: 0.1, min: 0.001, max: 4.0, suffix: 's', step: 0.001 },
        { name: 'Sustain', value: 1.0, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Release', value: 0.05, min: 0.001, max: 8.0, suffix: 's', step: 0.001 },
    ],
    saturator: [
        { name: 'Drive', value: 3, min: 0, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'Tone', value: 0, min: -100, max: 100, suffix: '%', step: 1 },
        { name: 'Mix', value: 100, min: 0, max: 100, suffix: '%', step: 1 },
    ],
    limiter: [
        { name: 'Thr', value: -0.3, min: -30, max: 0, suffix: 'dB', step: 0.1 },
        { name: 'Rel', value: 100, min: 1, max: 1000, suffix: 'ms', step: 1 },
        { name: 'Ceil', value: -0.1, min: -30, max: 0, suffix: 'dB', step: 0.1 },
    ],
    gate: [
        { name: 'Thr', value: -40, min: -80, max: 0, suffix: 'dB', step: 0.1 },
        { name: 'Atk', value: 0.1, min: 0.01, max: 100, suffix: 'ms', step: 0.01 },
        { name: 'Hold', value: 10, min: 0, max: 500, suffix: 'ms', step: 1 },
        { name: 'Rel', value: 50, min: 1, max: 2000, suffix: 'ms', step: 1 },
        { name: 'Range', value: -80, min: -80, max: 0, suffix: 'dB', step: 0.1 },
    ],
    autoFilter: [
        { name: 'Cutoff', value: 1000, min: 20, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'Res', value: 0.3, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Rate', value: 1, min: 0.01, max: 20, suffix: 'Hz', step: 0.01 },
        { name: 'Depth', value: 0.5, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Env', value: 0, min: -1, max: 1, suffix: '', step: 0.01 },
        { name: 'Type', value: 0, min: 0, max: 3, suffix: '', step: 1 },
        { name: 'Mix', value: 1, min: 0, max: 1, suffix: '', step: 0.01 },
    ],
    phaser: [
        { name: 'Rate', value: 0.5, min: 0.01, max: 10, suffix: 'Hz', step: 0.01 },
        { name: 'Depth', value: 0.6, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Fb', value: 0.5, min: -0.95, max: 0.95, suffix: '', step: 0.01 },
        { name: 'Stages', value: 4, min: 2, max: 8, suffix: '', step: 2 },
        { name: 'Center', value: 1000, min: 100, max: 5000, suffix: 'Hz', step: 1 },
        { name: 'Mix', value: 0.5, min: 0, max: 1, suffix: '', step: 0.01 },
    ],
    flanger: [
        { name: 'Rate', value: 0.3, min: 0.01, max: 10, suffix: 'Hz', step: 0.01 },
        { name: 'Depth', value: 0.7, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Fb', value: 0.5, min: -0.95, max: 0.95, suffix: '', step: 0.01 },
        { name: 'Delay', value: 2, min: 0.1, max: 10, suffix: 'ms', step: 0.1 },
        { name: 'Mix', value: 0.5, min: 0, max: 1, suffix: '', step: 0.01 },
    ],
    distortion: [
        { name: 'Drive', value: 30, min: 0, max: 100, suffix: '', step: 1 },
        { name: 'Tone', value: 0.5, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Mix', value: 1, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Mode', value: 0, min: 0, max: 3, suffix: '', step: 1 },
    ],
    bitcrusher: [
        { name: 'Bits', value: 16, min: 1, max: 32, suffix: '', step: 1 },
        { name: 'Down', value: 1, min: 1, max: 64, suffix: 'x', step: 1 },
        { name: 'Mix', value: 1, min: 0, max: 1, suffix: '', step: 0.01 },
    ],
};

// ── VU Meter Helpers ──────────────────────────────────────

/** Normalize a peak dB value (-60..0) to 0..1 for display. */
function vuNorm(peakDb: number): number {
    const minDb = -60;
    const maxDb = 0;
    const clamped = Math.max(minDb, Math.min(maxDb, peakDb));
    return (clamped - minDb) / (maxDb - minDb);
}

function normalizePickedPath(picked: unknown): string | null {
    const rawValue = Array.isArray(picked) ? picked[0] : picked;
    if (typeof rawValue !== 'string') return null;

    let normalized = rawValue.trim();
    if (!normalized) return null;

    if (normalized.startsWith('file://')) {
        try {
            const url = new URL(normalized);
            normalized = decodeURIComponent(url.pathname);
            if (/^\/[A-Za-z]:/.test(normalized)) {
                normalized = normalized.slice(1);
            }
        } catch {
            normalized = decodeURIComponent(normalized.replace(/^file:\/\//, ''));
        }
    }

    return normalized;
}

function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
        const maybeMessage = (err as { message?: unknown }).message;
        if (typeof maybeMessage === 'string') return maybeMessage;
    }
    return 'Unknown error';
}

// ── Component ──────────────────────────────────────────

interface DeviceRackProps {
    selectedTrackId: string;
    onDropPluginToTrack?: (item: BrowserDragItem, trackId: string) => Promise<void>;
    onAddDefaultDeviceToTrack?: (trackId: string) => Promise<void>;
}

export const DeviceRack = ({
    selectedTrackId,
    onDropPluginToTrack,
    onAddDefaultDeviceToTrack,
}: DeviceRackProps) => {
    const [localBypass, setLocalBypass] = useState<Record<string, boolean>>({});
    const [localParams, setLocalParams] = useState<Record<string, number>>({});
    const [pluginCapability, setPluginCapability] = useState<
        Record<string, { supported: boolean; reason?: string }>
    >({});
    const [openGuiDevice, setOpenGuiDevice] = useState<DeviceSlot | null>(null);
    const [openSettingsDevice, setOpenSettingsDevice] = useState<DeviceSlot | null>(null);
    const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
    const statusError = useStatusStore((s) => s.setError);
    const statusClear = useStatusStore((s) => s.clear);
    const throttledParamSendsRef = useRef<Map<string, (value: number) => void>>(new Map());
    const projectTracks = useEngineStore((s) => s.projectTracks);
    const meters = useEngineStore((s) => s.meters);
    const fetchProject = useEngineStore((s) => s.fetchProject);
    const rackRef = useRef<HTMLDivElement>(null);
    const [isDropActive, setIsDropActive] = useState(false);

    // Find the track index for meter lookup
    const isMaster = selectedTrackId === 'master';
    const trackIndex = projectTracks.findIndex(
        (t) => t.id === selectedTrackId
    );

    // Get real-time meter levels for the selected track
    const inLevel = isMaster
        ? vuNorm(meters.master_left.peak)
        : trackIndex >= 0 && meters.tracks[trackIndex]
            ? vuNorm(meters.tracks[trackIndex][0].peak)
            : 0;

    const outLevel = isMaster
        ? vuNorm(meters.master_right.peak)
        : trackIndex >= 0 && meters.tracks[trackIndex]
            ? vuNorm(meters.tracks[trackIndex][1].peak)
            : 0;

    // Track display name
    const trackName = isMaster
        ? 'Master'
        : trackIndex >= 0
            ? projectTracks[trackIndex].name
            : 'No Track';

    const selectedTrack = trackIndex >= 0 ? projectTracks[trackIndex] : null;
    const chain = useMemo((): DeviceSlot[] => {
        if (!selectedTrack || isMaster) return [];

        const slots = [
            ...(selectedTrack.instrument ? [selectedTrack.instrument] : []),
            ...(selectedTrack.effects ?? []),
        ];
        return slots.map((slot) => {
            const pluginId = slot.plugin_id || slot.id;
            const pluginIdLower = normalizeInternalPluginId(pluginId.toLowerCase());
            const isVst = pluginIdLower.includes('vst3') || pluginIdLower.includes('.vst') || pluginIdLower.includes('vst');
            const isInternal = pluginIdLower.startsWith('internal://');

            const normalized = `${slot.name} ${pluginId}`.toLowerCase();
            let effectType: DeviceSlot['effectType'] =
                selectedTrack.instrument?.id === slot.id ? 'instrument' : isVst ? 'vst' : 'utility';
            const internalDef = getInternalPluginById(pluginIdLower);
            if (internalDef?.id === 'internal://instrument/wave-synth') effectType = 'waveSynth';
            else if (normalized.includes('sampler')) effectType = 'sampler';
            else if (normalized.includes('eq')) effectType = 'eq';
            else if (normalized.includes('compressor')) effectType = 'compressor';
            else if (normalized.includes('delay')) effectType = 'delay';
            else if (normalized.includes('reverb')) effectType = 'reverb';
            else if (normalized.includes('chorus')) effectType = 'chorus';
            else if (normalized.includes('saturator')) effectType = 'saturator';
            else if (normalized.includes('limiter')) effectType = 'limiter';
            else if (normalized.includes('gate')) effectType = 'gate';
            else if (normalized.includes('auto filter') || normalized.includes('auto-filter') || normalized.includes('autofilter')) effectType = 'autoFilter';
            else if (normalized.includes('phaser')) effectType = 'phaser';
            else if (normalized.includes('flanger')) effectType = 'flanger';
            else if (normalized.includes('distortion')) effectType = 'distortion';
            else if (normalized.includes('bitcrusher') || normalized.includes('bit-crusher')) effectType = 'bitcrusher';
            else if (selectedTrack.instrument?.id === slot.id && !isVst) effectType = 'instrument';

            return {
                id: slot.id,
                name: slot.name,
                effectType,
                isEnabled: !(localBypass[slot.id] ?? slot.is_bypassed),
                params: (DEVICE_PARAM_PRESETS[effectType] ?? []).map((template) => {
                    const key = `${slot.id}:${template.name}`;
                    let backendValue = template.value;
                    if ((effectType === 'sampler' || effectType === 'instrument' || effectType === 'waveSynth') && selectedTrack.sampler) {
                        const n = template.name.toLowerCase();
                        if (n === 'wave' || n === 'osc1wave') backendValue = waveformIndexFromSamplePath(selectedTrack.sampler.sample_path);
                        else if (n === 'osc2wave') backendValue = Math.max(0, Math.min(3, selectedTrack.sampler.osc2_waveform ?? 0));
                        else if (n === 'mix') backendValue = Math.max(0, Math.min(1, selectedTrack.sampler.osc_mix ?? 0.35));
                        else if (n === 'detune') backendValue = Math.max(-50, Math.min(50, selectedTrack.sampler.detune_cents ?? 0));
                        else if (n === 'sub') backendValue = Math.max(0, Math.min(1, selectedTrack.sampler.sub_level ?? 0));
                        else if (n === 'vol') backendValue = selectedTrack.sampler.volume;
                        else if (n === 'attack') backendValue = selectedTrack.sampler.attack;
                        else if (n === 'decay') backendValue = selectedTrack.sampler.decay;
                        else if (n === 'sustain') backendValue = selectedTrack.sampler.sustain;
                        else if (n === 'release') backendValue = selectedTrack.sampler.release;
                        else if (n === 'root') backendValue = selectedTrack.sampler.root_note;
                    }
                    return {
                        ...template,
                        value: localParams[key] ?? backendValue,
                    };
                }),
                vuLevel: outLevel,
                pluginId,
                isVst,
                source: isInternal ? 'internal' : isVst ? 'vst' : 'unknown',
                samplePath: effectType === 'sampler' || effectType === 'instrument' || effectType === 'waveSynth'
                    ? (selectedTrack.sampler?.sample_path ?? undefined)
                    : undefined,
            };
        });
    }, [selectedTrack, localBypass, localParams, isMaster, outLevel]);

    const toggleDevice = useCallback((device: DeviceSlot) => {
        const currentBypassed = localBypass[device.id] ?? !device.isEnabled;
        const nextBypassed = !currentBypassed;
        setLocalBypass((prev) => ({ ...prev, [device.id]: nextBypassed }));

        // Internal effects are processed by runtime device chain -> keep bypass in sync.
        if (!selectedTrack || selectedTrackId === 'master' || device.source !== 'internal') return;
        const trackIdx = projectTracks.findIndex((t) => t.id === selectedTrack.id);
        const slotIdx = selectedTrack.effects.findIndex((fx) => fx.id === device.id);
        if (trackIdx < 0 || slotIdx < 0) return;
        void engineApi.bypassDevice(trackIdx, slotIdx, nextBypassed).catch((err) => {
            console.error('[DeviceRack] bypassDevice failed:', err);
        });
    }, [localBypass, selectedTrack, selectedTrackId, projectTracks]);

    const setPluginParam = useCallback((deviceId: string, paramName: string, value: number) => {
        setLocalParams((prev) => ({ ...prev, [`${deviceId}:${paramName}`]: value }));
    }, []);

    const sendInternalParam = useCallback(
        (device: DeviceSlot, paramName: string, value: number) => {
            if (!selectedTrack || selectedTrackId === 'master') return;
            const trackIdx = projectTracks.findIndex((t) => t.id === selectedTrack.id);
            const effectSlotIdx = selectedTrack.effects.findIndex((fx) => fx.id === device.id);
            const pushPluginParam = (paramIndex: number, paramValue: number) => {
                if (trackIdx < 0 || effectSlotIdx < 0) return;
                void engineApi.setDeviceParam(trackIdx, effectSlotIdx, paramIndex, paramValue).catch((err) => {
                    console.error('[DeviceRack] setDeviceParam failed:', err);
                });
            };

            // Runtime DSP path for built-in effects — this is the audible path.
            if (device.source === 'internal') {
                const effectMap = RUNTIME_PARAM_INDEX_BY_EFFECT[device.effectType];
                if (effectMap) {
                    const key = paramName.toLowerCase();
                    const index = effectMap[key];
                    if (index != null) {
                        pushPluginParam(index, value);
                    }
                }
            }

            const normalizedName = paramName.toLowerCase();
            let paramId = `${device.effectType}.${normalizedName}`;
            if (device.effectType === 'utility') {
                if (normalizedName === 'gain') paramId = 'plugin.gain';
                else if (normalizedName === 'pan') paramId = 'plugin.pan';
            } else if (device.effectType === 'sampler' || device.effectType === 'instrument' || device.effectType === 'waveSynth') {
                if (normalizedName === 'vol') paramId = 'sampler.volume';
                else if (normalizedName === 'attack') paramId = 'sampler.attack';
                else if (normalizedName === 'decay') paramId = 'sampler.decay';
                else if (normalizedName === 'sustain') paramId = 'sampler.sustain';
                else if (normalizedName === 'release') paramId = 'sampler.release';
                else if (normalizedName === 'root') paramId = 'sampler.rootNote';
                else if (normalizedName === 'wave' || normalizedName === 'osc1wave') paramId = 'synth.osc1.waveform';
                else if (normalizedName === 'osc2wave') paramId = 'synth.osc2.waveform';
                else if (normalizedName === 'mix') paramId = 'synth.osc.mix';
                else if (normalizedName === 'detune') paramId = 'synth.detune';
                else if (normalizedName === 'sub') paramId = 'synth.sub';
                else if (normalizedName === 'cutoff') paramId = 'synth.filter.cutoff';
                else if (normalizedName === 'res') paramId = 'synth.filter.resonance';
                else if (normalizedName === 'filttype') paramId = 'synth.filter.type';
            } else if (device.effectType === 'eq') {
                if (normalizedName === 'low') paramId = 'eq.low';
                else if (normalizedName === 'lowfreq') paramId = 'eq.lowFreq';
                else if (normalizedName === 'lowq') paramId = 'eq.lowQ';
                else if (normalizedName === 'mid') paramId = 'eq.mid';
                else if (normalizedName === 'midfreq') paramId = 'eq.midFreq';
                else if (normalizedName === 'midq') paramId = 'eq.midQ';
                else if (normalizedName === 'high') paramId = 'eq.high';
                else if (normalizedName === 'highfreq') paramId = 'eq.highFreq';
                else if (normalizedName === 'highq') paramId = 'eq.highQ';
                else if (normalizedName === 'out') paramId = 'eq.out';
            }

            const key = `${selectedTrack.id}:${device.id}:${paramId}`;
            let sender = throttledParamSendsRef.current.get(key);
            if (!sender) {
                sender = throttle((v: number) => {
                    void engineApi.setInternalPluginParam(selectedTrack.id, device.id, paramId, v).catch((err) => {
                        console.error('[DeviceRack] setInternalPluginParam failed:', err);
                    });
                }, 32);
                throttledParamSendsRef.current.set(key, sender);
            }
            sender(value);
        },
        [selectedTrack, selectedTrackId, projectTracks],
    );

    useEffect(() => {
        if (selectedDeviceId && !chain.some((d) => d.id === selectedDeviceId)) {
            setSelectedDeviceId(null);
        }
        if (!selectedDeviceId && chain.length > 0) {
            const preferredInline =
                chain.find((d) => d.source === 'internal' && (d.effectType === 'sampler' || d.effectType === 'instrument')) ??
                chain.find((d) => d.source === 'internal') ??
                null;
            if (preferredInline) {
                setSelectedDeviceId(preferredInline.id);
            }
        }
        if (openGuiDevice) {
            const next = chain.find((d) => d.id === openGuiDevice.id);
            if (!next) setOpenGuiDevice(null);
            else setOpenGuiDevice(next);
        }
        if (openSettingsDevice) {
            const next = chain.find((d) => d.id === openSettingsDevice.id);
            if (!next) setOpenSettingsDevice(null);
            else setOpenSettingsDevice(next);
        }
    }, [chain, selectedDeviceId, openGuiDevice, openSettingsDevice]);

    useEffect(() => {
        const onKeyDown = async (e: KeyboardEvent) => {
            if ((e.key !== 'Delete' && e.key !== 'Backspace') || !selectedDeviceId) return;
            const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
            if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement | null)?.isContentEditable) return;
            if (!selectedTrack || selectedTrackId === 'master') return;
            e.preventDefault();
            try {
                await engineApi.removePluginFromTrack(selectedTrack.id, selectedDeviceId);
                if (openGuiDevice?.id === selectedDeviceId) setOpenGuiDevice(null);
                if (openSettingsDevice?.id === selectedDeviceId) setOpenSettingsDevice(null);
                setSelectedDeviceId(null);
                await fetchProject();
                statusClear();
            } catch (err) {
                console.error('[DeviceRack] removePluginFromTrack failed:', err);
                statusError('Failed to remove plugin from track.');
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [selectedDeviceId, selectedTrack, selectedTrackId, openGuiDevice, openSettingsDevice, fetchProject, statusClear, statusError]);

    useEffect(() => {
        let cancelled = false;
        const vstDevices = chain.filter((d) => d.isVst);
        const missing = vstDevices.filter((d) => pluginCapability[d.pluginId] == null);
        if (missing.length === 0) {
            return;
        }

        (async () => {
            const results = await Promise.all(
                missing.map(async (device) => {
                    try {
                        const cap = await engineApi.canOpenPluginEditor(device.pluginId);
                        return [device.pluginId, { supported: cap.supported, reason: cap.reason ?? undefined }] as const;
                    } catch (err) {
                        console.error('[DeviceRack] Capability probe failed:', err);
                        return [device.pluginId, { supported: false, reason: 'Capability check failed.' }] as const;
                    }
                })
            );

            if (cancelled) {
                return;
            }
            setPluginCapability((prev) => {
                const next = { ...prev };
                for (const [id, cap] of results) {
                    next[id] = cap;
                }
                return next;
            });
        })();

        return () => {
            cancelled = true;
        };
    }, [chain, pluginCapability]);

    useEffect(() => {
        const onMouseMove = (e: MouseEvent) => {
            const dragging = useDragStore.getState().draggingItem;
            if (!dragging || isMaster || !canDropInZone(dragging, 'device-rack').allowed) {
                if (isDropActive) {
                    setIsDropActive(false);
                }
                return;
            }
            const rect = rackRef.current?.getBoundingClientRect();
            if (!rect) return;
            const inside =
                e.clientX >= rect.left &&
                e.clientX <= rect.right &&
                e.clientY >= rect.top &&
                e.clientY <= rect.bottom;
            if (inside !== isDropActive) {
                setIsDropActive(inside);
            }
        };

        const onMouseUp = async (e: MouseEvent) => {
            const dragging = useDragStore.getState().draggingItem;
            if (!dragging || isMaster || !canDropInZone(dragging, 'device-rack').allowed) return;
            const rect = rackRef.current?.getBoundingClientRect();
            if (!rect) return;
            const inside =
                e.clientX >= rect.left &&
                e.clientX <= rect.right &&
                e.clientY >= rect.top &&
                e.clientY <= rect.bottom;
            if (!inside) {
                setIsDropActive(false);
                return;
            }

            const targetTrack = selectedTrack ?? projectTracks[0] ?? null;
            if (!targetTrack) {
                statusError('No target track selected.');
                useDragStore.getState().endDrag();
                setIsDropActive(false);
                return;
            }

            try {
                if (onDropPluginToTrack) {
                    await onDropPluginToTrack(dragging, targetTrack.id);
                } else {
                    const hint = dragging.slotHint ?? 'auto';
                    const slot: 'instrument' | 'effect' =
                        hint === 'instrument'
                            ? 'instrument'
                            : hint === 'effect'
                                ? 'effect'
                                : targetTrack.track_type === 'Midi' && !targetTrack.instrument
                                    ? 'instrument'
                                    : 'effect';
                    await engineApi.addPluginToTrack(
                        targetTrack.id,
                        dragging.path,
                        dragging.name,
                        slot,
                    );
                    await fetchProject();
                }
                statusClear();
            } catch (err) {
                console.error('[DeviceRack] addPluginToTrack failed:', err);
                statusError('Failed to add plugin to track.');
            } finally {
                useDragStore.getState().endDrag();
                setIsDropActive(false);
            }
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp, true);
        return () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp, true);
        };
    }, [isDropActive, isMaster, selectedTrack, projectTracks, fetchProject, statusClear, statusError, onDropPluginToTrack]);

    return (
        <>
            <div
                ref={rackRef}
                tabIndex={0}
                data-keyboard-scope="device-rack"
                data-selected-device-id={selectedDeviceId ?? ''}
                onMouseDown={() => rackRef.current?.focus()}
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    height: '100%',
                    background: 'var(--color-bg-panel)',
                    outline: isDropActive ? '2px solid var(--color-accent-primary)' : 'none',
                    boxShadow: isDropActive ? 'inset 0 0 0 1px rgba(74, 144, 217, 0.35)' : 'none',
                }}>


                {/* ── Header Bar ── */}
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '4px 10px',
                    borderBottom: '1px solid var(--color-divider)',
                    background: 'var(--color-bg-header)',
                    height: 24,
                    flexShrink: 0,
                }}>
                    <span style={{
                        fontSize: 'var(--font-size-2xs)',
                        fontWeight: 600,
                        color: 'var(--color-text-secondary)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                    }}>
                        ⛓ {trackName} — Instrument & Effects Chain · {chain.length} devices
                    </span>
                    <span style={{
                        fontSize: 'var(--font-size-2xs)',
                        color: 'var(--color-text-tertiary)',
                    }}>
                        {trackName}
                    </span>
                </div>

                {/* ── Device Chain (horizontal scroll) ── */}
                <div className="scrollbar-hide" style={{
                    display: 'flex',
                    alignItems: 'stretch',
                    gap: 6,
                    padding: '8px 10px',
                    flex: 1,
                    minHeight: 0,
                    overflowX: 'auto',
                    overflowY: 'hidden',
                }}>

                    {/* Input meter — real data */}
                    <MeterBar level={inLevel} isInput />

                    {/* Device slots */}
                    {chain.length > 0 ? (
                        chain.map((device, idx) => (
                            <DeviceNode
                                key={device.id}
                                order={idx + 1}
                                device={device}
                                isSelected={selectedDeviceId === device.id}
                                editorSupported={pluginCapability[device.pluginId]?.supported ?? true}
                                editorReason={pluginCapability[device.pluginId]?.reason}
                                onToggle={() => toggleDevice(device)}
                                onSelect={() => {
                                    setSelectedDeviceId(device.id);
                                    rackRef.current?.focus();
                                    statusClear();
                                }}
                                onOpenSettings={() => {
                                    if (device.source !== 'vst') return;
                                    setSelectedDeviceId(device.id);
                                    setOpenSettingsDevice(device);
                                    statusClear();
                                }}
                                onParamChange={(name, value) => {
                                    setPluginParam(device.id, name, value);
                                    sendInternalParam(device, name, value);
                                }}
                                onDropSample={async (samplePath) => {
                                    if (!selectedTrack || selectedTrackId === 'master') return;
                                    try {
                                        const normalizedPath = normalizePickedPath(samplePath);
                                        if (!normalizedPath) {
                                            statusError('Failed to load sampler sample: invalid file path.');
                                            return;
                                        }
                                        await engineApi.setSamplerSample(selectedTrack.id, normalizedPath);
                                        setSelectedDeviceId(device.id);
                                        statusClear();
                                        await fetchProject();
                                    } catch (err) {
                                        console.error('[DeviceRack] sampler device drop failed:', err);
                                        statusError(`Failed to load sampler sample: ${errorMessage(err)}`);
                                    }
                                }}
                                onLoadSample={async () => {
                                    if (!selectedTrack || selectedTrackId === 'master') return;
                                    try {
                                        const { open } = await import('@tauri-apps/plugin-dialog');
                                        const picked = await open({
                                            multiple: false,
                                            title: 'Load Sampler Sample',
                                            filters: [{ name: 'Audio', extensions: ['wav', 'aif', 'aiff', 'flac', 'mp3', 'ogg', 'm4a', 'aac'] }],
                                        });
                                        const normalizedPath = normalizePickedPath(picked);
                                        if (normalizedPath) {
                                            await engineApi.setSamplerSample(selectedTrack.id, normalizedPath);
                                            statusClear();
                                            await fetchProject();
                                        }
                                    } catch (err) {
                                        console.error('[DeviceRack] setSamplerSample failed:', err);
                                        statusError(`Failed to load sampler sample: ${errorMessage(err)}`);
                                    }
                                }}
                                onOpenGUI={async () => {
                                    setSelectedDeviceId(device.id);
                                    if (device.source === 'internal') {
                                        statusClear();
                                        return;
                                    }
                                    try {
                                        const capability = await engineApi.canOpenPluginEditor(device.pluginId);
                                        setPluginCapability((prev) => ({
                                            ...prev,
                                            [device.pluginId]: {
                                                supported: capability.supported,
                                                reason: capability.reason ?? undefined,
                                            },
                                        }));
                                        if (!capability.supported) {
                                            const reason = capability.reason ?? 'Plugin editor is not supported.';
                                            console.warn('[DeviceRack] Plugin editor unavailable:', reason);
                                            statusError(reason);
                                            return;
                                        }
                                        // Try native plugin editor bridge first (host-managed).
                                        // Keep DAW-owned UI fallback available for consistency.
                                        await engineApi.openPluginWindow(device.pluginId);
                                        setOpenGuiDevice(device);
                                        statusClear();
                                    } catch (err) {
                                        console.error('[DeviceRack] Failed to open plugin window:', err);
                                        statusError('Failed to open plugin window.');
                                    }
                                }}
                            />
                        ))
                    ) : (
                        /* ── Empty State ── */
                        <div style={{
                            flex: 1,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 8,
                            minHeight: 80,
                            color: 'var(--color-text-tertiary)',
                        }}>
                            <span style={{
                                fontSize: 20,
                                opacity: 0.3,
                            }}>♪</span>
                            <span style={{
                                fontSize: 10,
                                fontWeight: 500,
                                letterSpacing: '0.03em',
                            }}>
                                Drop Files and Devices Here
                            </span>
                        </div>
                    )}

                    {/* Output meter — show only when chain exists */}
                    {chain.length > 0 && <MeterBar level={outLevel} />}

                    {/* Add device button */}
                    <button
                        onClick={async () => {
                            const targetTrack = selectedTrack ?? projectTracks[0] ?? null;
                            if (!targetTrack) {
                                statusError('No target track selected.');
                                return;
                            }
                            try {
                                if (onAddDefaultDeviceToTrack) {
                                    await onAddDefaultDeviceToTrack(targetTrack.id);
                                } else {
                                    const def = defaultInternalPluginForTrack(
                                        targetTrack.track_type,
                                        Boolean(targetTrack.instrument),
                                    );
                                    await engineApi.addPluginToTrack(
                                        targetTrack.id,
                                        def.pluginId,
                                        def.pluginName,
                                        def.slot,
                                    );
                                    await fetchProject();
                                }
                                statusClear();
                            } catch (err) {
                                console.error('[DeviceRack] add default device failed:', err);
                                statusError('Failed to add device.');
                            }
                        }}
                        style={{
                            width: 64,
                            minWidth: 64,
                            height: '100%',
                            minHeight: 100,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 6,
                            background: 'transparent',
                            border: '1px dashed var(--color-border-subtle)',
                            borderRadius: 'var(--radius-sm)',
                            cursor: 'pointer',
                            color: 'var(--color-text-tertiary)',
                            fontSize: 9,
                            fontWeight: 500,
                            flexShrink: 0,
                            transition: 'all var(--transition-fast)',
                        }}
                        onMouseEnter={e => {
                            e.currentTarget.style.borderColor = 'var(--color-accent-primary)';
                            e.currentTarget.style.color = 'var(--color-accent-primary)';
                        }}
                        onMouseLeave={e => {
                            e.currentTarget.style.borderColor = 'var(--color-border-subtle)';
                            e.currentTarget.style.color = 'var(--color-text-tertiary)';
                        }}
                    >
                        <span style={{ fontSize: 18, lineHeight: 1 }}>+</span>
                        Add Device
                    </button>
                </div>

            </div>
            {openGuiDevice && openGuiDevice.isVst && (
                <PluginWindow
                    pluginId={openGuiDevice.pluginId}
                    pluginName={openGuiDevice.name}
                    pluginType={openGuiDevice.effectType === 'sampler' || openGuiDevice.effectType === 'instrument' || openGuiDevice.effectType === 'waveSynth' ? 'instrument' : 'effect'}
                    isBypassed={!openGuiDevice.isEnabled}
                    onToggleBypass={() => toggleDevice(openGuiDevice)}
                    onClose={() => setOpenGuiDevice(null)}
                    width={openGuiDevice.isVst ? 960 : openGuiDevice.effectType === 'eq' ? 760 : openGuiDevice.effectType === 'sampler' ? 820 : openGuiDevice.effectType === 'waveSynth' ? 780 : 640}
                    height={openGuiDevice.effectType === 'eq' ? 420 : openGuiDevice.effectType === 'sampler' ? 460 : openGuiDevice.effectType === 'waveSynth' ? 420 : 380}
                >
                    <PluginGuiSurface
                        device={openGuiDevice}
                        onParamChange={(name, value) => {
                            setPluginParam(openGuiDevice.id, name, value);
                            sendInternalParam(openGuiDevice, name, value);
                        }}
                        onDropSample={async (samplePath) => {
                            if (!selectedTrack || selectedTrackId === 'master') return;
                            try {
                                const normalizedPath = normalizePickedPath(samplePath);
                                if (!normalizedPath) {
                                    statusError('Failed to load sampler sample: invalid file path.');
                                    return;
                                }
                                await engineApi.setSamplerSample(selectedTrack.id, normalizedPath);
                                statusClear();
                                await fetchProject();
                            } catch (err) {
                                console.error('[DeviceRack] sampler drop failed:', err);
                                statusError(`Failed to load sampler sample: ${errorMessage(err)}`);
                            }
                        }}
                        onLoadSample={async () => {
                            if (!selectedTrack || selectedTrackId === 'master') return;
                            try {
                                const { open } = await import('@tauri-apps/plugin-dialog');
                                const picked = await open({
                                    multiple: false,
                                    title: 'Load Sampler Sample',
                                    filters: [{ name: 'Audio', extensions: ['wav', 'aif', 'aiff', 'flac', 'mp3', 'ogg', 'm4a', 'aac'] }],
                                });
                                const normalizedPath = normalizePickedPath(picked);
                                if (normalizedPath) {
                                    await engineApi.setSamplerSample(selectedTrack.id, normalizedPath);
                                    statusClear();
                                    await fetchProject();
                                }
                            } catch (err) {
                                console.error('[DeviceRack] setSamplerSample failed:', err);
                                statusError(`Failed to load sampler sample: ${errorMessage(err)}`);
                            }
                        }}
                    />
                </PluginWindow>
            )}
            {openSettingsDevice && openSettingsDevice.isVst && (
                <PluginWindow
                    pluginId={`${openSettingsDevice.pluginId}:settings`}
                    pluginName={`${openSettingsDevice.name} • Settings`}
                    pluginType={openSettingsDevice.effectType === 'sampler' || openSettingsDevice.effectType === 'instrument' || openSettingsDevice.effectType === 'waveSynth' ? 'instrument' : 'effect'}
                    isBypassed={!openSettingsDevice.isEnabled}
                    onToggleBypass={() => toggleDevice(openSettingsDevice)}
                    onClose={() => setOpenSettingsDevice(null)}
                    width={560}
                    height={400}
                >
                    <PluginSettingsPanel
                        device={openSettingsDevice}
                        onParamChange={(name, value) => {
                            setPluginParam(openSettingsDevice.id, name, value);
                            sendInternalParam(openSettingsDevice, name, value);
                        }}
                        onLoadSample={async () => {
                            if (!selectedTrack || selectedTrackId === 'master') return;
                            try {
                                const { open } = await import('@tauri-apps/plugin-dialog');
                                const picked = await open({
                                    multiple: false,
                                    title: 'Load Sampler Sample',
                                    filters: [{ name: 'Audio', extensions: ['wav', 'aif', 'aiff', 'flac', 'mp3', 'ogg', 'm4a', 'aac'] }],
                                });
                                const normalizedPath = normalizePickedPath(picked);
                                if (normalizedPath) {
                                    await engineApi.setSamplerSample(selectedTrack.id, normalizedPath);
                                    statusClear();
                                    await fetchProject();
                                }
                            } catch (err) {
                                console.error('[DeviceRack] setSamplerSample failed:', err);
                                statusError(`Failed to load sampler sample: ${errorMessage(err)}`);
                            }
                        }}
                    />
                </PluginWindow>
            )}
        </>
    );
};

// ── DeviceNode ──────────────────────────────────────────

const DeviceNode = ({
    order,
    device, onToggle, onOpenGUI,
    isSelected,
    onSelect,
    onOpenSettings,
    onParamChange,
    onDropSample,
    onLoadSample,
    editorSupported, editorReason,
}: {
    order: number;
    device: DeviceSlot;
    onToggle: () => void;
    isSelected: boolean;
    onSelect: () => void;
    onOpenSettings: () => void;
    onParamChange: (paramName: string, value: number) => void;
    onDropSample?: (samplePath: string) => void;
    onLoadSample?: () => void;
    onOpenGUI?: () => void;
    editorSupported?: boolean;
    editorReason?: string;
}) => {
    const vuWidthPercent = Math.min(100, Math.max(0, device.vuLevel * 100));
    const vuColor = device.vuLevel > 0.85 ? 'var(--color-meter-clip)' : device.vuLevel > 0.6 ? 'var(--color-meter-hot)' : 'var(--color-meter-normal)';

    // Color per device type (matching Ableton's device categories)
    const typeColorMap: Record<string, string> = {
        instrument: '#4a9eff',
        sampler: '#4a9eff',
        waveSynth: '#62d2a2',
        eq: '#d9a625',
        compressor: '#66cc33',
        delay: '#33a6d9',
        reverb: '#8844aa',
        chorus: '#c850a0',
        utility: '#999',
        saturator: '#d97028',
        limiter: '#59d3be',
        gate: '#6cc66d',
        autoFilter: '#3ed1d1',
        phaser: '#8b7bff',
        flanger: '#55a6ff',
        distortion: '#ff844d',
        bitcrusher: '#f0d65c',
        vst: '#4a9eff',
    };
    const typeColor = typeColorMap[device.effectType] || 'var(--color-accent-primary)';
    const rackWidth = isSelected && device.source === 'internal'
        ? device.effectType === 'waveSynth'
            ? 980
            : device.effectType === 'eq'
                ? 860
                : 720
        : device.effectType === 'sampler'
            ? 360
            : device.effectType === 'waveSynth'
                ? 460
                : device.effectType === 'instrument'
                    ? 320
                    : device.effectType === 'eq'
                        ? 280
                        : device.effectType === 'autoFilter' || device.effectType === 'phaser' || device.effectType === 'flanger'
                            ? 300
                            : device.effectType === 'gate'
                                ? 280
                                : 240;

    return (
        <div
            className="device-node"
            data-effect={device.effectType}
            style={{
                minWidth: rackWidth,
                width: rackWidth,
                display: 'flex',
                flexDirection: 'column',
                background: 'var(--color-bg-node)',
                borderRadius: 'var(--radius-sm)',
                border: isSelected ? '1px solid var(--color-accent-primary)' : '1px solid #4a4a4a',
                overflow: 'hidden',
                opacity: device.isEnabled ? 1 : 0.5,
                transition: 'opacity var(--transition-fast)',
                flexShrink: 0,
                height: '100%',
                minHeight: '100%',
                position: 'relative',
                boxShadow: isSelected ? '0 0 0 1px var(--color-accent-primary), 0 0 12px rgba(74,144,217,0.35)' : 'none',
            }}
            onMouseUp={() => {
                const dragging = useDragStore.getState().draggingItem;
                const acceptance = dragging ? canDropInZone(dragging, 'sampler-surface') : { allowed: false };
                const isSamplerDevice =
                    device.source === 'internal' &&
                    (device.effectType === 'sampler' || device.effectType === 'instrument');
                if (!isSamplerDevice) return;
                if (dragging?.path && acceptance.allowed) {
                    onDropSample?.(dragging.path);
                    useDragStore.getState().endDrag();
                }
            }}
        >
            {/* Type color stripe at top (2px) */}
            <div style={{
                height: 2,
                background: typeColor,
                flexShrink: 0,
            }} />

            {/* Header */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '3px 6px',
                borderBottom: '1px solid var(--color-divider)',
                background: 'var(--color-bg-header)',
                cursor: 'pointer',
            }}
                onClick={(e) => { e.stopPropagation(); onSelect(); }}
            >
                <button
                    onClick={onToggle}
                    title={device.isEnabled ? 'Disable' : 'Enable'}
                    style={{
                        width: 11, height: 11,
                        borderRadius: '50%',
                        background: device.isEnabled ? typeColor : 'var(--color-text-tertiary)',
                        border: 'none',
                        cursor: 'pointer',
                        flexShrink: 0,
                    }}
                />
                <span style={{
                    fontSize: 'var(--font-size-2xs)',
                    fontWeight: 600,
                    color: 'var(--color-text-primary)',
                    flex: 1,
                    textAlign: 'center',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                }}>
                    {device.name}
                </span>
                <span style={{
                    fontSize: 9,
                    color: 'var(--color-text-tertiary)',
                    fontFamily: 'var(--font-mono)',
                    marginRight: 4,
                }}>
                    {order}
                </span>
                {device.source === 'vst' ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <button
                            onClick={(e) => { e.stopPropagation(); onOpenGUI?.(); }}
                            title={editorSupported === false
                                ? (editorReason ?? 'Plugin editor is unavailable')
                                : 'Open Plugin GUI'}
                            disabled={editorSupported === false}
                            style={headerIconBtnStyle(editorSupported === false)}
                        >
                            UI
                        </button>
                        <button
                            onClick={(e) => { e.stopPropagation(); onOpenSettings(); }}
                            title="Plugin Settings / Automatable Params"
                            style={headerIconBtnStyle(false)}
                        >
                            🔧
                        </button>
                    </div>
                ) : (
                    <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', fontWeight: 700 }}>
                        INLINE
                    </span>
                )}
                <span style={{
                    fontSize: 8,
                    color: device.source === 'vst' ? '#2ecc71' : 'var(--color-text-tertiary)',
                    fontWeight: 700,
                    minWidth: 28,
                    textAlign: 'right',
                }}>
                    {device.source === 'vst' ? 'VST' : 'INT'}
                </span>
            </div>

            {isSelected && device.source === 'internal' ? (
                <div style={{ padding: 6, flex: 1, minHeight: 0 }}>
                    <PluginGuiSurface
                        device={device}
                        onParamChange={onParamChange}
                        onDropSample={onDropSample}
                        onLoadSample={onLoadSample}
                    />
                </div>
            ) : (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px',
                    flex: 1,
                    minHeight: 0,
                    overflow: 'hidden',
                }}>
                    {device.source === 'internal' && device.params.length > 0 ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                            {device.params.slice(0, device.effectType === 'waveSynth' ? 8 : device.effectType === 'sampler' ? 4 : 3).map((p) => (
                                <PluginKnob key={p.name} param={p} onChange={onParamChange} />
                            ))}
                        </div>
                    ) : (
                        <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between' }}>
                            <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
                                {device.source === 'vst' ? 'Native GUI' : 'Internal GUI'}
                            </span>
                            <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)' }}>
                                {device.params.length} params
                            </span>
                        </div>
                    )}
                </div>
            )}

            {/* Bottom VU bar */}
            <div style={{
                height: 3,
                background: 'var(--color-meter-bg)',
                position: 'relative',
                flexShrink: 0,
            }}>
                <div style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    height: '100%',
                    width: `${vuWidthPercent}%`,
                    background: vuColor,
                    transition: 'width 0.08s linear',
                }} />
            </div>
        </div>
    );
};

const headerIconBtnStyle = (disabled: boolean) =>
    ({
        minWidth: 24,
        height: 18,
        padding: '0 6px',
        borderRadius: 4,
        border: '1px solid var(--color-divider)',
        background: disabled ? 'rgba(120, 120, 120, 0.25)' : 'var(--color-bg-elevated)',
        color: disabled ? 'var(--color-text-tertiary)' : 'var(--color-text-secondary)',
        fontSize: 9,
        fontWeight: 700,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.65 : 1,
        transition: 'all var(--transition-fast)',
    }) as const;

const pluginPanelLayoutStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateRows: '90px auto',
    gap: 8,
    height: '100%',
};

const pluginPanelCardBaseStyle: React.CSSProperties = {
    border: '1px solid color-mix(in srgb, var(--surface-3) 82%, #4d4d4d)',
    borderRadius: 6,
    padding: '8px 10px',
    display: 'grid',
    gridTemplateRows: '1fr auto',
    gap: 6,
};

const pluginPanelTitleStyle: React.CSSProperties = {
    fontSize: 9,
    color: 'var(--color-text-secondary)',
    letterSpacing: '0.03em',
    textTransform: 'uppercase',
    fontWeight: 700,
};

const pluginPanelMetaStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 9,
    color: 'var(--color-text-secondary)',
    fontFamily: 'var(--font-mono)',
};

const pluginPanelKnobGrid = (columns: string): React.CSSProperties => ({
    display: 'grid',
    gridTemplateColumns: columns,
    alignItems: 'center',
    gap: 8,
});

const PluginGuiSurface = ({
    device,
    onParamChange,
    onDropSample,
    onLoadSample,
}: {
    device: DeviceSlot;
    onParamChange: (paramName: string, value: number) => void;
    onDropSample?: (samplePath: string) => void;
    onLoadSample?: () => void;
}) => {
    const [waveformPeaks, setWaveformPeaks] = useState<number[] | null>(null);
    const eqSurfaceRef = useRef<SVGSVGElement | null>(null);
    const [dragEqBand, setDragEqBand] = useState<'low' | 'mid' | 'high' | null>(null);

    useEffect(() => {
        const samplePath = device.samplePath?.trim();
        if (!samplePath) {
            return;
        }
        let cancelled = false;
        engineApi.getWaveformPeaks(samplePath)
            .then((wf) => {
                if (cancelled) return;
                const level = wf.mip_levels[Math.min(2, Math.max(0, wf.mip_levels.length - 1))] ?? wf.mip_levels[0];
                const peaks = (level?.peaks ?? []).map((p) => Math.max(Math.abs(p.min), Math.abs(p.max)));
                setWaveformPeaks(peaks.length > 0 ? peaks : null);
            })
            .catch((err) => {
                if (!cancelled) {
                    console.warn('[DeviceRack] sampler waveform load failed:', err);
                    setWaveformPeaks(null);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [device.samplePath]);

    useEffect(() => {
        if (!dragEqBand) return;
        const onMove = (e: MouseEvent) => {
            const surface = eqSurfaceRef.current;
            if (!surface) return;
            const rect = surface.getBoundingClientRect();
            const xNorm = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
            const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
            const gainValue = ((rect.height / 2 - y) / (rect.height / 2)) * 24;
            const roundedGain = Math.max(-24, Math.min(24, gainValue));
            const lowFreq = 20 + xNorm * (1200 - 20);
            const midFreq = 120 + xNorm * (9000 - 120);
            const highFreq = 1200 + xNorm * (20000 - 1200);
            if (dragEqBand === 'low') {
                onParamChange('Low', roundedGain);
                onParamChange('LowFreq', Math.round(lowFreq));
            }
            if (dragEqBand === 'mid') {
                onParamChange('Mid', roundedGain);
                onParamChange('MidFreq', Math.round(midFreq));
            }
            if (dragEqBand === 'high') {
                onParamChange('High', roundedGain);
                onParamChange('HighFreq', Math.round(highFreq));
            }
        };
        const onUp = () => setDragEqBand(null);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [dragEqBand, onParamChange]);

    if (device.effectType === 'waveSynth') {
        const osc1 = Math.round(device.params.find((x) => x.name.toLowerCase() === 'osc1wave')?.value ?? 0);
        const osc2 = Math.round(device.params.find((x) => x.name.toLowerCase() === 'osc2wave')?.value ?? 0);
        const mix = device.params.find((x) => x.name.toLowerCase() === 'mix')?.value ?? 0.35;
        const detune = device.params.find((x) => x.name.toLowerCase() === 'detune')?.value ?? 0;
        const sub = device.params.find((x) => x.name.toLowerCase() === 'sub')?.value ?? 0;
        const waveforms = [
            { idx: 0, label: 'Sine' },
            { idx: 1, label: 'Triangle' },
            { idx: 2, label: 'Saw' },
            { idx: 3, label: 'Square' },
        ];
        const wavePath = (waveIndex: number) => {
            switch (waveIndex) {
                case 1:
                    return 'M 0 50 L 12.5 20 L 37.5 80 L 62.5 20 L 87.5 80 L 100 50';
                case 2:
                    return 'M 0 70 L 25 30 L 50 70 L 75 30 L 100 70';
                case 3:
                    return 'M 0 70 L 0 30 L 25 30 L 25 70 L 50 70 L 50 30 L 75 30 L 75 70 L 100 70';
                default:
                    return 'M 0 50 C 8 10, 17 10, 25 50 C 33 90, 42 90, 50 50 C 58 10, 67 10, 75 50 C 83 90, 92 90, 100 50';
            }
        };
        const randomizePatch = () => {
            const randomInRange = (min: number, max: number, step = 0.01) => {
                const raw = min + Math.random() * (max - min);
                return Math.round(raw / step) * step;
            };
            onParamChange('Osc1Wave', Math.floor(Math.random() * 4));
            onParamChange('Osc2Wave', Math.floor(Math.random() * 4));
            onParamChange('Mix', randomInRange(0.1, 0.9, 0.01));
            onParamChange('Detune', randomInRange(-18, 18, 0.1));
            onParamChange('Sub', randomInRange(0, 0.5, 0.01));
            onParamChange('Cutoff', randomInRange(200, 8000, 1));
            onParamChange('Res', randomInRange(0, 0.8, 0.01));
            onParamChange('FiltType', Math.floor(Math.random() * 4));
            onParamChange('Vol', randomInRange(0.7, 1.4, 0.01));
            onParamChange('Attack', randomInRange(0.001, 0.18, 0.001));
            onParamChange('Decay', randomInRange(0.03, 1.8, 0.001));
            onParamChange('Sustain', randomInRange(0.25, 1.0, 0.01));
            onParamChange('Release', randomInRange(0.02, 2.2, 0.001));
        };
        return (
            <div style={{ ...pluginPanelLayoutStyle, gridTemplateRows: '126px auto' }}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface-2) 84%, #133026) 0%, color-mix(in srgb, var(--surface-1) 90%, #0a1612) 100%)',
                    display: 'grid',
                    gridTemplateRows: 'auto auto 1fr',
                    gap: 8,
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                        <span style={{ ...pluginPanelTitleStyle, fontSize: 10, color: '#d3efe3' }}>
                            Wave Synth Pro
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 10, color: '#80d7b0', fontFamily: 'var(--font-mono)' }}>
                                OSC Blend {(mix * 100).toFixed(0)}%
                            </span>
                            <button
                                type="button"
                                onClick={randomizePatch}
                                style={{
                                    border: '1px solid #4d7b69',
                                    borderRadius: 4,
                                    background: 'rgba(24, 44, 37, 0.72)',
                                    color: '#c9f7df',
                                    fontSize: 9,
                                    fontWeight: 700,
                                    letterSpacing: '0.03em',
                                    cursor: 'pointer',
                                    padding: '3px 7px',
                                }}
                            >
                                Random
                            </button>
                        </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: 26, opacity: 0.9 }}>
                            <rect x="0" y="0" width="100" height="100" fill="rgba(8, 17, 14, 0.55)" />
                            <path d={wavePath(osc1)} fill="none" stroke="#64e7ad" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: 26, opacity: 0.9 }}>
                            <rect x="0" y="0" width="100" height="100" fill="rgba(8, 17, 14, 0.55)" />
                            <path d={wavePath(osc2)} fill="none" stroke="#8cd1ff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto auto', alignItems: 'center', gap: 6 }}>
                        <div style={{ fontSize: 9, color: '#8fd6b4', fontFamily: 'var(--font-mono)' }}>OSC1 {waveformLabel(osc1)}</div>
                        <div style={{ fontSize: 9, color: '#9bc6ff', fontFamily: 'var(--font-mono)' }}>OSC2 {waveformLabel(osc2)}</div>
                        <div style={{ fontSize: 9, color: '#a4d5c0', fontFamily: 'var(--font-mono)' }}>Detune {detune.toFixed(1)}ct</div>
                        <div style={{ fontSize: 9, color: '#a4d5c0', fontFamily: 'var(--font-mono)' }}>Sub {(sub * 100).toFixed(0)}%</div>
                    </div>
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: 18, opacity: 0.85 }}>
                        <rect x="0" y="0" width="100" height="100" fill="rgba(8, 17, 14, 0.55)" />
                        <path d="M 0 50 C 10 20, 20 80, 30 50 C 40 20, 50 80, 60 50 C 70 20, 80 80, 90 50 C 95 34, 100 60, 100 50" fill="none" stroke="#5be3a7" strokeWidth="2.2" opacity={1 - mix * 0.6} />
                        <path d="M 0 50 C 10 76, 20 24, 30 50 C 40 76, 50 24, 60 50 C 70 76, 80 24, 90 50 C 95 66, 100 40, 100 50" fill="none" stroke="#76baff" strokeWidth="2.2" opacity={0.45 + mix * 0.55} />
                    </svg>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, minmax(0, 1fr))', gap: 6 }}>
                        {waveforms.map((wf) => (
                            <button
                                key={`o1-${wf.idx}`}
                                type="button"
                                onClick={() => onParamChange('Osc1Wave', wf.idx)}
                                style={{
                                    border: wf.idx === osc1 ? '1px solid #5ce0a6' : '1px solid #3e5d53',
                                    borderRadius: 4,
                                    background: wf.idx === osc1 ? 'rgba(92, 224, 166, 0.18)' : 'rgba(24, 44, 37, 0.72)',
                                    color: wf.idx === osc1 ? '#d9ffee' : '#9ac4b2',
                                    fontSize: 10,
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                    padding: '6px 4px',
                                }}
                            >
                                1:{wf.label}
                            </button>
                        ))}
                        {waveforms.map((wf) => (
                            <button
                                key={`o2-${wf.idx}`}
                                type="button"
                                onClick={() => onParamChange('Osc2Wave', wf.idx)}
                                style={{
                                    border: wf.idx === osc2 ? '1px solid #7abfff' : '1px solid #3f5671',
                                    borderRadius: 4,
                                    background: wf.idx === osc2 ? 'rgba(122, 191, 255, 0.18)' : 'rgba(26, 38, 53, 0.72)',
                                    color: wf.idx === osc2 ? '#e2f0ff' : '#a8bfd6',
                                    fontSize: 10,
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                    padding: '6px 4px',
                                }}
                            >
                                2:{wf.label}
                            </button>
                        ))}
                    </div>
                </div>
                <div style={pluginPanelKnobGrid('repeat(10, minmax(0, 1fr))')}>
                    {device.params.map((p) => (
                        <PluginKnob key={p.name} param={p} onChange={onParamChange} compact />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'sampler' || device.effectType === 'instrument') {
        const getParam = (name: string, fallback: string) => {
            const p = device.params.find((x) => x.name.toLowerCase() === name.toLowerCase());
            if (!p) return fallback;
            return `${p.value.toFixed(p.step && p.step < 1 ? 2 : 0)}${p.suffix}`;
        };
        const sampleName = device.samplePath ? device.samplePath.split('/').pop() : null;
        return (
            <div style={{
                display: 'grid',
                gridTemplateRows: '78px auto',
                height: '100%',
                gap: 4,
                border: pluginPanelCardBaseStyle.border,
                borderRadius: 6,
                background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface-3) 84%, #2f4058) 0%, color-mix(in srgb, var(--surface-2) 88%, #1c2735) 100%)',
                overflow: 'hidden',
            }}>
                <div
                    style={{
                        position: 'relative',
                        overflow: 'hidden',
                        borderBottom: '1px solid rgba(90,178,255,0.22)',
                    }}
                    onMouseUp={() => {
                        const dragging = useDragStore.getState().draggingItem;
                        const acceptance = dragging ? canDropInZone(dragging, 'sampler-surface') : { allowed: false };
                        if (dragging?.path && acceptance.allowed) {
                            onDropSample?.(dragging.path);
                            useDragStore.getState().endDrag();
                        }
                    }}
                >
                    <div style={{
                        position: 'absolute',
                        inset: 0,
                        background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface-2) 90%, #0f1622) 0%, color-mix(in srgb, var(--surface-1) 90%, #0a101a) 100%)',
                    }} />
                    <svg
                        viewBox="0 0 1000 90"
                        preserveAspectRatio="none"
                        style={{ position: 'absolute', left: 8, right: 8, top: 20, height: 40, width: 'calc(100% - 16px)' }}
                    >
                        <rect x="0" y="0" width="1000" height="90" fill="color-mix(in srgb, var(--surface-1) 88%, #14213a)" />
                        {Array.from({ length: 18 }).map((_, i) => (
                            <line
                                key={`g-${i}`}
                                x1={(i / 17) * 1000}
                                y1={0}
                                x2={(i / 17) * 1000}
                                y2={90}
                                stroke="rgba(90,178,255,0.12)"
                                strokeWidth="1"
                            />
                        ))}
                        {waveformPeaks ? (
                            Array.from({ length: 220 }).map((_, i) => {
                                const idx = Math.floor((i / 219) * (waveformPeaks.length - 1));
                                const amp = Math.max(0.01, Math.min(1, waveformPeaks[idx] || 0));
                                const h = amp * 40;
                                return (
                                    <line
                                        key={`w-${i}`}
                                        x1={(i / 219) * 1000}
                                        y1={45 - h}
                                        x2={(i / 219) * 1000}
                                        y2={45 + h}
                                        stroke="#ffbf3c"
                                        strokeWidth="1.2"
                                        strokeOpacity="0.94"
                                    />
                                );
                            })
                        ) : (
                            <path
                                d="M 0 46 C 30 14, 60 78, 90 46 C 120 14, 150 78, 180 46 C 210 14, 240 78, 270 46 C 300 14, 330 78, 360 46 C 390 14, 420 78, 450 46 C 480 14, 510 78, 540 46 C 570 18, 600 74, 630 46 C 660 24, 690 68, 720 46 C 750 30, 780 62, 810 46 C 840 36, 870 56, 900 46 C 930 42, 960 50, 1000 46"
                                fill="none"
                                stroke="#ffbf3c"
                                strokeWidth="2.4"
                                strokeLinecap="round"
                            />
                        )}
                    </svg>
                    <div style={{
                        position: 'absolute',
                        left: 8,
                        top: 4,
                        color: '#d7dce7',
                        fontSize: 9,
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                        fontWeight: 700,
                    }}>
                        Sample
                    </div>
                    <div style={{
                        position: 'absolute',
                        left: 8,
                        right: 88,
                        bottom: 3,
                        color: sampleName ? '#9fb6d9' : '#a8b0bd',
                        fontSize: 9,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}>
                        {sampleName ?? 'Drop sample here or load from disk'}
                    </div>
                    <button
                        type="button"
                        onClick={() => onLoadSample?.()}
                        style={{
                            position: 'absolute',
                            right: 8,
                            top: 4,
                            border: '1px solid #4f5968',
                            borderRadius: 3,
                            background: '#293445',
                            color: '#d7e2f2',
                            fontSize: 9,
                            padding: '3px 7px',
                            cursor: 'pointer',
                        }}
                    >
                        Load
                    </button>
                </div>
                <div style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto',
                    gap: 10,
                    alignItems: 'center',
                    padding: '2px 8px 6px 8px',
                    background: 'rgba(16, 20, 28, 0.55)',
                }}>
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                        gap: 6,
                        fontSize: 9,
                        color: '#9fb2cf',
                    }}>
                        <div><div>Attack</div><div style={{ color: '#5ab2ff', fontFamily: 'var(--font-mono)' }}>{getParam('Attack', '0.01s')}</div></div>
                        <div><div>Decay</div><div style={{ color: '#5ab2ff', fontFamily: 'var(--font-mono)' }}>{getParam('Decay', '0.10s')}</div></div>
                        <div><div>Release</div><div style={{ color: '#5ab2ff', fontFamily: 'var(--font-mono)' }}>{getParam('Release', '0.05s')}</div></div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {device.params.slice(0, 6).map((p) => (
                            <PluginKnob key={p.name} param={p} onChange={onParamChange} compact />
                        ))}
                    </div>
                </div>
            </div>
        );
    }

    if (device.effectType === 'eq') {
        const lowFreq = device.params.find((p) => p.name.toLowerCase() === 'lowfreq')?.value ?? 120;
        const low = device.params.find((p) => p.name.toLowerCase() === 'low')?.value ?? 0;
        const midFreq = device.params.find((p) => p.name.toLowerCase() === 'midfreq')?.value ?? 1800;
        const mid = device.params.find((p) => p.name.toLowerCase() === 'mid')?.value ?? 0;
        const highFreq = device.params.find((p) => p.name.toLowerCase() === 'highfreq')?.value ?? 9500;
        const high = device.params.find((p) => p.name.toLowerCase() === 'high')?.value ?? 0;
        const out = device.params.find((p) => p.name.toLowerCase() === 'out')?.value ?? 0;
        const norm = (v: number) => Math.max(-1, Math.min(1, v / 24));
        const normFreq = (freq: number, min: number, max: number) =>
            (Math.log10(Math.max(min, Math.min(max, freq))) - Math.log10(min)) / (Math.log10(max) - Math.log10(min));
        const yFromDb = (v: number) => 46 - norm(v) * 34;
        const xLow = 20 + normFreq(lowFreq, 20, 1200) * 140;
        const xMid = 170 + normFreq(midFreq, 120, 9000) * 150;
        const xHigh = 330 + normFreq(highFreq, 1200, 20000) * 130;
        const yL = yFromDb(low);
        const yM = yFromDb(mid);
        const yH = yFromDb(high);
        const curve = `M 0 ${yL.toFixed(2)} C 40 ${yL.toFixed(2)}, ${xLow - 32} ${yL.toFixed(2)} ${xLow} ${yL.toFixed(2)} C ${xLow + 45} ${yL.toFixed(2)}, ${xMid - 35} ${yM.toFixed(2)} ${xMid} ${yM.toFixed(2)} C ${xMid + 35} ${yM.toFixed(2)}, ${xHigh - 45} ${yH.toFixed(2)} ${xHigh} ${yH.toFixed(2)} C ${xHigh + 35} ${yH.toFixed(2)}, 450 ${yH.toFixed(2)} 480 ${yH.toFixed(2)}`;
        return (
            <div style={{ ...pluginPanelLayoutStyle, gridTemplateRows: '96px auto' }}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'linear-gradient(180deg, var(--surface-1) 0%, color-mix(in srgb, var(--surface-1) 86%, #000) 100%)',
                    overflow: 'hidden',
                    padding: 0,
                }}>
                    <svg ref={eqSurfaceRef} width="100%" height="100%" viewBox="0 0 480 92" preserveAspectRatio="none">
                        {Array.from({ length: 12 }).map((_, i) => (
                            <line key={`vx-${i}`} x1={i * 40} y1={0} x2={i * 40} y2={92} stroke="rgba(90,178,255,0.12)" strokeWidth="1" />
                        ))}
                        {Array.from({ length: 5 }).map((_, i) => (
                            <line key={`hx-${i}`} x1={0} y1={i * 23} x2={480} y2={i * 23} stroke="rgba(90,178,255,0.12)" strokeWidth="1" />
                        ))}
                        <path d={curve} fill="none" stroke="#d9a625" strokeWidth="3" strokeLinecap="round" />
                        <path d={curve} fill="none" stroke="rgba(217,166,37,0.22)" strokeWidth="10" strokeLinecap="round" />
                        <line x1="0" y1="46" x2="480" y2="46" stroke="rgba(90,178,255,0.18)" strokeWidth="1" />
                        {[
                            { key: 'low', x: xLow, y: yL, color: '#5ab2ff' },
                            { key: 'mid', x: xMid, y: yM, color: '#d9a625' },
                            { key: 'high', x: xHigh, y: yH, color: '#ff8b5b' },
                        ].map((band) => (
                            <g
                                key={band.key}
                                style={{ cursor: 'ns-resize' }}
                                onMouseDown={() => setDragEqBand(band.key as 'low' | 'mid' | 'high')}
                            >
                                <circle cx={band.x} cy={band.y} r="9" fill="rgba(0,0,0,0.55)" stroke={band.color} strokeWidth="1.5" />
                                <circle cx={band.x} cy={band.y} r="3.2" fill={band.color} />
                            </g>
                        ))}
                    </svg>
                </div>
                <div style={pluginPanelKnobGrid('repeat(10, minmax(0, 1fr))')}>
                    {['LowFreq', 'Low', 'LowQ', 'MidFreq', 'Mid', 'MidQ', 'HighFreq', 'High', 'HighQ', 'Out'].map((name) => {
                        const p = device.params.find((x) => x.name.toLowerCase() === name.toLowerCase());
                        return p ? <PluginKnob key={p.name} param={p} onChange={onParamChange} compact /> : null;
                    })}
                </div>
                <div style={{ ...pluginPanelMetaStyle, alignItems: 'center' }}>
                    <span>Low {lowFreq.toFixed(0)}Hz</span>
                    <span>Mid {midFreq.toFixed(0)}Hz</span>
                    <span>High {highFreq.toFixed(0)}Hz</span>
                    <span>Out {out.toFixed(1)}dB</span>
                </div>
            </div>
        );
    }

    if (device.effectType === 'utility') {
        const gain = device.params.find((p) => p.name.toLowerCase() === 'gain')?.value ?? 0;
        const pan = device.params.find((p) => p.name.toLowerCase() === 'pan')?.value ?? 0;
        const width = device.params.find((p) => p.name.toLowerCase() === 'width')?.value ?? 100;
        const mono = (device.params.find((p) => p.name.toLowerCase() === 'mono')?.value ?? 0) > 0.5;
        const panPct = Math.max(-1, Math.min(1, pan / 100));
        const widthPct = Math.max(0, Math.min(1, width / 200));
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'linear-gradient(180deg, var(--surface-1) 0%, color-mix(in srgb, var(--surface-1) 88%, #000) 100%)',
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: 10,
                    alignItems: 'center',
                }}>
                    <div>
                        <div style={{ fontSize: 9, color: '#9fa7b5', marginBottom: 4 }}>Pan</div>
                        <div style={{ position: 'relative', height: 8, borderRadius: 999, background: '#2a2a2a' }}>
                            <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.2)' }} />
                            <div style={{
                                position: 'absolute',
                                top: -3,
                                left: `calc(${(panPct * 50 + 50).toFixed(3)}% - 5px)`,
                                width: 10,
                                height: 14,
                                borderRadius: 4,
                                background: '#56a7ff',
                                boxShadow: '0 0 6px rgba(86,167,255,0.45)',
                            }} />
                        </div>
                    </div>
                    <div>
                        <div style={{ fontSize: 9, color: '#9fa7b5', marginBottom: 4 }}>Stereo Width</div>
                        <div style={{ height: 8, borderRadius: 999, background: '#2a2a2a', overflow: 'hidden' }}>
                            <div style={{
                                width: `${(widthPct * 100).toFixed(2)}%`,
                                height: '100%',
                                background: mono ? '#9b9b9b' : 'linear-gradient(90deg, #2aa6ff 0%, #7dd1ff 100%)',
                            }} />
                        </div>
                    </div>
                    <div style={{ ...pluginPanelTitleStyle, color: 'var(--color-text-secondary)' }}>
                        Gain: <span style={{ color: 'var(--color-text-primary)', fontFamily: 'var(--font-mono)' }}>{gain.toFixed(1)} dB</span>
                    </div>
                    <div style={{ ...pluginPanelTitleStyle, color: mono ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)' }}>
                        {mono ? 'Mono Enabled' : 'Stereo'}
                    </div>
                </div>
                <div style={pluginPanelKnobGrid('repeat(4, minmax(0, 1fr))')}>
                    {device.params.slice(0, 4).map((p) => (
                        <PluginKnob key={p.name} param={p} onChange={onParamChange} compact />
                    ))}
                </div>
            </div>
        );
    }

    if (
        device.effectType === 'compressor'
    ) {
        const thr = device.params.find((p) => p.name.toLowerCase() === 'thr')?.value ?? -18;
        const ratio = device.params.find((p) => p.name.toLowerCase() === 'ratio')?.value ?? 4;
        const pseudoGr = Math.max(0, Math.min(24, ((-thr) / 60) * ratio * 2.4));
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'linear-gradient(180deg, var(--surface-1) 0%, color-mix(in srgb, var(--surface-1) 88%, #000) 100%)',
                    display: 'grid',
                    gridTemplateColumns: '1fr auto',
                    gap: 10,
                    alignItems: 'center',
                }}>
                    <svg viewBox="0 0 280 86" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                        <rect x="0" y="0" width="280" height="86" fill="rgba(22,24,30,0.65)" />
                        <path d="M 14 70 L 120 70 Q 170 70 235 20 L 260 20" fill="none" stroke="#6ac3ff" strokeWidth="3" strokeLinecap="round" />
                        <line x1="14" y1="20" x2="14" y2="70" stroke="rgba(255,255,255,0.2)" />
                        <line x1="14" y1="70" x2="260" y2="70" stroke="rgba(255,255,255,0.2)" />
                    </svg>
                    <div style={{ width: 46, height: 72, borderRadius: 4, background: '#1c1f24', border: '1px solid #3d434d', padding: 3 }}>
                        <div style={{ width: '100%', height: `${(pseudoGr / 24) * 100}%`, marginTop: `${100 - (pseudoGr / 24) * 100}%`, background: 'linear-gradient(180deg, #66cc33 0%, #ffcc1a 60%, #ff3333 100%)', borderRadius: 2 }} />
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.max(1, Math.min(4, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 4).map((p) => (
                        <PluginKnob key={p.name} param={p} onChange={onParamChange} compact />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'delay') {
        const time = device.params.find((p) => p.name.toLowerCase() === 'time')?.value ?? 280;
        const fb = device.params.find((p) => p.name.toLowerCase() === 'fb')?.value ?? 30;
        const mix = device.params.find((p) => p.name.toLowerCase() === 'dry/wet')?.value ?? 35;
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'linear-gradient(180deg, #1a2230 0%, #0f1520 100%)',
                }}>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(14,20,30,0.6)" />
                        {Array.from({ length: 8 }).map((_, i) => {
                            const x = 16 + i * 36;
                            const h = 24 * Math.pow((fb / 100), i);
                            return <rect key={i} x={x} y={26 - h / 2} width="10" height={h} fill={i === 0 ? '#7cc4ff' : '#4a9eff'} opacity={0.95 - i * 0.08} rx="1.5" />;
                        })}
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{time.toFixed(0)}ms</span>
                        <span>FB {fb.toFixed(0)}%</span>
                        <span>Mix {mix.toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid('repeat(3, minmax(0, 1fr))')}>
                    {device.params.slice(0, 3).map((p) => (
                        <PluginKnob key={p.name} param={p} onChange={onParamChange} compact />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'reverb') {
        const decay = device.params.find((p) => p.name.toLowerCase() === 'decay')?.value ?? 45;
        const tone = device.params.find((p) => p.name.toLowerCase() === 'tone')?.value ?? 0;
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'radial-gradient(circle at 30% 20%, rgba(137, 89, 194, 0.5) 0%, rgba(28, 24, 38, 0.92) 65%)',
                }}>
                    <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 4, background: 'rgba(10,10,12,0.45)' }}>
                        {Array.from({ length: 5 }).map((_, i) => (
                            <div
                                key={i}
                                style={{
                                    position: 'absolute',
                                    left: `${15 + i * 14}%`,
                                    top: '50%',
                                    width: `${24 + i * 12}px`,
                                    height: `${24 + i * 12}px`,
                                    marginTop: `${-(12 + i * 6)}px`,
                                    borderRadius: '50%',
                                    border: '1px solid rgba(192, 145, 255, 0.35)',
                                }}
                            />
                        ))}
                    </div>
                    <div style={pluginPanelMetaStyle}>
                        <span>Decay {decay.toFixed(0)}%</span>
                        <span>Tone {tone.toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid('repeat(3, minmax(0, 1fr))')}>
                    {device.params.slice(0, 3).map((p) => (
                        <PluginKnob key={p.name} param={p} onChange={onParamChange} compact />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'chorus') {
        const rate = device.params.find((p) => p.name.toLowerCase() === 'rate')?.value ?? 1.2;
        const depth = device.params.find((p) => p.name.toLowerCase() === 'depth')?.value ?? 40;
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'linear-gradient(180deg, #24172a 0%, #14111b 100%)',
                }}>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(12, 11, 18, 0.65)" />
                        <path d="M 0 26 C 40 8, 80 44, 120 26 C 160 8, 200 44, 240 26 C 280 8, 320 44, 320 26" fill="none" stroke="#c867ff" strokeWidth="2.2" />
                        <path d="M 0 26 C 40 44, 80 8, 120 26 C 160 44, 200 8, 240 26 C 280 44, 320 8, 320 26" fill="none" stroke="#4ac0ff" strokeWidth="2.2" opacity="0.9" />
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{rate.toFixed(1)}Hz</span>
                        <span>Depth {depth.toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid('repeat(3, minmax(0, 1fr))')}>
                    {device.params.slice(0, 3).map((p) => (
                        <PluginKnob key={p.name} param={p} onChange={onParamChange} compact />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'saturator') {
        const drive = device.params.find((p) => p.name.toLowerCase() === 'drive')?.value ?? 3;
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'linear-gradient(180deg, #2d1d13 0%, #1a120d 100%)',
                }}>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(20, 13, 9, 0.7)" />
                        <path d="M 12 46 C 72 46, 112 6, 160 6 C 208 6, 248 46, 308 46" fill="none" stroke="#ffac59" strokeWidth={Math.max(2, 2 + drive / 8)} strokeLinecap="round" />
                    </svg>
                    <div style={pluginPanelMetaStyle}><span>Drive {drive.toFixed(1)} dB</span></div>
                </div>
                <div style={pluginPanelKnobGrid('repeat(3, minmax(0, 1fr))')}>
                    {device.params.slice(0, 3).map((p) => (
                        <PluginKnob key={p.name} param={p} onChange={onParamChange} compact />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'limiter') {
        const thr = device.params.find((p) => p.name.toLowerCase() === 'thr')?.value ?? -0.3;
        const ceil = device.params.find((p) => p.name.toLowerCase() === 'ceil')?.value ?? -0.1;
        const safety = Math.max(0, Math.min(1, 1 - Math.abs(thr - ceil) / 30));
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{ ...pluginPanelCardBaseStyle, background: 'linear-gradient(180deg, #152625 0%, #0f1616 100%)' }}>
                    <div style={{ ...pluginPanelTitleStyle, color: '#a4d9d3' }}>Lookahead Limiter</div>
                    <div style={{ height: 10, borderRadius: 999, background: '#222d2e', overflow: 'hidden' }}>
                        <div style={{ width: `${(safety * 100).toFixed(1)}%`, height: '100%', background: 'linear-gradient(90deg, #4bc4b2 0%, #89f0de 100%)' }} />
                    </div>
                    <div style={pluginPanelMetaStyle}>
                        <span>Thr {thr.toFixed(1)} dB</span>
                        <span>Ceil {ceil.toFixed(1)} dB</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid('repeat(3, minmax(0, 1fr))')}>
                    {device.params.slice(0, 3).map((p) => (
                        <PluginKnob key={p.name} param={p} onChange={onParamChange} compact />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'gate') {
        const thr = device.params.find((p) => p.name.toLowerCase() === 'thr')?.value ?? -40;
        const range = device.params.find((p) => p.name.toLowerCase() === 'range')?.value ?? -80;
        const openness = Math.max(0, Math.min(1, (80 + thr) / 80));
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{ ...pluginPanelCardBaseStyle, background: 'linear-gradient(180deg, #1a2415 0%, #101611 100%)' }}>
                    <div style={{ ...pluginPanelTitleStyle, color: '#b8dfad' }}>Noise Gate</div>
                    <div style={{ height: 34, borderRadius: 4, background: '#1b2018', position: 'relative' }}>
                        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(openness * 100).toFixed(1)}%`, background: 'linear-gradient(90deg, #6bc66e 0%, #d2f18b 100%)' }} />
                    </div>
                    <div style={pluginPanelMetaStyle}>
                        <span>Thr {thr.toFixed(1)} dB</span>
                        <span>Range {range.toFixed(1)} dB</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid('repeat(5, minmax(0, 1fr))')}>
                    {device.params.slice(0, 5).map((p) => (
                        <PluginKnob key={p.name} param={p} onChange={onParamChange} compact />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'autoFilter' || device.effectType === 'phaser' || device.effectType === 'flanger') {
        const params = device.params;
        const title = device.effectType === 'autoFilter' ? 'Auto Filter' : device.effectType === 'phaser' ? 'Phaser' : 'Flanger';
        const hue = device.effectType === 'autoFilter' ? '#4cc9d8' : device.effectType === 'phaser' ? '#998bff' : '#66b3ff';
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'linear-gradient(180deg, #151a24 0%, #0f141b 100%)',
                }}>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(8, 10, 14, 0.65)" />
                        <path d="M 0 30 C 32 10, 64 46, 96 26 C 128 6, 160 44, 192 24 C 224 8, 256 42, 288 22 C 304 12, 320 26, 320 26" fill="none" stroke={hue} strokeWidth="2.4" />
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{title}</span>
                        <span style={{ fontFamily: 'var(--font-mono)' }}>{params.length} params</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(6, Math.max(3, params.length))}, minmax(0, 1fr))`)}>
                    {params.slice(0, 6).map((p) => (
                        <PluginKnob key={p.name} param={p} onChange={onParamChange} compact />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'distortion' || device.effectType === 'bitcrusher') {
        const title = device.effectType === 'distortion' ? 'Distortion' : 'Bitcrusher';
        const color = device.effectType === 'distortion' ? '#ff965e' : '#f2de72';
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'linear-gradient(180deg, #261a12 0%, #15100c 100%)',
                }}>
                    <div style={{ ...pluginPanelTitleStyle, color: '#d6c1a5' }}>{title}</div>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: 44 }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(20, 13, 9, 0.65)" />
                        <path d="M 8 44 L 48 12 L 88 44 L 128 12 L 168 44 L 208 12 L 248 44 L 312 16" fill="none" stroke={color} strokeWidth="2.2" />
                    </svg>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(4, Math.max(3, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 4).map((p) => (
                        <PluginKnob key={p.name} param={p} onChange={onParamChange} compact />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'instrument') {
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'linear-gradient(180deg, #16243a 0%, #101726 100%)',
                }}>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(9, 14, 22, 0.75)" />
                        <path d="M 10 48 L 40 10 L 85 26 L 140 26 L 180 14 L 240 20 L 308 48" fill="none" stroke="#64b1ff" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" />
                    </svg>
                    <div style={{ ...pluginPanelMetaStyle, color: '#9cbde2' }}>
                        <span>Core Instrument Controls</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.max(1, Math.min(6, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 6).map((p) => (
                        <PluginKnob key={p.name} param={p} onChange={onParamChange} compact />
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {device.params.map((p) => (
                <PluginKnob key={p.name} param={p} onChange={onParamChange} />
            ))}
        </div>
    );
};

const PluginSettingsPanel = ({
    device,
    onParamChange,
    onLoadSample,
}: {
    device: DeviceSlot;
    onParamChange: (paramName: string, value: number) => void;
    onLoadSample?: () => void;
}) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {device.effectType === 'sampler' && (
            <button
                type="button"
                onClick={() => onLoadSample?.()}
                style={{
                    width: 'fit-content',
                    border: '1px solid var(--color-divider)',
                    borderRadius: 4,
                    background: 'var(--color-bg-header)',
                    color: 'var(--color-text-secondary)',
                    fontSize: 11,
                    padding: '6px 10px',
                    cursor: 'pointer',
                }}
            >
                Load Sample
            </button>
        )}
        <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(180px, 1fr))',
            gap: 10,
        }}>
            {device.params.map((p) => (
                <PluginSlider key={p.name} param={p} onChange={onParamChange} />
            ))}
        </div>
    </div>
);

// ── MeterBar (small vertical signal meter) ──────────────

const MeterBar = ({ level, isInput }: { level: number; isInput?: boolean }) => {
    const h = Math.max(0, Math.min(100, level * 100));
    const meterColor = level > 0.85 ? 'var(--color-meter-clip)' : level > 0.6 ? 'var(--color-meter-hot)' : 'var(--color-meter-normal)';

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            flexShrink: 0,
            alignSelf: 'stretch',
        }}>
            <div style={{
                width: 6,
                flex: 1,
                background: 'var(--color-meter-bg)',
                borderRadius: 1,
                position: 'relative',
                overflow: 'hidden',
            }}>
                <div style={{
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    width: '100%',
                    height: `${h}%`,
                    background: isInput ? 'var(--color-midi-indicator)' : meterColor,
                    borderRadius: 1,
                    transition: 'height 0.08s linear',
                }} />
            </div>
        </div>
    );
};
