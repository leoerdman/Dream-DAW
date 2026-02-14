import { useState, useRef, useCallback } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useGridStore } from '@/shared/stores/useGridStore';
import { FileMenu } from '@/widgets/FileMenu/FileMenu';
import * as engineApi from '@/shared/api/engine';

/**
 * TransportBar — Full Ableton-style top control bar.
 * 
 * Layout (from TransportBarView.swift):
 * [File | Tap | BPM | TimeSig | Quantize] | [◀ ▶ ■ ● Rec] | [Loop] | [Key On/Off | Note | Mode] | [Position] ... [MIDI] [CPU]
 *
 * Height: 32px (controlBarHeight from DreamTheme.swift)
 * Background: bgElevated with bottom divider
 */

const KEY_TONICS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as const;
const KEY_MODES = ['Major', 'Minor', 'Dorian', 'Mixolydian', 'Phrygian', 'Lydian'] as const;

interface TransportBarProps {
    onSettingsClick?: () => void;
    onOpenExport?: () => void;
    onRecordingStateChange?: (state: { active: boolean; trackIndex: number }) => void;
}

export const TransportBar = ({ onSettingsClick, onOpenExport, onRecordingStateChange }: TransportBarProps) => {
    // ── Engine Store (REAL IPC) ──────────────────────────────────────
    const isPlaying = useEngineStore((s) => s.transport.is_playing);
    const bpm = useEngineStore((s) => s.transport.bpm);
    const isLooping = useEngineStore((s) => s.transport.loop_enabled);
    const positionSeconds = useEngineStore((s) => s.transport.position_seconds);
    const togglePlay = useEngineStore((s) => s.togglePlay);
    const engineStop = useEngineStore((s) => s.stop);
    const engineSetBpm = useEngineStore((s) => s.setBpm);
    const engineSetLoop = useEngineStore((s) => s.setLoop);
    const projectTracks = useEngineStore((s) => s.projectTracks);

    // Local-only UI state (not engine-connected yet)
    const [isRecording, setIsRecording] = useState(false);

    // Tempo editing
    const [bpmEditing, setBpmEditing] = useState(false);
    const [bpmText, setBpmText] = useState(bpm.toFixed(2));
    const bpmRef = useRef<HTMLInputElement>(null);

    // Time signature (local until engine supports it)
    const [timeSigNum] = useState(4);
    const [timeSigDen] = useState(4);

    // Quantize — from global grid store
    const gridDivision = useGridStore((s) => s.division);
    const gridTriplet = useGridStore((s) => s.triplet);
    const cycleDivision = useGridStore((s) => s.cycleDivision);
    const setGridTriplet = useGridStore((s) => s.setTriplet);

    // Key signature
    const [keyEnabled, setKeyEnabled] = useState(false);
    const [keyTonic, setKeyTonic] = useState(0);
    const [keyMode, setKeyMode] = useState(0);

    // Position — computed from engine's live playhead
    const position = (() => {
        const totalBeats = (positionSeconds / 60) * bpm;
        const bar = Math.floor(totalBeats / timeSigNum) + 1;
        const beat = Math.floor(totalBeats % timeSigNum) + 1;
        const sub = Math.floor((totalBeats % 1) * 96);
        return { bar, beat, sub };
    })();

    // Tap tempo
    const tapTimestamps = useRef<number[]>([]);

    // CPU simulation
    const [cpuPercent] = useState(4);

    const handleTapTempo = useCallback(() => {
        const now = Date.now();
        const taps = tapTimestamps.current;
        if (taps.length > 0 && now - taps[taps.length - 1] > 3000) {
            tapTimestamps.current = [];
        }
        taps.push(now);
        if (taps.length > 8) taps.shift();
        if (taps.length >= 2) {
            let total = 0;
            for (let i = 1; i < taps.length; i++) total += taps[i] - taps[i - 1];
            const avg = total / (taps.length - 1);
            const detected = Math.min(999, Math.max(20, 60000 / avg));
            const rounded = Math.round(detected * 100) / 100;
            engineSetBpm(rounded);
            setBpmText(rounded.toFixed(2));
        }
    }, []);

    const commitBpm = () => {
        const val = parseFloat(bpmText);
        if (!isNaN(val) && val >= 20 && val <= 999) {
            const rounded = Math.round(val * 100) / 100;
            engineSetBpm(rounded);
            setBpmText(rounded.toFixed(2));
        } else {
            setBpmText(bpm.toFixed(2));
        }
        setBpmEditing(false);
    };

    const quantizeLabel = gridTriplet ? `${gridDivision}T` : gridDivision;
    const cycleQuantize = () => {
        // Cycle: 1/4 → 1/4T → 1/8 → 1/8T → 1/16 → 1/16T → 1/32 → OFF → 1/4
        if (gridDivision !== 'OFF' && gridDivision !== '1/1' && gridDivision !== '1/2' && gridDivision !== '1/32' && !gridTriplet) {
            setGridTriplet(true);
        } else if (gridTriplet) {
            setGridTriplet(false);
            cycleDivision();
        } else {
            cycleDivision();
        }
    };
    const cycleKeyTonic = () => setKeyTonic(i => (i + 1) % KEY_TONICS.length);
    const cycleKeyMode = () => setKeyMode(i => (i + 1) % KEY_MODES.length);

    const posString = `${position.bar}.${position.beat}.${position.sub.toString().padStart(2, '0')}`;

    const handleRecordToggle = useCallback(async () => {
        const armedTrackIndex = Math.max(0, projectTracks.findIndex((t) => t.is_armed));
        try {
            if (!isRecording) {
                await engineApi.startRecording();
                setIsRecording(true);
                onRecordingStateChange?.({ active: true, trackIndex: armedTrackIndex });
            } else {
                await engineApi.stopRecording();
                setIsRecording(false);
                onRecordingStateChange?.({ active: false, trackIndex: armedTrackIndex });
            }
        } catch (err) {
            console.error('[TransportBar] Recording toggle failed:', err);
        }
    }, [projectTracks, isRecording, onRecordingStateChange]);

    return (
        <div
            className="glass-pill"
            style={{
                height: 'var(--daw-transport-height)',
                zIndex: 'var(--z-transport)',
                fontSize: 'var(--font-size-xs)',
            }}
        >
            {/* ── FILE MENU ── */}
            <Section>
                <FileMenu />
            </Section>

            <Divider />

            {/* ── LEFT: Tap + BPM + TimeSig + Quantize ── */}
            <Section>
                <ControlButton label="Tap" onClick={handleTapTempo} />

                {bpmEditing ? (
                    <input
                        ref={bpmRef}
                        type="text"
                        value={bpmText}
                        onChange={e => setBpmText(e.target.value)}
                        onBlur={commitBpm}
                        onKeyDown={e => e.key === 'Enter' && commitBpm()}
                        autoFocus
                        style={{
                            width: 52,
                            background: 'var(--color-bg-input)',
                            color: 'var(--color-text-primary)',
                            border: '1px solid var(--color-accent-primary)',
                            borderRadius: 'var(--radius-xs)',
                            fontFamily: 'var(--font-mono)',
                            fontSize: 'var(--font-size-sm)',
                            fontWeight: 500,
                            textAlign: 'center',
                            padding: '1px 4px',
                            outline: 'none',
                        }}
                    />
                ) : (
                    <button
                        onClick={() => { setBpmEditing(true); setBpmText(bpm.toFixed(2)); }}
                        style={{
                            background: 'var(--color-bg-input)',
                            border: 'none',
                            borderRadius: 'var(--radius-xs)',
                            color: 'var(--color-text-primary)',
                            fontFamily: 'var(--font-mono)',
                            fontSize: 'var(--font-size-sm)',
                            fontWeight: 600,
                            padding: '1px 6px',
                            cursor: 'pointer',
                            minWidth: 52,
                            textAlign: 'center',
                        }}
                    >
                        {bpm.toFixed(2)}
                    </button>
                )}

                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-primary)', fontWeight: 500, padding: '0 4px' }}>
                    {timeSigNum}<span style={{ color: 'var(--color-text-tertiary)', margin: '0 1px' }}>/</span>{timeSigDen}
                </span>

                <ControlButton
                    label={quantizeLabel}
                    onClick={cycleQuantize}
                    dimmed={gridDivision === 'OFF'}
                />
            </Section>

            <Divider />

            {/* ── CENTER: Transport Controls ── */}
            <Section>
                <TransportBtn
                    icon="◀"
                    title="Rewind"
                    onClick={() => { }}
                />
                <TransportBtn
                    icon="▶"
                    title="Play"
                    isActive={isPlaying}
                    activeColor="var(--color-status-success)"
                    onClick={togglePlay}
                />
                <TransportBtn
                    icon="■"
                    title="Stop"
                    onClick={() => {
                        engineStop();
                        if (isRecording) {
                            engineApi.stopRecording().catch((err) =>
                                console.error('[TransportBar] stopRecording failed:', err),
                            );
                            setIsRecording(false);
                            onRecordingStateChange?.({
                                active: false,
                                trackIndex: Math.max(0, projectTracks.findIndex((t) => t.is_armed)),
                            });
                        }
                    }}
                />
                <TransportBtn
                    icon="●"
                    title="Record"
                    isActive={isRecording}
                    activeColor="var(--color-status-record)"
                    className={isRecording ? 'animate-pulse-record' : ''}
                    onClick={() => { void handleRecordToggle(); }}
                />
            </Section>

            <Divider />

            {/* ── LOOP ── */}
            <Section>
                <button
                    onClick={() => engineSetLoop(!isLooping, 0, 0)}
                    title="Loop"
                    style={{
                        background: isLooping ? 'var(--color-accent-primary-dim)' : 'transparent',
                        border: 'none',
                        color: isLooping ? 'var(--color-accent-primary)' : 'var(--color-text-tertiary)',
                        borderRadius: 'var(--radius-xs)',
                        padding: '2px 6px',
                        cursor: 'pointer',
                        fontSize: 'var(--font-size-xs)',
                        fontWeight: 500,
                    }}
                >
                    ⟲
                </button>
            </Section>

            <Divider />

            {/* ── KEY SIGNATURE ── */}
            <Section>
                <button
                    onClick={() => setKeyEnabled(!keyEnabled)}
                    style={{
                        background: keyEnabled ? 'var(--color-accent-primary-dim)' : 'transparent',
                        border: 'none',
                        color: keyEnabled ? 'var(--color-accent-primary)' : 'var(--color-text-tertiary)',
                        borderRadius: 'var(--radius-xs)',
                        padding: '2px 4px',
                        cursor: 'pointer',
                        fontSize: 'var(--font-size-xs)',
                    }}
                    title="Enable Key"
                >
                    ♪
                </button>
                <ControlButton
                    label={KEY_TONICS[keyTonic]}
                    onClick={cycleKeyTonic}
                    dimmed={!keyEnabled}
                />
                <ControlButton
                    label={KEY_MODES[keyMode]}
                    onClick={cycleKeyMode}
                    dimmed={!keyEnabled}
                />
            </Section>

            <Divider />

            {/* ── POSITION ── */}
            <Section>
                <span
                    style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 'var(--font-size-sm)',
                        fontWeight: 600,
                        color: 'var(--color-text-primary)',
                        background: 'var(--color-bg-input)',
                        borderRadius: 'var(--radius-xs)',
                        padding: '2px 8px',
                        minWidth: 72,
                        textAlign: 'right',
                        display: 'inline-block',
                    }}
                >
                    {posString}
                </span>
            </Section>

            {/* ── SPACER ── */}
            <div style={{ flex: 1 }} />

            <Divider />

            <Section>
                <ControlButton label="Bounce" onClick={() => onOpenExport?.()} />
            </Section>

            <Divider />

            {/* ── RIGHT: MIDI + CPU ── */}
            <Section>
                <span style={{
                    fontSize: 'var(--font-size-2xs)',
                    fontWeight: 500,
                    color: 'var(--color-midi-indicator)',
                }}>
                    MIDI
                </span>
            </Section>

            <Divider />

            <Section style={{ paddingRight: 4 }}>
                <span style={{
                    fontSize: 'var(--font-size-2xs)',
                    color: 'var(--color-text-tertiary)',
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 500,
                }}>
                    CPU {cpuPercent}%
                </span>
            </Section>

            <Divider />

            {/* Settings Gear */}
            <Section style={{ paddingRight: 8 }}>
                <button
                    onClick={onSettingsClick}
                    title="Settings (⌘,)"
                    style={{
                        width: 24, height: 24,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'transparent',
                        border: 'none',
                        borderRadius: 'var(--radius-xs)',
                        color: 'var(--color-text-tertiary)',
                        fontSize: 13,
                        cursor: 'pointer',
                        transition: 'color var(--transition-fast)',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.color = 'var(--color-text-primary)')}
                    onMouseLeave={e => (e.currentTarget.style.color = 'var(--color-text-tertiary)')}
                >
                    ⚙
                </button>
            </Section>
        </div>
    );
};


// ── Sub-components ──────────────────────────────────────────

const Section = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
    <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: '0 var(--section-pad-h)',
        ...style,
    }}>
        {children}
    </div>
);

const Divider = () => <div className="glass-divider" />;

const ControlButton = ({ label, onClick, dimmed }: { label: string; onClick: () => void; dimmed?: boolean }) => (
    <button
        onClick={onClick}
        className="btn-control"
        style={{
            fontFamily: 'var(--font-mono)',
            opacity: dimmed ? 0.45 : 1,
        }}
    >
        {label}
    </button>
);

const TransportBtn = ({
    icon, title, isActive, activeColor, onClick, className,
}: {
    icon: string; title: string; isActive?: boolean; activeColor?: string; onClick: () => void; className?: string;
}) => (
    <button
        onClick={onClick}
        title={title}
        className={className}
        style={{
            width: 24, height: 24,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: isActive ? `color-mix(in srgb, ${activeColor} 15%, transparent)` : 'transparent',
            border: 'none',
            borderRadius: 'var(--radius-xs)',
            color: isActive ? activeColor : 'var(--color-text-tertiary)',
            fontSize: 'var(--font-size-sm)',
            cursor: 'pointer',
            transition: 'all var(--transition-fast)',
        }}
    >
        {icon}
    </button>
);
