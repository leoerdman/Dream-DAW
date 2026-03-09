/**
 * StatusBar — Bottom status bar (Ableton Live style).
 *
 * Ported from StatusBarView.swift (142 lines).
 * NOW WIRED to Zustand engine store for live playhead data.
 * Shows global errors/notices from useStatusStore.
 *
 * Layout:
 *   [Arrangement] [Position: 1.1.24] [End: 48.1.00] [Length: 2:28.430]
 *   ...spacer...
 *   [▶/■] [9 tracks] [44100 Hz] [Main ▾]
 *   ─── Error line (when active) ───
 */

import { useStatusStore } from '@/shared/stores/useStatusStore';
import { useState, useRef, useEffect, useMemo } from 'react';
import { useStatusEngineSlice } from './model/useStatusEngineSlice';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { StatusGroup, StatusLabel, StatusText, StatusValue } from './ui/statusBarParts';
import { panelModeBtnStyle } from './ui/statusBarStyles';
import { HistorySection, InlineMessage } from './ui/statusBarSections';
import { DEFAULT_TIME_SIG_NUMERATOR } from '@/shared/lib/audioMath';


interface StatusBarProps {
    projectEnd?: string;
    duration?: string;
    /** BUG-32 FIX: Accept time signature numerator (default 4). */
    timeSigNum?: number;
    panelMode?: 'rack' | 'clip';
    onPanelModeChange?: (mode: 'rack' | 'clip') => void;
    panelInfo?: string;
    mainViewMode?: 'arrangement' | 'session' | 'flow';
    onMainViewModeChange?: React.Dispatch<React.SetStateAction<'arrangement' | 'session' | 'flow'>>;
    isFlowAvailable?: boolean;
    /** Missing media summary for inline badge in the status bar. */
    missingMediaSummary?: { offlineClipCount: number; missingPluginCount: number; missingSamplerCount: number; total: number };
    /** Toggle the missing assets panel. */
    onToggleMissingAssets?: () => void;
}

export const StatusBar = ({
    projectEnd,
    duration,
    timeSigNum,
    panelMode,
    onPanelModeChange,
    panelInfo,
    mainViewMode = 'arrangement',
    onMainViewModeChange,
    isFlowAvailable = false,
    missingMediaSummary,
    onToggleMissingAssets,
}: StatusBarProps) => {
    const prefetchRackPanel = () => {
        void import('@/widgets/DeviceRack/DeviceRack');
    };
    const prefetchClipPanel = () => {
        void import('@/widgets/PianoRoll/PianoRoll');
    };
    // Live engine data
    const {
        bpm,
        timeSigNumerator,
        timelineClips,
        latestHistory,
        projectHistory,
    } = useStatusEngineSlice();

    // Status bar messages
    const statusMessage = useStatusStore((s) => s.message);
    const statusSeverity = useStatusStore((s) => s.severity);
    const statusClear = useStatusStore((s) => s.clear);

    const [historyOpen, setHistoryOpen] = useState(false);
    const historyRef = useRef<HTMLDivElement | null>(null);

    const effectiveTimeSigNum = timeSigNum ?? timeSigNumerator ?? DEFAULT_TIME_SIG_NUMERATOR;

    // PERF-OPT: Ref-based position display — direct DOM mutation instead of
    // React re-renders. position_beats changes every tick (~30fps) during playback.
    const positionRef = useRef<HTMLSpanElement | null>(null);
    const timeSigRef = useRef(effectiveTimeSigNum);
    useEffect(() => { timeSigRef.current = effectiveTimeSigNum; }, [effectiveTimeSigNum]);

    useEffect(() => {
        const unsub = useEngineStore.subscribe((state) => {
            const el = positionRef.current;
            if (!el) return;
            const posBeats = state.transport.position_beats ?? 0;
            const bpb = Math.max(1, timeSigRef.current);
            const bar = Math.floor(posBeats / bpb) + 1;
            const beat = Math.floor(posBeats % bpb) + 1;
            const sub = Math.floor((posBeats % 1) * 96);
            const text = `${bar}.${beat}.${sub.toString().padStart(2, '0')}`;
            if (el.textContent !== text) el.textContent = text;
        });
        return unsub;
    }, []);
    const computedRange = useMemo(() => {
        let endBeat = 0;
        for (const clip of timelineClips) {
            endBeat = Math.max(endBeat, clip.startBeat + clip.durationBeats);
        }
        const beatsPerBarComputed = Math.max(1, effectiveTimeSigNum);
        const endBar = Math.max(1, Math.ceil(endBeat / beatsPerBarComputed));
        const durationSeconds = endBeat > 0 ? (endBeat / Math.max(1, bpm)) * 60 : 0;
        return {
            projectEndText: `${endBar}.1.00`,
            durationText: formatDuration(durationSeconds),
        };
    }, [timelineClips, effectiveTimeSigNum, bpm]);
    const projectEndText = projectEnd ?? computedRange.projectEndText;
    const durationText = duration ?? computedRange.durationText;
    useEffect(() => {
        if (!historyOpen) return;
        const onDown = (e: MouseEvent) => {
            if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
                setHistoryOpen(false);
            }
        };
        document.addEventListener('pointerdown', onDown);
        return () => document.removeEventListener('pointerdown', onDown);
    }, [historyOpen]);

    // BUG-99 FIX: Memoize historyItems to avoid creating new array every render.
    const historyItems = useMemo(() => projectHistory.slice(-10).reverse(), [projectHistory]);

    return (
        <div style={{ flexShrink: 0 }}>
            {/* ── Main Status Row ── */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                height: 'var(--daw-status-bar-height)',
                background: 'var(--color-bg-header)',
                borderTop: 'var(--space-px) solid var(--color-divider)',
                padding: '0 var(--space-2-5)',
                fontSize: 'var(--font-size-2xs)',
                zIndex: 'var(--z-transport)',
            }}>

                {/* Left section */}
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    flexShrink: 0,
                }}>
                    {panelMode && onPanelModeChange && (
                        <div style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 2,
                            border: 'var(--space-px) solid var(--color-control-border)',
                            borderRadius: 'var(--radius-md)',
                            padding: 2,
                            height: 24,
                            background: 'var(--color-control-bg)',
                            boxShadow: 'inset 0 var(--space-px) 0 color-mix(in srgb, var(--color-text-primary) 5%, transparent)',
                            marginRight: 2,
                        }}>
                            <button
                                type="button"
                                onClick={() => onPanelModeChange('rack')}
                                onMouseEnter={prefetchRackPanel}
                                onFocus={prefetchRackPanel}
                                style={panelModeBtnStyle(panelMode === 'rack')}
                                title="Instrument & Effects Chain (Shift+Tab)"
                            >
                                Rack
                            </button>
                            <button
                                type="button"
                                onClick={() => onPanelModeChange('clip')}
                                onMouseEnter={prefetchClipPanel}
                                onFocus={prefetchClipPanel}
                                style={panelModeBtnStyle(panelMode === 'clip')}
                                title="Clip Editor (Shift+Tab)"
                            >
                                Clip
                            </button>
                        </div>
                    )}
                    {/* ── View Mode Toggle: Arrange / Mix / Flow ── */}
                    {onMainViewModeChange && (
                        <div style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 2,
                            border: 'var(--space-px) solid var(--color-control-border)',
                            borderRadius: 'var(--radius-md)',
                            padding: 2,
                            height: 24,
                            background: 'var(--color-control-bg)',
                            boxShadow: 'inset 0 var(--space-px) 0 color-mix(in srgb, var(--color-text-primary) 5%, transparent)',
                            marginRight: 2,
                        }}>
                            <button
                                type="button"
                                onClick={() => onMainViewModeChange('arrangement')}
                                style={panelModeBtnStyle(mainViewMode === 'arrangement')}
                                title="Arrangement View (Tab)"
                            >
                                Arrange
                            </button>
                            <button
                                type="button"
                                onClick={() => onMainViewModeChange('session')}
                                style={panelModeBtnStyle(mainViewMode === 'session')}
                                title="Mixer View (Tab)"
                            >
                                Mix
                            </button>
                            {isFlowAvailable && (
                                <button
                                    type="button"
                                    onClick={() => onMainViewModeChange('flow')}
                                    style={panelModeBtnStyle(mainViewMode === 'flow')}
                                    title="Flow Synth View (Tab)"
                                >
                                    Flow
                                </button>
                            )}
                        </div>
                    )}
                    {/* ── Inline Missing Media Badge ── */}
                    {missingMediaSummary && missingMediaSummary.total > 0 && onToggleMissingAssets && (
                        <button
                            type="button"
                            onClick={onToggleMissingAssets}
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                                border: 'var(--space-px) solid color-mix(in srgb, var(--color-status-error) 40%, transparent)',
                                borderRadius: 'var(--radius-md)',
                                padding: '2px 8px',
                                height: 22,
                                background: 'color-mix(in srgb, var(--color-status-error) 12%, transparent)',
                                color: 'var(--color-status-error)',
                                fontSize: 'var(--font-size-2xs)',
                                fontWeight: 'var(--font-weight-medium)',
                                cursor: 'pointer',
                                transition: 'background var(--transition-fast)',
                                letterSpacing: '0.01em',
                                flexShrink: 0,
                            }}
                            title="Open Missing Media Manager"
                        >
                            <span style={{ fontSize: 9, lineHeight: 1 }}>⚠</span>
                            {missingMediaSummary.offlineClipCount > 0 && (
                                <span>{missingMediaSummary.offlineClipCount} file{missingMediaSummary.offlineClipCount !== 1 ? 's' : ''} offline</span>
                            )}
                            {missingMediaSummary.offlineClipCount > 0 && (missingMediaSummary.missingPluginCount > 0 || missingMediaSummary.missingSamplerCount > 0) && (
                                <span>·</span>
                            )}
                            {missingMediaSummary.missingPluginCount > 0 && (
                                <span>{missingMediaSummary.missingPluginCount} plugin{missingMediaSummary.missingPluginCount !== 1 ? 's' : ''}</span>
                            )}
                            {missingMediaSummary.missingPluginCount > 0 && missingMediaSummary.missingSamplerCount > 0 && (
                                <span>·</span>
                            )}
                            {missingMediaSummary.missingSamplerCount > 0 && (
                                <span>{missingMediaSummary.missingSamplerCount} sample{missingMediaSummary.missingSamplerCount !== 1 ? 's' : ''}</span>
                            )}
                        </button>
                    )}
                    {!statusMessage && panelInfo && (
                        <StatusText>{panelInfo}</StatusText>
                    )}
                    {!statusMessage && (
                        <>
                            <StatusText>{mainViewMode === 'flow' ? 'Flow' : mainViewMode === 'session' ? 'Session' : 'Arrangement'}</StatusText>

                            <StatusGroup>
                                <StatusLabel>Position:</StatusLabel>
                                <StatusValue><span ref={positionRef}>1.1.00</span></StatusValue>
                            </StatusGroup>

                            <StatusGroup>
                                <StatusLabel>End:</StatusLabel>
                                <StatusValue>{projectEndText}</StatusValue>
                            </StatusGroup>

                            <StatusGroup>
                                <StatusLabel>Length:</StatusLabel>
                                <StatusValue>{durationText}</StatusValue>
                            </StatusGroup>
                            <HistorySection
                                latestHistory={latestHistory}
                                historyItems={historyItems}
                                historyOpen={historyOpen}
                                setHistoryOpen={setHistoryOpen}
                                historyRef={historyRef}
                            />
                        </>
                    )}
                </div>

                {statusMessage && (
                    <InlineMessage statusMessage={statusMessage} statusSeverity={statusSeverity} onClear={statusClear} />
                )}
            </div>
        </div>
    );
};

function formatDuration(totalSeconds: number): string {
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0:00.000';
    const mins = Math.floor(totalSeconds / 60);
    const secs = Math.floor(totalSeconds % 60);
    const millis = Math.floor((totalSeconds - Math.floor(totalSeconds)) * 1000);
    return `${mins}:${secs.toString().padStart(2, '0')}.${millis.toString().padStart(3, '0')}`;
}
