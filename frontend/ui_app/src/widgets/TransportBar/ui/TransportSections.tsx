import React from 'react';
import { ArrowRight, Bot, Circle, Eye, EyeOff, Music, Pencil, Play, Rewind, RotateCcw, Settings, Square } from 'lucide-react';
import { beatToFrame, resolveSampleRate } from '@/shared/lib/audioMath';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { KEY_MODES, KEY_TONICS } from '../model/transportBarDomain';
import { ControlButton, PillSection, TransportBtn } from './TransportAtoms';

export function TransportLeftSection(props: {
    handleTapTempo: () => void;
    bpmEditing: boolean;
    bpmText: string;
    setBpmText: (text: string) => void;
    commitBpm: () => void;
    setBpmEditing: (next: boolean) => void;
    bpm: number;
    bpmRef: React.RefObject<HTMLInputElement>;
    valueChipStyle: React.CSSProperties;
    cycleTimeSignature: () => void;
    timeSigNum: number;
    timeSigDen: number;
    keyEnabled: boolean;
    keyTonic: number;
    keyMode: number;
    cycleKeyTonic: () => void;
    cycleKeyMode: () => void;
}) {
    const { handleTapTempo, bpmEditing, bpmText, setBpmText, commitBpm, setBpmEditing, bpm, bpmRef, valueChipStyle, cycleTimeSignature, timeSigNum, timeSigDen, keyEnabled, keyTonic, keyMode, cycleKeyTonic, cycleKeyMode } = props;
    return (
        <div style={{ display: 'flex', alignItems: 'center' }}>
            <PillSection>
                <ControlButton label="Tap" onClick={handleTapTempo} />
                {bpmEditing ? (
                    <input ref={bpmRef} type="text" value={bpmText} onChange={(e) => setBpmText(e.target.value)} onBlur={commitBpm} onKeyDown={(e) => e.key === 'Enter' && commitBpm()} autoFocus style={{ width: 56, background: valueChipStyle.background, color: 'var(--color-text-primary)', border: '1px solid var(--color-accent-primary)', borderRadius: 'var(--radius-xs)', fontFamily: valueChipStyle.fontFamily, fontSize: valueChipStyle.fontSize, fontWeight: valueChipStyle.fontWeight, textAlign: 'center', padding: '2px 6px', outline: 'none' }} />
                ) : (
                    <button onClick={() => { setBpmEditing(true); setBpmText(bpm.toFixed(2)); }} style={valueChipStyle}>{bpm.toFixed(2)}</button>
                )}
                <button onClick={cycleTimeSignature} style={valueChipStyle} title="Time Signature">{timeSigNum}<span style={{ color: 'var(--color-text-secondary)', margin: '0 1px' }}>/</span>{timeSigDen}</button>
            </PillSection>
            <PillSection>
                <TransportBtn
                    icon={<Music size={13} fill={keyEnabled ? 'currentColor' : 'none'} />}
                    title="Enable Key"
                    isActive={keyEnabled}
                    activeColor="var(--color-accent-primary)"
                    onClick={() => {
                        const next = !keyEnabled;
                        void engineApi.setKeySignatureWithDeltas(next, KEY_TONICS[keyTonic], KEY_MODES[keyMode]).then((response) => useEngineStore.getState().applyProjectDeltas(response.deltas, 'transport:key-enabled'));
                    }}
                />
                <ControlButton label={KEY_TONICS[keyTonic]} onClick={cycleKeyTonic} />
                <ControlButton label={KEY_MODES[keyMode]} onClick={cycleKeyMode} />
            </PillSection>
        </div>
    );
}

export function TransportCenterSection(props: {
    isPlaying: boolean;
    togglePlay: () => void;
    engineStop: () => void;
    isRecording: boolean;
    handleRecordToggle: () => Promise<void>;
    stopRecordingIfNeeded: () => Promise<void>;
    isLooping: boolean;
    loopStartFrames: number;
    loopEndFrames: number;
    sampleRate: number;
    bpm: number;
    posBeats: number;
    timeSigNum: number;
    engineSetLoop: (enabled: boolean, start: number, end: number) => Promise<void>;
    followPlayhead: boolean;
    onFollowPlayheadChange?: (enabled: boolean) => void;
    pianoPencilMode: boolean;
    togglePianoPencilMode: () => void;
    automationVisible: boolean;
    onAutomationToggle?: () => void;
    onFitTimelineHorizontally?: () => void;
    onResetTrackHeights?: () => void;
    posString: string;
    valueChipStyle: React.CSSProperties;
}) {
    const p = props;
    return (
        <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)' }}>
            <PillSection>
                <TransportBtn icon={<Rewind size={13} fill="currentColor" />} title="Rewind to Start" onClick={() => { void engineApi.seekToBeat(0); }} />
                <TransportBtn icon={<Play size={13} fill="currentColor" />} title="Play" isActive={p.isPlaying} activeColor="var(--color-status-success)" activeBackground={false} onClick={() => { void engineApi.stopPreview().catch((err) => console.warn('[TransportBar] stopPreview before play failed:', err)); p.togglePlay(); }} />
                <TransportBtn icon={<Square size={13} fill="currentColor" />} title="Stop" onClick={() => { p.engineStop(); void p.stopRecordingIfNeeded(); }} />
                <TransportBtn icon={<Circle size={12} fill="currentColor" />} title="Record" isActive={p.isRecording} activeColor="var(--color-status-record)" className={p.isRecording ? 'animate-pulse-record' : ''} onClick={() => { void p.handleRecordToggle(); }} />
                <TransportBtn icon={<RotateCcw size={13} />} title="Toggle Loop" isActive={p.isLooping} activeColor="var(--color-accent-primary)" onClick={() => { const next = !p.isLooping; if (next && p.loopStartFrames === 0 && p.loopEndFrames === 0) { const sr = resolveSampleRate(p.sampleRate); const currentBpm = p.bpm || 120; void p.engineSetLoop(true, beatToFrame(p.posBeats, currentBpm, sr), beatToFrame(p.posBeats + p.timeSigNum, currentBpm, sr)); } else { void p.engineSetLoop(next, p.loopStartFrames, p.loopEndFrames); } }} />
                <TransportBtn icon={<ArrowRight size={13} strokeWidth={p.followPlayhead ? 3 : 2} />} title="Follow Playhead" isActive={p.followPlayhead} activeColor="var(--color-accent-primary)" onClick={() => p.onFollowPlayheadChange?.(!p.followPlayhead)} />
                <TransportBtn icon={<Pencil size={13} />} title="Pencil Mode" isActive={p.pianoPencilMode} activeColor="var(--color-accent-primary)" onClick={p.togglePianoPencilMode} />
                <TransportBtn icon={<svg width={13} height={13} viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" /><text x="8" y="12" textAnchor="middle" fill="currentColor" fontSize="10" fontWeight="700" fontFamily="system-ui">A</text></svg>} title="Automation (A)" isActive={p.automationVisible} activeColor="var(--color-accent-primary)" onClick={() => p.onAutomationToggle?.()} />
                <ControlButton label="W" onClick={() => p.onFitTimelineHorizontally?.()} />
                <ControlButton label="H" onClick={() => p.onResetTrackHeights?.()} />
                <span style={{ ...p.valueChipStyle, minWidth: 74, textAlign: 'right', display: 'inline-block', cursor: 'default' }}>{p.posString}</span>
            </PillSection>
        </div>
    );
}

export function TransportRightSection(props: {
    onOpenExport?: () => void;
    midiLedRef: React.RefObject<HTMLSpanElement>;
    trackCount: number;
    pdcOpen: boolean;
    setPdcOpen: (next: boolean | ((prev: boolean) => boolean) ) => void;
    assistantOpen: boolean;
    onAssistantToggle?: () => void;
    onSettingsClick?: () => void;
}) {
    const { onOpenExport, midiLedRef, trackCount, pdcOpen, setPdcOpen, assistantOpen, onAssistantToggle, onSettingsClick } = props;
    return (
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
            <PillSection>
                <ControlButton label="Bounce" onClick={() => onOpenExport?.()} />
                <span ref={midiLedRef} style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-status-success)', opacity: 0.35, boxShadow: '0 0 8px color-mix(in srgb, var(--color-status-success) 75%, transparent)', transition: 'opacity 40ms linear' }} />
                <span style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--font-weight-semibold)' as unknown as number, color: 'var(--color-midi-indicator)' }}>MIDI</span>
                <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{trackCount} Tracks</span>
                <button onClick={() => setPdcOpen((v) => !v)} title="Debug Panel" style={iconBtnStyle(pdcOpen ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)', pdcOpen ? 'color-mix(in srgb, var(--color-accent-primary) 14%, transparent)' : 'transparent')}>{pdcOpen ? <EyeOff size={15} /> : <Eye size={15} />}</button>
                <button onClick={() => onAssistantToggle?.()} title="AI Assistant" style={iconBtnStyle(assistantOpen ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)', assistantOpen ? 'color-mix(in srgb, var(--color-accent-primary) 14%, transparent)' : 'transparent')}><Bot size={15} /></button>
                <button onClick={onSettingsClick} title="Settings (⌘,)" style={iconBtnStyle('var(--color-text-secondary)', 'transparent')}><Settings size={15} /></button>
            </PillSection>
        </div>
    );
}

const iconBtnStyle = (color: string, background: string): React.CSSProperties => ({
    width: 24,
    height: 24,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background,
    border: 'none',
    borderRadius: 'var(--radius-xs)',
    color,
    cursor: 'pointer',
});

