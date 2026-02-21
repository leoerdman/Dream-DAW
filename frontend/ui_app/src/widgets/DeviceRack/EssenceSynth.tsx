/**
 * Essence — Premium block-based wavetable synthesizer UI.
 *
 * Extracted from inline DeviceRack rendering into a dedicated component
 * with professional DAW-grade layout — OSC / Filter+Env / LFO+Master blocks,
 * live ADSR visualization, waveform toggle buttons, and full DSP param exposure.
 */

import { useMemo, useCallback } from 'react';
import { PluginKnob, type PluginParam } from './StandardPluginControls';
import { waveformLabel } from '@/shared/lib/internalPlugins';
import './EssenceSynth.css';

/* ── Types ───────────────────────────────────────────────────────── */

interface EssenceSynthProps {
    params: PluginParam[];
    onParamChange: (paramName: string, value: number) => void;
    onParamGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onParamGestureEnd?: (paramName: string) => void;
}

/* ── Helpers ─────────────────────────────────────────────────────── */

const WAVEFORMS = [
    { idx: 0, label: 'Sin', icon: '~' },
    { idx: 1, label: 'Tri', icon: '△' },
    { idx: 2, label: 'Saw', icon: '⬧' },
    { idx: 3, label: 'Sqr', icon: '□' },
] as const;

const FILTER_TYPES = [
    { idx: 0, label: 'LP' },
    { idx: 1, label: 'HP' },
    { idx: 2, label: 'BP' },
    { idx: 3, label: 'NT' },
] as const;

const LFO_TARGETS = [
    { idx: 0, label: 'Filter' },
    { idx: 1, label: 'Pitch' },
    { idx: 2, label: 'Volume' },
] as const;

const PRESETS = [
    { id: 'init', label: 'INIT' },
    { id: 'bass', label: 'BASS' },
    { id: 'lead', label: 'LEAD' },
    { id: 'pad', label: 'PAD' },
    { id: 'pluck', label: 'PLUCK' },
] as const;

const wavePath = (waveIndex: number): string => {
    switch (waveIndex) {
        case 1: return 'M 0 50 L 12.5 20 L 37.5 80 L 62.5 20 L 87.5 80 L 100 50';
        case 2: return 'M 0 70 L 25 30 L 50 70 L 75 30 L 100 70';
        case 3: return 'M 0 70 L 0 30 L 25 30 L 25 70 L 50 70 L 50 30 L 75 30 L 75 70 L 100 70';
        default: return 'M 0 50 C 8 10, 17 10, 25 50 C 33 90, 42 90, 50 50 C 58 10, 67 10, 75 50 C 83 90, 92 90, 100 50';
    }
};

/* ── Preset macro values ────────────────────────────────────────── */

const PRESET_VALUES: Record<string, Record<string, number>> = {
    init: {
        Osc1Wave: 0, Osc2Wave: 2, Mix: 0.35, Detune: 0, Sub: 0,
        Cutoff: 20000, Res: 0, FiltType: 0, Vol: 1,
        Attack: 0.01, Decay: 0.1, Sustain: 1, Release: 0.05,
        LfoRate: 1, LfoDepth: 0, LfoTarget: 0, PulseWidth: 0.5,
    },
    bass: {
        Osc1Wave: 2, Osc2Wave: 3, Mix: 0.58, Detune: -4.8, Sub: 0.42,
        Cutoff: 980, Res: 0.26, FiltType: 0, Vol: 1.18,
        Attack: 0.004, Decay: 0.2, Sustain: 0.62, Release: 0.16,
        LfoRate: 0.8, LfoDepth: 0.15, LfoTarget: 0, PulseWidth: 0.5,
    },
    lead: {
        Osc1Wave: 3, Osc2Wave: 2, Mix: 0.45, Detune: 8.5, Sub: 0.12,
        Cutoff: 5200, Res: 0.34, FiltType: 1, Vol: 1.05,
        Attack: 0.006, Decay: 0.22, Sustain: 0.7, Release: 0.28,
        LfoRate: 4.5, LfoDepth: 0.1, LfoTarget: 1, PulseWidth: 0.5,
    },
    pad: {
        Osc1Wave: 1, Osc2Wave: 0, Mix: 0.63, Detune: 13.2, Sub: 0.18,
        Cutoff: 2600, Res: 0.2, FiltType: 0, Vol: 0.92,
        Attack: 0.42, Decay: 0.72, Sustain: 0.84, Release: 1.6,
        LfoRate: 0.3, LfoDepth: 0.2, LfoTarget: 0, PulseWidth: 0.5,
    },
    pluck: {
        Osc1Wave: 2, Osc2Wave: 3, Mix: 0.2, Detune: 2.4, Sub: 0.06,
        Cutoff: 1800, Res: 0.62, FiltType: 0, Vol: 1.08,
        Attack: 0.001, Decay: 0.09, Sustain: 0.18, Release: 0.14,
        LfoRate: 1, LfoDepth: 0, LfoTarget: 0, PulseWidth: 0.5,
    },
};

/* ── ADSR SVG Path ──────────────────────────────────────────────── */

function buildAdsrPath(a: number, d: number, s: number, r: number): string {
    const W = 120;
    const H = 28;
    const PAD = 2;
    const usable = W - PAD * 2;
    const top = PAD + 2;
    const bottom = H - PAD;
    const range = bottom - top;

    // Normalize durations to fit the visual
    const totalTime = Math.max(0.01, a + d + r + 0.3); // +0.3 for sustain hold
    const aW = (a / totalTime) * usable * 0.8;
    const dW = (d / totalTime) * usable * 0.8;
    const sW = usable * 0.15; // fixed sustain section
    const rW = Math.min(usable - aW - dW - sW, (r / totalTime) * usable * 0.8);

    const x0 = PAD;
    const x1 = x0 + aW;
    const x2 = x1 + dW;
    const x3 = x2 + sW;
    const x4 = x3 + rW;

    const yTop = top;
    const ySustain = bottom - s * range;
    const yBottom = bottom;

    return `M ${x0} ${yBottom} L ${x1} ${yTop} L ${x2} ${ySustain} L ${x3} ${ySustain} L ${x4} ${yBottom}`;
}

/* ── Component ──────────────────────────────────────────────────── */

export const EssenceSynth = ({
    params,
    onParamChange,
    onParamGestureStart,
    onParamGestureEnd,
}: EssenceSynthProps) => {
    /* ── Read param values ───────────────────────────────────────── */
    const p = useMemo(() => {
        const map = new Map(params.map(pp => [pp.name.toLowerCase(), pp]));
        const v = (name: string, fallback: number) => map.get(name.toLowerCase())?.value ?? fallback;
        return {
            osc1: Math.round(v('osc1wave', 0)),
            osc2: Math.round(v('osc2wave', 0)),
            mix: v('mix', 0.35),
            detune: v('detune', 0),
            sub: v('sub', 0),
            cutoff: v('cutoff', 20000),
            res: v('res', 0),
            filtType: Math.round(v('filttype', 0)),
            vol: v('vol', 1),
            attack: v('attack', 0.01),
            decay: v('decay', 0.1),
            sustain: v('sustain', 1),
            release: v('release', 0.05),
            lfoRate: v('lforate', 1),
            lfoDepth: v('lfodepth', 0),
            lfoTarget: Math.round(v('lfotarget', 0)),
            pulseWidth: v('pulsewidth', 0.5),
        };
    }, [params]);

    /* ── Find specific param objects for knobs ───────────────────── */
    const findParam = useCallback((name: string): PluginParam | null => {
        return params.find(pp => pp.name.toLowerCase() === name.toLowerCase()) ?? null;
    }, [params]);

    /* ── Preset application ─────────────────────────────────────── */
    const applyPreset = useCallback((presetId: string) => {
        const values = PRESET_VALUES[presetId];
        if (!values) return;
        for (const [name, value] of Object.entries(values)) {
            onParamChange(name, value);
        }
    }, [onParamChange]);

    /* ── Randomize ──────────────────────────────────────────────── */
    const randomize = useCallback(() => {
        const r = (min: number, max: number, step = 0.01) => {
            const raw = min + Math.random() * (max - min);
            return Math.round(raw / step) * step;
        };
        onParamChange('Osc1Wave', Math.floor(Math.random() * 4));
        onParamChange('Osc2Wave', Math.floor(Math.random() * 4));
        onParamChange('Mix', r(0.1, 0.9));
        onParamChange('Detune', r(-18, 18, 0.1));
        onParamChange('Sub', r(0, 0.5));
        onParamChange('Cutoff', r(200, 8000, 1));
        onParamChange('Res', r(0, 0.8));
        onParamChange('FiltType', Math.floor(Math.random() * 4));
        onParamChange('Vol', r(0.7, 1.4));
        onParamChange('Attack', r(0.001, 0.18, 0.001));
        onParamChange('Decay', r(0.03, 1.8, 0.001));
        onParamChange('Sustain', r(0.25, 1.0));
        onParamChange('Release', r(0.02, 2.2, 0.001));
        onParamChange('LfoRate', r(0.1, 12, 0.1));
        onParamChange('LfoDepth', r(0, 0.6));
        onParamChange('LfoTarget', Math.floor(Math.random() * 3));
        onParamChange('PulseWidth', r(0.1, 0.9, 0.01));
    }, [onParamChange]);

    /* ── ADSR SVG path ──────────────────────────────────────────── */
    const adsrPath = useMemo(
        () => buildAdsrPath(p.attack, p.decay, p.sustain, p.release),
        [p.attack, p.decay, p.sustain, p.release],
    );

    /* ── Param knobs (filtered for bottom strip) ────────────────── */
    const bottomKnobNames = ['osc1wave', 'osc2wave', 'mix', 'detune', 'sub', 'cutoff', 'res', 'vol', 'attack', 'decay', 'sustain', 'release'];
    const bottomKnobs = useMemo(
        () => bottomKnobNames
            .map(n => findParam(n))
            .filter((pp): pp is PluginParam => pp !== null),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [params],
    );

    return (
        <div className="essence">
            {/* ── Header ──────────────────────────────────────── */}
            <div className="essence__header">
                <span className="essence__title">Essence</span>
                <div className="essence__presets">
                    {PRESETS.map(pr => (
                        <button
                            key={pr.id}
                            type="button"
                            className="essence__preset-btn"
                            onClick={() => applyPreset(pr.id)}
                        >
                            {pr.label}
                        </button>
                    ))}
                    <button type="button" className="essence__random-btn" onClick={randomize}>
                        🎲
                    </button>
                </div>
            </div>

            {/* ── Body: 3 column block grid ───────────────────── */}
            <div className="essence__body">
                {/* ═══ Column 1: Oscillators ═══ */}
                <div className="essence__section">
                    <span className="essence__section-label">Oscillators</span>
                    <div className="essence__osc-row">
                        {/* OSC 1 */}
                        <div className="essence__osc-block">
                            <span className="essence__osc-label essence__osc-label--1">
                                OSC 1 · {waveformLabel(p.osc1)}
                            </span>
                            <svg className="essence__wave-display" viewBox="0 0 100 100" preserveAspectRatio="none">
                                <path d={wavePath(p.osc1)} fill="none" stroke="#64e7ad" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            <div className="essence__wave-btns">
                                {WAVEFORMS.map(wf => (
                                    <button
                                        key={`o1-${wf.idx}`}
                                        type="button"
                                        className={`essence__wave-btn ${wf.idx === p.osc1 ? 'essence__wave-btn--active-1' : ''}`}
                                        onClick={() => onParamChange('Osc1Wave', wf.idx)}
                                    >
                                        {wf.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        {/* OSC 2 */}
                        <div className="essence__osc-block">
                            <span className="essence__osc-label essence__osc-label--2">
                                OSC 2 · {waveformLabel(p.osc2)}
                            </span>
                            <svg className="essence__wave-display" viewBox="0 0 100 100" preserveAspectRatio="none">
                                <path d={wavePath(p.osc2)} fill="none" stroke="#8cd1ff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            <div className="essence__wave-btns">
                                {WAVEFORMS.map(wf => (
                                    <button
                                        key={`o2-${wf.idx}`}
                                        type="button"
                                        className={`essence__wave-btn ${wf.idx === p.osc2 ? 'essence__wave-btn--active-2' : ''}`}
                                        onClick={() => onParamChange('Osc2Wave', wf.idx)}
                                    >
                                        {wf.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                    {/* Blend bar */}
                    <div className="essence__blend-bar">
                        <div className="essence__blend-fill essence__blend-fill--1" style={{ width: `${(1 - p.mix) * 100}%` }} />
                        <div className="essence__blend-fill essence__blend-fill--2" style={{ width: `${p.mix * 100}%` }} />
                    </div>
                    <div className="essence__param-row">
                        <span className="essence__param-label">Blend</span>
                        <span className="essence__param-value">{(p.mix * 100).toFixed(0)}%</span>
                    </div>
                    <div className="essence__param-row">
                        <span className="essence__param-label">Detune</span>
                        <span className="essence__param-value">{p.detune.toFixed(1)}ct</span>
                    </div>
                    <div className="essence__param-row">
                        <span className="essence__param-label">Sub</span>
                        <span className="essence__param-value">{(p.sub * 100).toFixed(0)}%</span>
                    </div>
                    <div className="essence__param-row">
                        <span className="essence__param-label">PW</span>
                        <span className="essence__param-value">{(p.pulseWidth * 100).toFixed(0)}%</span>
                    </div>
                </div>

                {/* ═══ Column 2: Filter + Envelope ═══ */}
                <div className="essence__section">
                    <span className="essence__section-label">Filter</span>
                    <div className="essence__filt-types">
                        {FILTER_TYPES.map(ft => (
                            <button
                                key={ft.idx}
                                type="button"
                                className={`essence__filt-btn ${ft.idx === p.filtType ? 'essence__filt-btn--active' : ''}`}
                                onClick={() => onParamChange('FiltType', ft.idx)}
                            >
                                {ft.label}
                            </button>
                        ))}
                    </div>
                    <div className="essence__param-row">
                        <span className="essence__param-label">Cutoff</span>
                        <span className="essence__param-value">
                            {p.cutoff >= 1000 ? `${(p.cutoff / 1000).toFixed(1)}k` : `${Math.round(p.cutoff)}`} Hz
                        </span>
                    </div>
                    <div className="essence__param-row">
                        <span className="essence__param-label">Res</span>
                        <span className="essence__param-value">{(p.res * 100).toFixed(0)}%</span>
                    </div>

                    <span className="essence__section-label" style={{ marginTop: 4 }}>Envelope</span>
                    <svg className="essence__adsr-graph" viewBox="0 0 120 28" preserveAspectRatio="none">
                        <path d={adsrPath} fill="none" stroke="#5be3a7" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        <path d={adsrPath} fill="rgba(91, 227, 167, 0.08)" />
                    </svg>
                    <div className="essence__param-row">
                        <span className="essence__param-label">A</span>
                        <span className="essence__param-value">{p.attack < 0.1 ? `${(p.attack * 1000).toFixed(0)}ms` : `${p.attack.toFixed(2)}s`}</span>
                    </div>
                    <div className="essence__param-row">
                        <span className="essence__param-label">D</span>
                        <span className="essence__param-value">{p.decay < 0.1 ? `${(p.decay * 1000).toFixed(0)}ms` : `${p.decay.toFixed(2)}s`}</span>
                    </div>
                    <div className="essence__param-row">
                        <span className="essence__param-label">S</span>
                        <span className="essence__param-value">{(p.sustain * 100).toFixed(0)}%</span>
                    </div>
                    <div className="essence__param-row">
                        <span className="essence__param-label">R</span>
                        <span className="essence__param-value">{p.release < 0.1 ? `${(p.release * 1000).toFixed(0)}ms` : `${p.release.toFixed(2)}s`}</span>
                    </div>
                </div>

                {/* ═══ Column 3: LFO + Master ═══ */}
                <div className="essence__section" style={{ borderRight: 'none' }}>
                    <span className="essence__section-label">LFO</span>
                    <div className="essence__lfo-targets">
                        {LFO_TARGETS.map(lt => (
                            <button
                                key={lt.idx}
                                type="button"
                                className={`essence__lfo-btn ${lt.idx === p.lfoTarget ? 'essence__lfo-btn--active' : ''}`}
                                onClick={() => onParamChange('LfoTarget', lt.idx)}
                            >
                                {lt.label}
                            </button>
                        ))}
                    </div>
                    <div className="essence__param-row">
                        <span className="essence__param-label">Rate</span>
                        <span className="essence__param-value">{p.lfoRate.toFixed(1)} Hz</span>
                    </div>
                    <div className="essence__param-row">
                        <span className="essence__param-label">Depth</span>
                        <span className="essence__param-value">{(p.lfoDepth * 100).toFixed(0)}%</span>
                    </div>

                    <span className="essence__section-label" style={{ marginTop: 6 }}>Master</span>
                    <div className="essence__param-row">
                        <span className="essence__param-label">Volume</span>
                        <span className="essence__param-value">{(p.vol * 100).toFixed(0)}%</span>
                    </div>
                </div>
            </div>

            {/* ── Bottom: Knob strip ─────────────────────────── */}
            <div className="essence__knobs">
                {bottomKnobs.map(pp => (
                    <PluginKnob
                        key={pp.name}
                        param={pp}
                        onChange={onParamChange}
                        onGestureStart={onParamGestureStart}
                        onGestureEnd={onParamGestureEnd}
                        compact
                    />
                ))}
            </div>
        </div>
    );
};
