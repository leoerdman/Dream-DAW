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
import { secondsToBeat } from '@/shared/lib/audioMath';
import { useState, useRef, useEffect } from 'react';
import { useStatusEngineSlice } from './model/useStatusEngineSlice';
import { StatusGroup, StatusLabel, StatusText, StatusValue } from './ui/statusBarParts';
import { panelModeBtnStyle } from './ui/statusBarStyles';
import { HistorySection, InlineMessage } from './ui/statusBarSections';

interface StatusBarProps {
    projectEnd?: string;
    duration?: string;
    trackCount?: number;
    panelMode?: 'rack' | 'clip';
    onPanelModeChange?: (mode: 'rack' | 'clip') => void;
    panelInfo?: string;
}

export const StatusBar = ({
    projectEnd = '48.1.00',
    duration = '2:28.430',
    panelMode,
    onPanelModeChange,
    panelInfo,
}: StatusBarProps) => {
    // Live engine data
    const {
        positionSeconds,
        bpm,
        latestHistory,
        projectHistory,
    } = useStatusEngineSlice();

    // Status bar messages
    const statusMessage = useStatusStore((s) => s.message);
    const statusSeverity = useStatusStore((s) => s.severity);
    const statusClear = useStatusStore((s) => s.clear);

    const [historyOpen, setHistoryOpen] = useState(false);
    const historyRef = useRef<HTMLDivElement | null>(null);

    // Compute bar.beat.sub from live playhead
    const totalBeats = secondsToBeat(positionSeconds, bpm);
    const bar = Math.floor(totalBeats / 4) + 1;
    const beat = Math.floor(totalBeats % 4) + 1;
    const sub = Math.floor((totalBeats % 1) * 96);
    const position = `${bar}.${beat}.${sub.toString().padStart(2, '0')}`;
    useEffect(() => {
        if (!historyOpen) return;
        const onDown = (e: MouseEvent) => {
            if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
                setHistoryOpen(false);
            }
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [historyOpen]);

    const historyItems = projectHistory.slice(-10).reverse();

    return (
        <div style={{ flexShrink: 0 }}>
            {/* ── Main Status Row ── */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                height: 26,
                background: 'var(--color-bg-header)',
                borderTop: '1px solid var(--color-divider)',
                padding: '0 10px',
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
                            border: '1px solid var(--color-control-border)',
                            borderRadius: 'var(--radius-md)',
                            padding: 2,
                            height: 24,
                            background: 'var(--color-control-bg)',
                            boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--color-text-primary) 5%, transparent)',
                            marginRight: 2,
                        }}>
                            <button
                                type="button"
                                onClick={() => onPanelModeChange('rack')}
                                style={panelModeBtnStyle(panelMode === 'rack')}
                                title="Instrument & Effects Chain (Shift+Tab)"
                            >
                                Rack
                            </button>
                            <button
                                type="button"
                                onClick={() => onPanelModeChange('clip')}
                                style={panelModeBtnStyle(panelMode === 'clip')}
                                title="Clip Editor (Shift+Tab)"
                            >
                                Clip
                            </button>
                        </div>
                    )}
                    {!statusMessage && panelInfo && (
                        <StatusText>{panelInfo}</StatusText>
                    )}
                    {!statusMessage && (
                        <>
                            <StatusText>Arrangement</StatusText>

                            <StatusGroup>
                                <StatusLabel>Position:</StatusLabel>
                                <StatusValue>{position}</StatusValue>
                            </StatusGroup>

                            <StatusGroup>
                                <StatusLabel>End:</StatusLabel>
                                <StatusValue>{projectEnd}</StatusValue>
                            </StatusGroup>

                            <StatusGroup>
                                <StatusLabel>Length:</StatusLabel>
                                <StatusValue>{duration}</StatusValue>
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
