import React from 'react';
import { ArrowRight, Bot, Circle, Eye, EyeOff, Music, Pencil, Play, Rewind, RotateCcw, Settings, Square } from 'lucide-react';
import { beatToFrame, resolveSampleRate } from '@/shared/lib/audioMath';
import { ALL_DIVISIONS, type GridDivision } from '@/shared/lib/gridSnap';
import * as engineApi from '@/shared/api/engine';
import { KEY_MODES, KEY_TONICS } from '../model/transportBarDomain';
import { ControlButton, PillSection, TRANSPORT_UI, TransportBtn } from './TransportAtoms';

export function TransportLeftSection(props: {
    handleTapTempo: () => void;
    bpmEditing: boolean;
    bpmText: string;
    setBpmText: (text: string) => void;
    commitBpm: () => void;
    setBpmEditing: (next: boolean) => void;
    bpm: number;
    bpmRef: React.RefObject<HTMLInputElement | null>;
    valueChipStyle: React.CSSProperties;
    cycleTimeSignature: () => void;
    timeSigNum: number;
    timeSigDen: number;
    keyEnabled: boolean;
    keyTonic: number;
    keyMode: number;
    keyMenuRef: React.RefObject<HTMLDivElement | null>;
    keyMenuOpen: boolean;
    setKeyMenuOpen: (open: boolean) => void;
    onToggleKeyEnabled: () => void;
    onSelectKeyTonic: (index: number) => void;
    onSelectKeyMode: (index: number) => void;
    gridRef: React.RefObject<HTMLDivElement | null>;
    gridOpen: boolean;
    setGridOpen: (open: boolean) => void;
    gridDivision: GridDivision;
    gridTriplet: boolean;
    setGridDivision: (division: GridDivision) => void;
}) {
    const {
        handleTapTempo,
        bpmEditing,
        bpmText,
        setBpmText,
        commitBpm,
        setBpmEditing,
        bpm,
        bpmRef,
        valueChipStyle,
        cycleTimeSignature,
        timeSigNum,
        timeSigDen,
        keyEnabled,
        keyTonic,
        keyMode,
        keyMenuRef,
        keyMenuOpen,
        setKeyMenuOpen,
        onToggleKeyEnabled,
        onSelectKeyTonic,
        onSelectKeyMode,
        gridRef,
        gridOpen,
        setGridOpen,
        gridDivision,
        gridTriplet,
        setGridDivision,
    } = props;
    const gridLabel = gridDivision === 'ADAPTIVE' ? 'Adaptive' : gridTriplet ? `${gridDivision}T` : gridDivision;
    return (
        <div style={{ display: 'flex', alignItems: 'center' }}>
            <PillSection>
                <ControlButton label="Tap" onClick={handleTapTempo} />
                {bpmEditing ? (
                    <input
                        ref={bpmRef}
                        type="text"
                        value={bpmText}
                        onChange={(e) => setBpmText(e.target.value)}
                        onBlur={commitBpm}
                        onKeyDown={(e) => e.key === 'Enter' && commitBpm()}
                        autoFocus
                        style={{
                            ...valueChipStyle,
                            width: 56,
                            minWidth: 56,
                            outline: 'none',
                            boxShadow: '0 0 0 var(--space-px) color-mix(in srgb, var(--color-accent-primary) 42%, transparent)',
                        }}
                    />
                ) : (
                    <button onClick={() => { setBpmEditing(true); setBpmText(bpm.toFixed(2)); }} style={valueChipStyle}>{bpm.toFixed(2)}</button>
                )}
                <button onClick={cycleTimeSignature} style={valueChipStyle} title="Time Signature">{timeSigNum}<span style={{ color: 'var(--color-text-secondary)', margin: '0 var(--space-px)' }}>/</span>{timeSigDen}</button>
            </PillSection>
            <PillSection>
                <div
                    ref={keyMenuRef}
                    style={{
                        position: 'relative',
                        display: 'flex',
                        alignItems: 'center',
                        height: TRANSPORT_UI.controlHeight,
                    }}
                >
                    <button
                        onClick={() => setKeyMenuOpen(!keyMenuOpen)}
                        title="Key Signature"
                        style={{
                            ...valueChipStyle,
                            minWidth: 132,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 8,
                            background: keyMenuOpen ? 'color-mix(in srgb, var(--color-accent-primary) 14%, var(--color-control-bg))' : 'var(--color-control-bg)',
                        }}
                    >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <Music size={12} />
                            <span>{KEY_TONICS[keyTonic]} {KEY_MODES[keyMode]}</span>
                        </span>
                        <span style={{ opacity: 0.85, fontSize: 10 }}>▾</span>
                    </button>
                    {keyMenuOpen && (
                        <div
                            style={{
                                position: 'absolute',
                                left: 0,
                                top: 30,
                                minWidth: 360,
                                background: 'var(--color-bg-elevated)',
                                border: 'var(--space-px) solid var(--color-divider)',
                                borderRadius: 'var(--radius-md)',
                                boxShadow: '0 var(--space-2) var(--token-size-px-18) var(--color-overlay-dark)',
                                zIndex: 'var(--z-tooltip)' as unknown as number,
                                padding: 8,
                                display: 'grid',
                                gridTemplateColumns: '1fr 1fr',
                                columnGap: 8,
                            }}
                        >
                            <button
                                onClick={onToggleKeyEnabled}
                                style={{
                                    gridColumn: '1 / span 2',
                                    ...valueChipStyle,
                                    minWidth: '100%',
                                    justifyContent: 'flex-start',
                                    marginBottom: 6,
                                }}
                            >
                                {keyEnabled ? 'Disable Key Signature' : 'Enable Key Signature'}
                            </button>
                            <div style={{ color: 'var(--color-text-primary)', fontSize: 'var(--font-size-2xs)', fontWeight: 700, padding: '0 var(--space-1)' }}>TONIC</div>
                            <div style={{ color: 'var(--color-text-primary)', fontSize: 'var(--font-size-2xs)', fontWeight: 700, padding: '0 var(--space-1)' }}>MODE</div>
                            <div style={{ display: 'grid', gap: 2 }}>
                                {KEY_TONICS.map((tonic, idx) => (
                                    <button
                                        key={tonic}
                                        onClick={() => {
                                            onSelectKeyTonic(idx);
                                            setKeyMenuOpen(false);
                                        }}
                                        style={keyMenuItemStyle(idx === keyTonic)}
                                    >
                                        {idx === keyTonic ? '✓ ' : ''}{tonic}
                                    </button>
                                ))}
                            </div>
                            <div style={{ display: 'grid', gap: 2 }}>
                                {KEY_MODES.map((mode, idx) => (
                                    <button
                                        key={mode}
                                        onClick={() => {
                                            onSelectKeyMode(idx);
                                            setKeyMenuOpen(false);
                                        }}
                                        style={keyMenuItemStyle(idx === keyMode)}
                                    >
                                        {idx === keyMode ? '✓ ' : ''}{mode}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </PillSection>
            <PillSection style={{ gap: 6 }}>
                <span
                    style={{
                        fontSize: 'var(--font-size-2xs)',
                        color: 'var(--color-text-secondary)',
                        fontFamily: 'var(--font-mono)',
                        fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                        lineHeight: `${TRANSPORT_UI.controlHeight}px`,
                    }}
                >
                    Grid
                </span>
                <div
                    ref={gridRef}
                    style={{
                        position: 'relative',
                        display: 'flex',
                        alignItems: 'center',
                        height: TRANSPORT_UI.controlHeight,
                    }}
                >
                    <button
                        onClick={() => setGridOpen(!gridOpen)}
                        title="Grid Size"
                        style={{
                            ...valueChipStyle,
                            minWidth: 58,
                            background: gridOpen ? 'var(--color-accent-primary-dim)' : 'var(--color-control-bg)',
                            gap: 4,
                        }}
                    >
                        <span>{gridLabel}</span>
                        <span style={{ opacity: 0.8, fontSize: 10 }}>▾</span>
                    </button>
                    {gridOpen && (
                        <div
                            style={{
                                position: 'absolute',
                                left: 0,
                                top: 28,
                                minWidth: 108,
                                background: 'var(--color-bg-elevated)',
                                border: 'var(--space-px) solid var(--color-divider)',
                                borderRadius: 'var(--radius-md)',
                                boxShadow: '0 var(--space-2) var(--token-size-px-18) var(--color-overlay-dark)',
                                zIndex: 'var(--z-tooltip)' as unknown as number,
                                padding: 'var(--space-1) 0',
                            }}
                        >
                            {ALL_DIVISIONS.map((div) => {
                                const active = gridDivision === div;
                                const label = div === 'ADAPTIVE' ? 'Adaptive' : div;
                                return (
                                    <button
                                        key={div}
                                        onClick={() => {
                                            setGridDivision(div);
                                            setGridOpen(false);
                                        }}
                                        style={{
                                            width: '100%',
                                            textAlign: 'left',
                                            border: 'none',
                                            background: active ? 'var(--color-accent-primary-dim)' : 'transparent',
                                            color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                                            fontSize: 'var(--font-size-xs)',
                                            fontFamily: 'var(--font-mono)',
                                            padding: 'var(--space-1) var(--space-2)',
                                            cursor: 'pointer',
                                        }}
                                    >
                                        {label}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
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
            <div style={{ display: 'flex', alignItems: 'center' }}>
                <PillSection>
                    <TransportBtn icon={<Rewind size={13} fill="currentColor" />} title="Rewind to Start" onClick={() => { void engineApi.seekToBeat(0); }} />
                    <TransportBtn icon={<Play size={13} fill="currentColor" />} title="Play" isActive={p.isPlaying} activeColor="var(--color-status-success)" activeBackground={false} onClick={() => { void engineApi.stopPreview().catch((err) => console.warn('[TransportBar] stopPreview before play failed:', err)); p.togglePlay(); }} />
                    <TransportBtn icon={<Square size={13} fill="currentColor" />} title="Stop" onClick={() => { p.engineStop(); void p.stopRecordingIfNeeded(); }} />
                    <TransportBtn icon={<Circle size={12} fill="currentColor" />} title="Record" isActive={p.isRecording} activeColor="var(--color-status-record)" className={p.isRecording ? 'animate-pulse-record' : ''} onClick={() => { void p.handleRecordToggle(); }} />
                    <TransportBtn icon={<RotateCcw size={13} />} title="Toggle Loop" isActive={p.isLooping} activeColor="var(--color-accent-primary)" onClick={() => { const next = !p.isLooping; if (next && p.loopStartFrames === 0 && p.loopEndFrames === 0) { const sr = resolveSampleRate(p.sampleRate); const currentBpm = p.bpm || 120; void p.engineSetLoop(true, beatToFrame(p.posBeats, currentBpm, sr), beatToFrame(p.posBeats + p.timeSigNum, currentBpm, sr)); } else { void p.engineSetLoop(next, p.loopStartFrames, p.loopEndFrames); } }} />
                    <TransportBtn icon={<ArrowRight size={13} strokeWidth={p.followPlayhead ? 3 : 2} />} title="Follow Playhead" isActive={p.followPlayhead} activeColor="var(--color-accent-primary)" onClick={() => p.onFollowPlayheadChange?.(!p.followPlayhead)} />
                </PillSection>

                <PillSection>
                    <span style={{ ...p.valueChipStyle, minWidth: 74, textAlign: 'right', display: 'inline-block', cursor: 'default' }}>{p.posString}</span>
                </PillSection>

                <PillSection>
                    <TransportBtn icon={<Pencil size={13} />} title="Pencil Mode" isActive={p.pianoPencilMode} activeColor="var(--color-accent-primary)" onClick={p.togglePianoPencilMode} />
                    <TransportBtn icon={<svg width={13} height={13} viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" /><text x="8" y="12" textAnchor="middle" fill="currentColor" fontSize="10" fontWeight="700" fontFamily="system-ui">A</text></svg>} title="Automation (A)" isActive={p.automationVisible} activeColor="var(--color-accent-primary)" onClick={() => p.onAutomationToggle?.()} />
                    <ControlButton label="W" onClick={() => p.onFitTimelineHorizontally?.()} />
                    <ControlButton label="H" onClick={() => p.onResetTrackHeights?.()} />
                </PillSection>
            </div>
        </div>
    );
}

export function TransportRightSection(props: {
    midiLedRef: React.RefObject<HTMLSpanElement | null>;
    pdcOpen: boolean;
    setPdcOpen: (next: boolean | ((prev: boolean) => boolean) ) => void;
    assistantOpen: boolean;
    onAssistantToggle?: () => void;
    onSettingsClick?: () => void;
}) {
    const { midiLedRef, pdcOpen, setPdcOpen, assistantOpen, onAssistantToggle, onSettingsClick } = props;
    return (
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
            <PillSection>
                <span ref={midiLedRef} style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-status-success)', opacity: 0.35, boxShadow: '0 0 var(--space-2) color-mix(in srgb, var(--color-status-success) 75%, transparent)', transition: 'opacity 40ms linear' }} />
                <span style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--font-weight-semibold)' as unknown as number, color: 'var(--color-midi-indicator)' }}>MIDI</span>
                <button onClick={() => setPdcOpen((v) => !v)} title="Debug Panel" style={iconBtnStyle(pdcOpen ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)', pdcOpen ? 'color-mix(in srgb, var(--color-accent-primary) 14%, transparent)' : 'transparent')}>{pdcOpen ? <EyeOff size={15} /> : <Eye size={15} />}</button>
                <button onClick={() => onAssistantToggle?.()} title="AI Assistant" style={iconBtnStyle(assistantOpen ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)', assistantOpen ? 'color-mix(in srgb, var(--color-accent-primary) 14%, transparent)' : 'transparent')}><Bot size={15} /></button>
                <button onClick={onSettingsClick} title="Settings (⌘,)" style={iconBtnStyle('var(--color-text-secondary)', 'transparent')}><Settings size={15} /></button>
            </PillSection>
        </div>
    );
}

const iconBtnStyle = (color: string, background: string): React.CSSProperties => ({
    width: TRANSPORT_UI.controlHeight,
    height: TRANSPORT_UI.controlHeight,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: background === 'transparent' ? TRANSPORT_UI.controlBg : background,
    border: TRANSPORT_UI.controlBorder,
    borderRadius: TRANSPORT_UI.controlRadius,
    color,
    cursor: 'pointer',
});

const keyMenuItemStyle = (active: boolean): React.CSSProperties => ({
    width: '100%',
    border: 'none',
    borderRadius: 'var(--radius-xs)',
    background: active ? 'color-mix(in srgb, var(--color-accent-primary) 14%, transparent)' : 'transparent',
    color: 'var(--color-text-primary)',
    textAlign: 'left',
    padding: 'var(--space-1) var(--space-1-5)',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-mono)',
    fontWeight: active ? 700 : 500,
    cursor: 'pointer',
});
