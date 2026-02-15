import { useState, useRef, useCallback, useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import * as engineApi from '@/shared/api/engine';
import {
    Play,
    Square,
    Circle,
    Rewind,
    RotateCcw,
    ArrowRight,
    Music,
    Settings,
    Eye,
    EyeOff,
    RefreshCw,
    X,
} from 'lucide-react';

const KEY_TONICS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as const;
const KEY_MODES = ['Major', 'Minor', 'Dorian', 'Mixolydian', 'Phrygian', 'Lydian'] as const;
const TIME_SIGNATURES: ReadonlyArray<[number, number]> = [
    [4, 4],
    [3, 4],
    [6, 8],
    [5, 4],
];

interface TransportBarProps {
    onSettingsClick?: () => void;
    onOpenExport?: () => void;
    onRecordingStateChange?: (state: { active: boolean; trackIndex: number }) => void;
    followPlayhead?: boolean;
    onFollowPlayheadChange?: (enabled: boolean) => void;
    automationVisible?: boolean;
    onAutomationToggle?: () => void;
}

export const TransportBar = ({
    onSettingsClick,
    onOpenExport,
    onRecordingStateChange,
    followPlayhead = false,
    onFollowPlayheadChange,
    automationVisible = false,
    onAutomationToggle,
}: TransportBarProps) => {
    const isPlaying = useEngineStore((s) => s.transport.is_playing);
    const bpm = useEngineStore((s) => s.projectBpm || s.transport.bpm || 120);
    const isLooping = useEngineStore((s) => s.transport.loop_enabled);
    const loopStartFrames = useEngineStore((s) => s.transport.loop_start);
    const loopEndFrames = useEngineStore((s) => s.transport.loop_end);
    const sampleRate = useEngineStore((s) => s.transport.sample_rate);
    const posBeats = useEngineStore((s) => s.transport.position_beats ?? 0);
    const togglePlay = useEngineStore((s) => s.togglePlay);
    const engineStop = useEngineStore((s) => s.stop);
    const engineSetBpm = useEngineStore((s) => s.setBpm);
    const engineSetLoop = useEngineStore((s) => s.setLoop);
    const projectTracks = useEngineStore((s) => s.projectTracks);

    const [isRecording, setIsRecording] = useState(false);
    const [bpmEditing, setBpmEditing] = useState(false);
    const [bpmText, setBpmText] = useState(bpm.toFixed(2));
    const bpmRef = useRef<HTMLInputElement>(null);

    const [timeSigIndex, setTimeSigIndex] = useState(0);
    const [timeSigNum, timeSigDen] = TIME_SIGNATURES[timeSigIndex] ?? [4, 4];
    const [keyEnabled, setKeyEnabled] = useState(false);
    const [keyTonic, setKeyTonic] = useState(0);
    const [keyMode, setKeyMode] = useState(0);

    const position = (() => {
        const bar = Math.floor(posBeats / timeSigNum) + 1;
        const beat = Math.floor(posBeats % timeSigNum) + 1;
        const sub = Math.floor((posBeats % 1) * 96);
        return { bar, beat, sub };
    })();

    const tapTimestamps = useRef<number[]>([]);
    const [cpuPercent] = useState(4);
    const midiLedRef = useRef<HTMLSpanElement>(null);
    const midiLedTimerRef = useRef<number | null>(null);
    const [pdcOpen, setPdcOpen] = useState(false);
    const [pdcLoading, setPdcLoading] = useState(false);
    const [pdcError, setPdcError] = useState<string | null>(null);
    const [pdcSnapshot, setPdcSnapshot] = useState<engineApi.PdcDebugSnapshot | null>(null);
    const pdcPanelRef = useRef<HTMLDivElement | null>(null);

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
    }, [engineSetBpm]);

    const loadPdcSnapshot = useCallback(async () => {
        setPdcLoading(true);
        try {
            const snapshot = await engineApi.getPdcDebugSnapshot();
            setPdcSnapshot(snapshot);
            setPdcError(null);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setPdcError(msg);
        } finally {
            setPdcLoading(false);
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

    const cycleKeyTonic = () => setKeyTonic((i) => (i + 1) % KEY_TONICS.length);
    const cycleKeyMode = () => setKeyMode((i) => (i + 1) % KEY_MODES.length);
    const cycleTimeSignature = () => setTimeSigIndex((i) => (i + 1) % TIME_SIGNATURES.length);
    const posString = `${position.bar}.${position.beat}.${position.sub.toString().padStart(2, '0')}`;
    const valueChipStyle: React.CSSProperties = {
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--font-size-sm)',
        fontWeight: 700,
        color: 'var(--color-text-primary)',
        background: 'var(--color-bg-input)',
        borderRadius: 'var(--radius-xs)',
        padding: '2px 8px',
        minWidth: 56,
        textAlign: 'center',
        border: 'none',
        cursor: 'pointer',
    };

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

    useEffect(() => {
        let unlisten: UnlistenFn | null = null;
        void listen<Record<string, unknown>>('midi_event_received', () => {
            const led = midiLedRef.current;
            if (!led) return;
            led.style.opacity = '1';
            if (midiLedTimerRef.current !== null) {
                window.clearTimeout(midiLedTimerRef.current);
            }
            midiLedTimerRef.current = window.setTimeout(() => {
                if (midiLedRef.current) midiLedRef.current.style.opacity = '0.35';
            }, 50);
        }).then((fn) => {
            unlisten = fn;
        }).catch((err) => {
            console.error('[TransportBar] midi_event_received listener failed:', err);
        });

        return () => {
            if (midiLedTimerRef.current !== null) {
                window.clearTimeout(midiLedTimerRef.current);
                midiLedTimerRef.current = null;
            }
            if (unlisten) unlisten();
        };
    }, []);

    useEffect(() => {
        if (!pdcOpen) return;
        void loadPdcSnapshot();
        const id = window.setInterval(() => {
            void loadPdcSnapshot();
        }, 1500);
        return () => window.clearInterval(id);
    }, [pdcOpen, loadPdcSnapshot]);

    useEffect(() => {
        if (!pdcOpen) return;
        const onDown = (e: MouseEvent) => {
            const target = e.target as Node;
            if (pdcPanelRef.current && !pdcPanelRef.current.contains(target)) {
                setPdcOpen(false);
            }
        };
        const onEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setPdcOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onEsc);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onEsc);
        };
    }, [pdcOpen]);

    return (
        <div data-testid="transport-bar" className="glass-pill" style={{ height: 'var(--daw-transport-height)', zIndex: 'var(--z-transport)' }}>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', height: '100%', width: '100%' }}>
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
                                    width: 56,
                                    background: valueChipStyle.background,
                                    color: 'var(--color-text-primary)',
                                    border: '1px solid var(--color-accent-primary)',
                                    borderRadius: 'var(--radius-xs)',
                                    fontFamily: valueChipStyle.fontFamily,
                                    fontSize: valueChipStyle.fontSize,
                                    fontWeight: valueChipStyle.fontWeight,
                                    textAlign: 'center',
                                    padding: '2px 6px',
                                    outline: 'none',
                                }}
                            />
                        ) : (
                            <button
                                onClick={() => { setBpmEditing(true); setBpmText(bpm.toFixed(2)); }}
                                style={valueChipStyle}
                            >
                                {bpm.toFixed(2)}
                            </button>
                        )}
                        <button onClick={cycleTimeSignature} style={valueChipStyle} title="Time Signature">
                            {timeSigNum}<span style={{ color: 'var(--color-text-secondary)', margin: '0 1px' }}>/</span>{timeSigDen}
                        </button>
                    </PillSection>

                    <PillSection>
                        <TransportBtn
                            icon={<Music size={13} fill={keyEnabled ? 'currentColor' : 'none'} />}
                            title="Enable Key"
                            isActive={keyEnabled}
                            activeColor="var(--color-accent-primary)"
                            onClick={() => setKeyEnabled(!keyEnabled)}
                        />
                        <ControlButton label={KEY_TONICS[keyTonic]} onClick={cycleKeyTonic} />
                        <ControlButton label={KEY_MODES[keyMode]} onClick={cycleKeyMode} />
                    </PillSection>
                </div>

                <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)' }}>
                    <PillSection>
                        <TransportBtn icon={<Rewind size={13} fill="currentColor" />} title="Rewind" onClick={() => { }} />
                        <TransportBtn
                            icon={<Play size={13} fill="currentColor" />}
                            title="Play"
                            isActive={isPlaying}
                            activeColor="var(--color-status-success)"
                            activeBackground={false}
                            onClick={togglePlay}
                        />
                        <TransportBtn
                            icon={<Square size={13} fill="currentColor" />}
                            title="Stop"
                            onClick={() => {
                                engineStop();
                                if (isRecording) {
                                    engineApi.stopRecording().catch((err) => console.error('[TransportBar] stopRecording failed:', err));
                                    setIsRecording(false);
                                    onRecordingStateChange?.({
                                        active: false,
                                        trackIndex: Math.max(0, projectTracks.findIndex((t) => t.is_armed)),
                                    });
                                }
                            }}
                        />
                        <TransportBtn
                            icon={<Circle size={12} fill="currentColor" />}
                            title="Record"
                            isActive={isRecording}
                            activeColor="var(--color-status-record)"
                            className={isRecording ? 'animate-pulse-record' : ''}
                            onClick={() => { void handleRecordToggle(); }}
                        />
                        <TransportBtn
                            icon={<RotateCcw size={13} />}
                            title="Toggle Loop"
                            isActive={isLooping}
                            activeColor="var(--color-accent-primary)"
                            onClick={() => {
                                const newEnabled = !isLooping;
                                if (newEnabled && loopStartFrames === 0 && loopEndFrames === 0) {
                                    const sr = sampleRate || 44100;
                                    const currentBpm = bpm || 120;
                                    const framesPerBeat = sr * 60 / currentBpm;
                                    const startF = Math.round(posBeats * framesPerBeat);
                                    const endF = Math.round((posBeats + timeSigNum) * framesPerBeat);
                                    void engineSetLoop(true, startF, endF);
                                } else {
                                    void engineSetLoop(newEnabled, loopStartFrames, loopEndFrames);
                                }
                            }}
                        />
                        <TransportBtn
                            icon={<ArrowRight size={13} strokeWidth={followPlayhead ? 3 : 2} />}
                            title="Follow Playhead"
                            isActive={followPlayhead}
                            activeColor="var(--color-accent-primary)"
                            onClick={() => onFollowPlayheadChange?.(!followPlayhead)}
                        />
                        <TransportBtn
                            icon={
                                <svg width={13} height={13} viewBox="0 0 16 16" fill="none">
                                    <rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
                                    <text x="8" y="12" textAnchor="middle" fill="currentColor" fontSize="10" fontWeight="700" fontFamily="system-ui">A</text>
                                </svg>
                            }
                            title="Automation (A)"
                            isActive={automationVisible}
                            activeColor="var(--color-accent-primary)"
                            onClick={() => onAutomationToggle?.()}
                        />
                        <span style={{ ...valueChipStyle, minWidth: 74, textAlign: 'right', display: 'inline-block', cursor: 'default' }}>
                            {posString}
                        </span>
                    </PillSection>
                </div>

                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
                    <PillSection>
                        <ControlButton label="Bounce" onClick={() => onOpenExport?.()} />
                        <span
                            ref={midiLedRef}
                            style={{
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                background: '#33d17a',
                                opacity: 0.35,
                                boxShadow: '0 0 8px rgba(51, 209, 122, 0.75)',
                                transition: 'opacity 40ms linear',
                            }}
                        />
                        <span style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 600, color: 'var(--color-midi-indicator)' }}>MIDI</span>
                        <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                            CPU {cpuPercent}%
                        </span>
                        <button
                            onClick={() => setPdcOpen((v) => !v)}
                            title="PDC Inspector"
                            style={{
                                width: 24,
                                height: 24,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: pdcOpen ? 'color-mix(in srgb, var(--color-accent-primary) 14%, transparent)' : 'transparent',
                                border: 'none',
                                borderRadius: 'var(--radius-xs)',
                                color: pdcOpen ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)',
                                cursor: 'pointer',
                            }}
                        >
                            {pdcOpen ? <EyeOff size={15} /> : <Eye size={15} />}
                        </button>
                        <button
                            onClick={onSettingsClick}
                            title="Settings (⌘,)"
                            style={{
                                width: 24,
                                height: 24,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: 'transparent',
                                border: 'none',
                                borderRadius: 'var(--radius-xs)',
                                color: 'var(--color-text-secondary)',
                                cursor: 'pointer',
                            }}
                        >
                            <Settings size={15} />
                        </button>
                    </PillSection>
                </div>
                {pdcOpen && (
                    <div
                        ref={pdcPanelRef}
                        style={{
                            position: 'absolute',
                            right: 10,
                            top: 'calc(100% + 8px)',
                            width: 440,
                            maxHeight: 'min(58vh, 540px)',
                            display: 'flex',
                            flexDirection: 'column',
                            background: 'color-mix(in srgb, var(--color-bg-panel) 96%, #000 4%)',
                            border: '1px solid var(--color-divider)',
                            borderRadius: 10,
                            boxShadow: '0 16px 42px rgba(0,0,0,0.35)',
                            backdropFilter: 'blur(8px)',
                            zIndex: 1400,
                            overflow: 'hidden',
                        }}
                    >
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                padding: '8px 10px',
                                borderBottom: '1px solid var(--color-divider)',
                            }}
                        >
                            <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-primary)' }}>
                                PDC Inspector
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <button
                                    onClick={() => void loadPdcSnapshot()}
                                    title="Refresh"
                                    style={miniButtonStyle}
                                >
                                    <RefreshCw size={13} />
                                </button>
                                <button
                                    onClick={() => setPdcOpen(false)}
                                    title="Close"
                                    style={miniButtonStyle}
                                >
                                    <X size={13} />
                                </button>
                            </div>
                        </div>
                        <div
                            style={{
                                padding: '8px 10px',
                                fontFamily: 'var(--font-mono)',
                                fontSize: 10,
                                color: 'var(--color-text-secondary)',
                                borderBottom: '1px solid var(--color-divider)',
                                display: 'grid',
                                gridTemplateColumns: '1fr 1fr',
                                gap: 4,
                            }}
                        >
                            <div>Nodes: <strong style={{ color: 'var(--color-text-primary)' }}>{pdcSnapshot?.node_count ?? '—'}</strong></div>
                            <div>Edges: <strong style={{ color: 'var(--color-text-primary)' }}>{pdcSnapshot?.edge_count ?? '—'}</strong></div>
                            <div>Node PDC: <strong style={{ color: 'var(--color-text-primary)' }}>{pdcSnapshot?.node_pdc_nonzero ?? '—'}</strong></div>
                            <div>Edge PDC: <strong style={{ color: 'var(--color-text-primary)' }}>{pdcSnapshot?.edge_pdc_nonzero ?? '—'}</strong></div>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', minHeight: 210, maxHeight: 'min(45vh, 380px)' }}>
                            <div style={{ borderRight: '1px solid var(--color-divider)', overflow: 'auto' }}>
                                <div style={sectionHeaderStyle}>Node Delays</div>
                                {(pdcSnapshot?.nodes ?? []).map((n) => (
                                    <div key={`node-${n.node_id}`} style={rowStyle}>
                                        <div style={{ color: 'var(--color-text-primary)' }}>{n.name}</div>
                                        <div>#{n.node_id} · {n.kind}</div>
                                        <div>own {n.own_latency_samples} / pdc {n.node_delay_samples} smp</div>
                                    </div>
                                ))}
                            </div>
                            <div style={{ overflow: 'auto' }}>
                                <div style={sectionHeaderStyle}>Edge Compensation</div>
                                {(pdcSnapshot?.edges ?? []).map((e, idx) => (
                                    <div key={`edge-${e.from_node_id}-${e.to_node_id}-${idx}`} style={rowStyle}>
                                        <div style={{ color: 'var(--color-text-primary)' }}>{e.from_name} → {e.to_name}</div>
                                        <div>{e.from_node_id}→{e.to_node_id}</div>
                                        <div>{e.edge_delay_samples} smp</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                        <div style={{ padding: '6px 10px', borderTop: '1px solid var(--color-divider)', fontSize: 10, color: 'var(--color-text-secondary)' }}>
                            {pdcLoading ? 'Updating…' : pdcError ? `Error: ${pdcError}` : pdcSnapshot?.edge_summary || 'No PDC diagnostics'}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

const miniButtonStyle: React.CSSProperties = {
    width: 22,
    height: 22,
    border: 'none',
    borderRadius: 5,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    color: 'var(--color-text-secondary)',
    cursor: 'pointer',
};

const sectionHeaderStyle: React.CSSProperties = {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    padding: '6px 8px',
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--color-text-primary)',
    background: 'color-mix(in srgb, var(--color-bg-panel) 92%, #000 8%)',
    borderBottom: '1px solid var(--color-divider)',
};

const rowStyle: React.CSSProperties = {
    padding: '6px 8px',
    borderBottom: '1px solid color-mix(in srgb, var(--color-divider) 55%, transparent)',
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    color: 'var(--color-text-secondary)',
    lineHeight: 1.35,
};

const PillSection = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
    <div
        style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '0 8px',
            margin: '0 4px',
            height: 26,
            borderRadius: 'var(--radius-md)',
            background: 'color-mix(in srgb, var(--color-bg-panel) 80%, transparent)',
            border: '1px solid var(--color-divider)',
            ...style,
        }}
    >
        {children}
    </div>
);

const ControlButton = ({ label, onClick, dimmed }: { label: string; onClick: () => void; dimmed?: boolean }) => (
    <button
        onClick={onClick}
        className="btn-control"
        style={{
            fontFamily: 'var(--font-mono)',
            opacity: dimmed ? 0.35 : 1,
        }}
    >
        {label}
    </button>
);

const TransportBtn = ({
    icon,
    title,
    isActive,
    activeColor,
    activeBackground = true,
    onClick,
    className,
}: {
    icon: React.ReactNode;
    title: string;
    isActive?: boolean;
    activeColor?: string;
    activeBackground?: boolean;
    onClick: () => void;
    className?: string;
}) => (
    <button
        onClick={onClick}
        title={title}
        className={className}
        style={{
            width: 22,
            height: 22,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: isActive && activeBackground ? `color-mix(in srgb, ${activeColor} 15%, transparent)` : 'transparent',
            border: 'none',
            borderRadius: 'var(--radius-xs)',
            color: isActive ? activeColor : 'var(--color-text-secondary)',
            cursor: 'pointer',
            transition: 'all var(--transition-fast)',
        }}
    >
        {icon}
    </button>
);
