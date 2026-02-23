import { useMemo, useCallback } from 'react';
import { PluginKnob, type PluginParam } from './StandardPluginControls';
import { waveformLabel } from '@/shared/lib/internalPlugins';
import {
    buildAdsrPath,
    FILTER_TYPES,
    LFO_TARGETS,
    PRESETS,
    PRESET_VALUES,
    WAVEFORMS,
    wavePath,
} from './EssenceSynth.config';
import './EssenceSynth.css';

interface EssenceSynthProps {
    params: PluginParam[];
    onParamChange: (paramName: string, value: number) => void;
    onParamGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onParamGestureEnd?: (paramName: string) => void;
}

export const EssenceSynth = ({
    params,
    onParamChange,
    onParamGestureStart,
    onParamGestureEnd,
}: EssenceSynthProps) => {
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

    const findParam = useCallback((name: string): PluginParam | null => {
        return params.find(pp => pp.name.toLowerCase() === name.toLowerCase()) ?? null;
    }, [params]);

    const applyPreset = useCallback((presetId: string) => {
        const values = PRESET_VALUES[presetId];
        if (!values) return;
        for (const [name, value] of Object.entries(values)) {
            onParamChange(name, value);
        }
    }, [onParamChange]);

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

    const adsrPath = useMemo(
        () => buildAdsrPath(p.attack, p.decay, p.sustain, p.release),
        [p.attack, p.decay, p.sustain, p.release],
    );

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
                                <path d={wavePath(p.osc1)} fill="none" stroke="var(--token-color-hex-64e7ad)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
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
                                <path d={wavePath(p.osc2)} fill="none" stroke="var(--token-color-hex-8cd1ff)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
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
                        <path d={adsrPath} fill="none" stroke="var(--token-color-hex-5be3a7)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        <path d={adsrPath} fill="var(--token-color-rgba-91-227-167-0d08)" />
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
