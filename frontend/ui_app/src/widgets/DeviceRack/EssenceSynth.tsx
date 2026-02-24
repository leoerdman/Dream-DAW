import { useMemo, useCallback } from 'react';
import { PluginKnob, type PluginParam } from './StandardPluginControls';
import { waveformLabel } from '@/shared/lib/internalPlugins';
import {
    buildAdsrPath,
    FILTER_TYPES,
    LFO_TARGETS,
    PRESETS,
    WAVEFORMS,
    wavePath,
} from './EssenceSynth.config';
import { applyEssencePreset, randomizeEssenceSynth } from './EssenceSynth.actions';
import './EssenceSynth.css';
const BOTTOM_KNOB_NAMES = ['osc1vol', 'osc2vol', 'detune', 'sub', 'cutoff', 'res', 'vol', 'attack', 'decay', 'sustain', 'release', 'pulsewidth'] as const;
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
            osc1Enabled: v('osc1enabled', 1) >= 0.5,
            osc2Enabled: v('osc2enabled', 0) >= 0.5,
            osc1Vol: v('osc1vol', 1.0),
            osc2Vol: v('osc2vol', 0.7),
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
    const clampToParam = useCallback((name: string, value: number): number => {
        const pp = findParam(name);
        if (!pp) return value;
        return Math.max(pp.min, Math.min(pp.max, value));
    }, [findParam]);
    const applyPreset = useCallback((presetId: string) => {
        applyEssencePreset(presetId, onParamChange, clampToParam);
    }, [onParamChange, clampToParam]);
    const randomize = useCallback(() => {
        randomizeEssenceSynth(onParamChange, clampToParam);
    }, [onParamChange, clampToParam]);
    const adsrPath = useMemo(
        () => buildAdsrPath(p.attack, p.decay, p.sustain, p.release),
        [p.attack, p.decay, p.sustain, p.release],
    );
    const bottomKnobs = useMemo(
        () => BOTTOM_KNOB_NAMES
            .map(n => findParam(n))
            .filter((pp): pp is PluginParam => pp !== null),
        [params],
    );
    return (
        <div className="essence" data-no-drag>
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
                        <div className={`essence__osc-block ${!p.osc1Enabled ? 'essence__osc-block--disabled' : ''}`}>
                            <div className="essence__osc-header">
                                <button
                                    type="button"
                                    className={`essence__osc-toggle ${p.osc1Enabled ? 'essence__osc-toggle--on' : ''}`}
                                    onClick={() => onParamChange('Osc1Enabled', p.osc1Enabled ? 0 : 1)}
                                    title={p.osc1Enabled ? 'Disable OSC 1' : 'Enable OSC 1'}
                                />
                                <span className="essence__osc-label essence__osc-label--1">
                                    OSC 1 · {waveformLabel(p.osc1)}
                                </span>
                            </div>
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
                                        disabled={!p.osc1Enabled}
                                    >
                                        {wf.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        {/* OSC 2 */}
                        <div className={`essence__osc-block ${!p.osc2Enabled ? 'essence__osc-block--disabled' : ''}`}>
                            <div className="essence__osc-header">
                                <button
                                    type="button"
                                    className={`essence__osc-toggle ${p.osc2Enabled ? 'essence__osc-toggle--on' : ''}`}
                                    onClick={() => onParamChange('Osc2Enabled', p.osc2Enabled ? 0 : 1)}
                                    title={p.osc2Enabled ? 'Disable OSC 2' : 'Enable OSC 2'}
                                />
                                <span className="essence__osc-label essence__osc-label--2">
                                    OSC 2 · {waveformLabel(p.osc2)}
                                </span>
                            </div>
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
                                        disabled={!p.osc2Enabled}
                                    >
                                        {wf.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                    {/* Per-oscillator volume bars */}
                    <div className="essence__osc-vol-row">
                        <div className="essence__osc-vol-block">
                            <span className="essence__osc-vol-label essence__osc-vol-label--1">OSC 1 Vol</span>
                            <div className="essence__vol-bar">
                                <div className="essence__vol-fill essence__vol-fill--1" style={{ width: `${p.osc1Vol * 100}%` }} />
                            </div>
                            <span className="essence__param-value">{(p.osc1Vol * 100).toFixed(0)}%</span>
                        </div>
                        <div className="essence__osc-vol-block">
                            <span className="essence__osc-vol-label essence__osc-vol-label--2">OSC 2 Vol</span>
                            <div className="essence__vol-bar">
                                <div className="essence__vol-fill essence__vol-fill--2" style={{ width: `${p.osc2Vol * 100}%` }} />
                            </div>
                            <span className="essence__param-value">{(p.osc2Vol * 100).toFixed(0)}%</span>
                        </div>
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
