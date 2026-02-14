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
}

export const TransportBar = ({
    onSettingsClick,
    onOpenExport,
    onRecordingStateChange,
    followPlayhead = false,
    onFollowPlayheadChange,
}: TransportBarProps) => {
    const isPlaying = useEngineStore((s) => s.transport.is_playing);
    const bpm = useEngineStore((s) => s.transport.bpm);
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

    return (
        <div className="glass-pill" style={{ height: 'var(--daw-transport-height)', zIndex: 'var(--z-transport)' }}>
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
                        <TransportBtn icon={<Rewind size={13} fill="currentColor" />} title="Rewind" onClick={() => {}} />
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
