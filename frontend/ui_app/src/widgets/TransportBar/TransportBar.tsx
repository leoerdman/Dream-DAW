import { useState, useRef, useCallback, useEffect } from 'react';
import { beatToFrame, resolveSampleRate } from '../../shared/lib/audioMath';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useGridStore } from '@/shared/stores/useGridStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import * as engineApi from '@/shared/api/engine';
import { useTransportEngineSlice } from './model/useTransportEngineSlice';
import {
    computeTransportPosition,
    DEFAULT_PDC_PANEL_POS,
    KEY_MODES,
    KEY_TONICS,
    PDC_PANEL_POS_KEY,
    resolveKeyModeIndex,
    resolveKeyTonicIndex,
    TIME_SIGNATURES,
} from './model/transportBarDomain';
import { DebugPanel } from './ui/DebugPanel';
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
    Pencil,
    Bot,
} from 'lucide-react';

interface TransportBarProps {
    onSettingsClick?: () => void;
    onOpenExport?: () => void;
    onRecordingStateChange?: (state: { active: boolean; trackIndex: number }) => void;
    followPlayhead?: boolean;
    onFollowPlayheadChange?: (enabled: boolean) => void;
    automationVisible?: boolean;
    onAutomationToggle?: () => void;
    onFitTimelineHorizontally?: () => void;
    onResetTrackHeights?: () => void;
    assistantOpen?: boolean;
    onAssistantToggle?: () => void;
}

export const TransportBar = ({
    onSettingsClick,
    onOpenExport,
    onRecordingStateChange,
    followPlayhead = false,
    onFollowPlayheadChange,
    automationVisible = false,
    onAutomationToggle,
    onFitTimelineHorizontally,
    onResetTrackHeights,
    assistantOpen = false,
    onAssistantToggle,
}: TransportBarProps) => {
    const {
        isPlaying,
        bpm,
        isLooping,
        loopStartFrames,
        loopEndFrames,
        sampleRate,
        posBeats,
        togglePlay,
        engineStop,
        engineSetBpm,
        engineSetLoop,
        projectTracks,
        telemetryRunning,
        engineConnected,
        engineLastError,
        sandboxSnapshot,
        storeKeySigEnabled,
        storeKeySigTonic,
        storeKeySigMode,
    } = useTransportEngineSlice();
    const pianoPencilMode = useGridStore((s) => s.pianoPencilMode);
    const togglePianoPencilMode = useGridStore((s) => s.togglePianoPencilMode);

    const [isRecording, setIsRecording] = useState(false);
    const [bpmEditing, setBpmEditing] = useState(false);
    const [bpmText, setBpmText] = useState(bpm.toFixed(2));
    const bpmRef = useRef<HTMLInputElement>(null);

    const [timeSigIndex, setTimeSigIndex] = useState(0);
    const [timeSigNum, timeSigDen] = TIME_SIGNATURES[timeSigIndex] ?? [4, 4];

    const [keyEnabled, setKeyEnabled] = useState(storeKeySigEnabled);
    const [keyTonic, setKeyTonic] = useState(() => resolveKeyTonicIndex(storeKeySigTonic));
    const [keyMode, setKeyMode] = useState(() => resolveKeyModeIndex(storeKeySigMode));

    // Sync local key sig state when project changes (e.g. project load).
    useEffect(() => {
        setKeyEnabled(storeKeySigEnabled);
        setKeyTonic(resolveKeyTonicIndex(storeKeySigTonic));
        setKeyMode(resolveKeyModeIndex(storeKeySigMode));
    }, [storeKeySigEnabled, storeKeySigTonic, storeKeySigMode]);

    const position = computeTransportPosition(posBeats, timeSigNum);

    const tapTimestamps = useRef<number[]>([]);
    const midiLedRef = useRef<HTMLSpanElement>(null);
    const midiLedTimerRef = useRef<number | null>(null);
    const [pdcOpen, setPdcOpen] = useState(false);
    const [debugTab, setDebugTab] = useState<'overview' | 'pdc' | 'sandbox'>('overview');
    const [pdcLoading, setPdcLoading] = useState(false);
    const [pdcError, setPdcError] = useState<string | null>(null);
    const [pdcSnapshot, setPdcSnapshot] = useState<engineApi.PdcDebugSnapshot | null>(null);
    const [rtSnapshot, setRtSnapshot] = useState<engineApi.RtDebugSnapshot | null>(null);
    const [rtLoading, setRtLoading] = useState(false);
    const [rtError, setRtError] = useState<string | null>(null);
    const [sandboxLoading, setSandboxLoading] = useState(false);
    const [sandboxError, setSandboxError] = useState<string | null>(null);
    const [sandboxRuntime, setSandboxRuntime] = useState<engineApi.PluginSandboxSnapshot | null>(null);
    const pdcPanelRef = useRef<HTMLDivElement | null>(null);
    const [pdcPanelPos, setPdcPanelPos] = useState(DEFAULT_PDC_PANEL_POS);
    const dragRef = useRef<{ dragging: boolean; startX: number; startY: number; baseRight: number; baseTop: number }>({
        dragging: false,
        startX: 0,
        startY: 0,
        baseRight: DEFAULT_PDC_PANEL_POS.right,
        baseTop: DEFAULT_PDC_PANEL_POS.top,
    });

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

    const loadRtSnapshot = useCallback(async () => {
        setRtLoading(true);
        try {
            const snapshot = await engineApi.getRtDebugSnapshot();
            setRtSnapshot(snapshot);
            setRtError(null);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setRtError(msg);
        } finally {
            setRtLoading(false);
        }
    }, []);

    const loadSandboxSnapshot = useCallback(async () => {
        setSandboxLoading(true);
        try {
            const snapshot = await engineApi.getPluginSandboxRuntime();
            setSandboxRuntime(snapshot);
            setSandboxError(null);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setSandboxError(msg);
        } finally {
            setSandboxLoading(false);
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

    const cycleKeyTonic = () => {
        const next = (keyTonic + 1) % KEY_TONICS.length;
        setKeyTonic(next);
        void engineApi
            .setKeySignatureWithDeltas(keyEnabled, KEY_TONICS[next], KEY_MODES[keyMode])
            .then((response) => useEngineStore.getState().applyProjectDeltas(response.deltas, 'transport:key-tonic'));
    };
    const cycleKeyMode = () => {
        const next = (keyMode + 1) % KEY_MODES.length;
        setKeyMode(next);
        void engineApi
            .setKeySignatureWithDeltas(keyEnabled, KEY_TONICS[keyTonic], KEY_MODES[next])
            .then((response) => useEngineStore.getState().applyProjectDeltas(response.deltas, 'transport:key-mode'));
    };
    const cycleTimeSignature = () => setTimeSigIndex((i) => (i + 1) % TIME_SIGNATURES.length);
    const posString = `${position.bar}.${position.beat}.${position.sub.toString().padStart(2, '0')}`;
    const valueChipStyle: React.CSSProperties = {
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--font-size-sm)',
        fontWeight: 'var(--font-weight-bold)' as unknown as number,
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
        let cancelled = false;

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
            if (cancelled) fn(); else unlisten = fn;
        }).catch((err) => {
            console.error('[TransportBar] midi_event_received listener failed:', err);
        });

        return () => {
            cancelled = true;
            if (midiLedTimerRef.current !== null) {
                window.clearTimeout(midiLedTimerRef.current);
                midiLedTimerRef.current = null;
            }
            if (unlisten) unlisten();
        };
    }, []);

    useEffect(() => {
        try {
            const raw = window.localStorage.getItem(PDC_PANEL_POS_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw) as { right?: number; top?: number };
            if (typeof parsed.right === 'number' && typeof parsed.top === 'number') {
                setPdcPanelPos({
                    right: Math.max(8, Math.min(parsed.right, window.innerWidth - 220)),
                    top: Math.max(40, Math.min(parsed.top, window.innerHeight - 220)),
                });
            }
        } catch {
            // Ignore corrupted localStorage payload.
        }
    }, []);

    useEffect(() => {
        try {
            window.localStorage.setItem(PDC_PANEL_POS_KEY, JSON.stringify(pdcPanelPos));
        } catch {
            // Ignore storage write failures (private mode/full storage).
        }
    }, [pdcPanelPos]);

    useEffect(() => {
        if (!pdcOpen) return;
        void loadPdcSnapshot();
        void loadRtSnapshot();
        void loadSandboxSnapshot();
        const id = window.setInterval(() => {
            void loadPdcSnapshot();
            void loadRtSnapshot();
            void loadSandboxSnapshot();
        }, 1500);
        return () => window.clearInterval(id);
    }, [pdcOpen, loadPdcSnapshot, loadRtSnapshot, loadSandboxSnapshot]);

    useEffect(() => {
        void engineApi.setRtDebugEnabled(pdcOpen).catch((err) => {
            console.warn('[TransportBar] setRtDebugEnabled failed:', err);
        });
    }, [pdcOpen]);

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

    const handlePdcDragStart = (e: React.MouseEvent<HTMLDivElement>) => {
        dragRef.current = {
            dragging: true,
            startX: e.clientX,
            startY: e.clientY,
            baseRight: pdcPanelPos.right,
            baseTop: pdcPanelPos.top,
        };
        e.preventDefault();
    };

    useEffect(() => {
        if (!pdcOpen) return;
        const onMove = (e: MouseEvent) => {
            if (!dragRef.current.dragging) return;
            const dx = e.clientX - dragRef.current.startX;
            const dy = e.clientY - dragRef.current.startY;
            const nextRight = Math.max(8, Math.min(dragRef.current.baseRight - dx, window.innerWidth - 220));
            const nextTop = Math.max(40, Math.min(dragRef.current.baseTop + dy, window.innerHeight - 220));
            setPdcPanelPos({ right: nextRight, top: nextTop });
        };
        const onUp = () => {
            dragRef.current.dragging = false;
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        return () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
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
                            onClick={() => {
                                const next = !keyEnabled;
                                setKeyEnabled(next);
                                void engineApi
                                    .setKeySignatureWithDeltas(next, KEY_TONICS[keyTonic], KEY_MODES[keyMode])
                                    .then((response) => useEngineStore.getState().applyProjectDeltas(response.deltas, 'transport:key-enabled'));
                            }}
                        />
                        <ControlButton label={KEY_TONICS[keyTonic]} onClick={cycleKeyTonic} />
                        <ControlButton label={KEY_MODES[keyMode]} onClick={cycleKeyMode} />
                    </PillSection>
                </div>

                <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)' }}>
                    <PillSection>
                        <TransportBtn icon={<Rewind size={13} fill="currentColor" />} title="Rewind to Start" onClick={() => { void engineApi.seekToBeat(0); }} />
                        <TransportBtn
                            icon={<Play size={13} fill="currentColor" />}
                            title="Play"
                            isActive={isPlaying}
                            activeColor="var(--color-status-success)"
                            activeBackground={false}
                            onClick={() => {
                                void engineApi.stopPreview().catch((err) => {
                                    console.warn('[TransportBar] stopPreview before play failed:', err);
                                });
                                togglePlay();
                            }}
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
                                    const sr = resolveSampleRate(sampleRate);
                                    const currentBpm = bpm || 120;
                                    const startF = beatToFrame(posBeats, currentBpm, sr);
                                    const endF = beatToFrame(posBeats + timeSigNum, currentBpm, sr);
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
                            icon={<Pencil size={13} />}
                            title="Pencil Mode"
                            isActive={pianoPencilMode}
                            activeColor="var(--color-accent-primary)"
                            onClick={togglePianoPencilMode}
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
                        <ControlButton label="W" onClick={() => onFitTimelineHorizontally?.()} />
                        <ControlButton label="H" onClick={() => onResetTrackHeights?.()} />
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
                                background: 'var(--color-status-success)',
                                opacity: 0.35,
                                boxShadow: '0 0 8px color-mix(in srgb, var(--color-status-success) 75%, transparent)',
                                transition: 'opacity 40ms linear',
                            }}
                        />
                        <span style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--font-weight-semibold)' as unknown as number, color: 'var(--color-midi-indicator)' }}>MIDI</span>
                        <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                            {projectTracks.length} Tracks
                        </span>
                        <button
                            onClick={() => setPdcOpen((v) => !v)}
                            title="Debug Panel"
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
                            onClick={() => onAssistantToggle?.()}
                            title="AI Assistant"
                            style={{
                                width: 24,
                                height: 24,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: assistantOpen
                                    ? 'color-mix(in srgb, var(--color-accent-primary) 14%, transparent)'
                                    : 'transparent',
                                border: 'none',
                                borderRadius: 'var(--radius-xs)',
                                color: assistantOpen
                                    ? 'var(--color-accent-primary)'
                                    : 'var(--color-text-secondary)',
                                cursor: 'pointer',
                            }}
                        >
                            <Bot size={15} />
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
                    <DebugPanel
                        panelRef={pdcPanelRef}
                        panelPos={pdcPanelPos}
                        onDragStart={handlePdcDragStart}
                        onRefresh={() => {
                            void loadPdcSnapshot();
                            void loadRtSnapshot();
                            void loadSandboxSnapshot();
                        }}
                        onClose={() => setPdcOpen(false)}
                        debugTab={debugTab}
                        setDebugTab={setDebugTab}
                        onTickWatchdog={() => {
                            void engineApi.tickPluginSandboxWatchdog().then(setSandboxRuntime).catch((err) => {
                                setSandboxError(err instanceof Error ? err.message : String(err));
                            });
                        }}
                        pdcSnapshot={pdcSnapshot}
                        rtSnapshot={rtSnapshot}
                        sandboxSnapshot={sandboxSnapshot}
                        sandboxRuntime={sandboxRuntime}
                        engineConnected={engineConnected}
                        telemetryRunning={telemetryRunning}
                        isPlaying={isPlaying}
                        bpm={bpm}
                        posString={posString}
                        sampleRate={sampleRate}
                        trackCount={projectTracks.length}
                        engineLastError={engineLastError ?? ''}
                        pdcLoading={pdcLoading}
                        rtLoading={rtLoading}
                        sandboxLoading={sandboxLoading}
                        pdcError={pdcError}
                        rtError={rtError}
                        sandboxError={sandboxError}
                    />
                )}
            </div>
        </div>
    );
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
