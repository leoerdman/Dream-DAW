// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Export Modal (Render/Bounce to Disk)
// ═══════════════════════════════════════════════════════════════════════════
//
// Enterprise-grade offline bounce dialog.
//
// Architecture:
//   1. User configures format (WAV/MP3), sample rate, bit depth, range
//   2. "Bounce" opens native OS save dialog (Tauri dialog plugin)
//   3. Glass overlay locks UI at z-index: 9999
//   4. Rust runs export_mix at max CPU speed (no cpal timer)
//   5. Frontend listens to 'bounce_progress' event for real-time progress
//
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import * as engineApi from '@/shared/api/engine';

// ── Types ────────────────────────────────────────────────────────────────

type ExportFormat = 'wav' | 'mp3';
type SampleRate = 44100 | 48000 | 96000;
type BitDepth = 16 | 24 | 32;
type ExportRange = 'full' | 'loop';

interface ExportModalProps {
    isOpen: boolean;
    onClose: () => void;
    projectName?: string;
}

// ── Bounce Progress Event Payload ────────────────────────────────────────

interface BounceProgressPayload {
    /** Optional job id for filtering multiple concurrent jobs. */
    jobId?: string;
    /** 0..100 percentage complete. */
    progress: number;
    /** Current phase label from Rust (e.g. "Rendering tracks...", "Normalizing..."). */
    phase?: string;
    /** Optional terminal status from backend job manager. */
    status?: 'running' | 'completed' | 'failed' | 'cancelled' | string;
}

// ── Options ──────────────────────────────────────────────────────────────

const FORMATS: { value: ExportFormat; label: string; desc: string }[] = [
    { value: 'wav', label: 'WAV', desc: 'Uncompressed, highest quality' },
    { value: 'mp3', label: 'MP3', desc: 'Compressed, smaller files (320 kbps)' },
];

const SAMPLE_RATES: { value: SampleRate; label: string }[] = [
    { value: 44100, label: '44.1 kHz' },
    { value: 48000, label: '48 kHz' },
    { value: 96000, label: '96 kHz' },
];

const BIT_DEPTHS: { value: BitDepth; label: string }[] = [
    { value: 16, label: '16-bit' },
    { value: 24, label: '24-bit' },
    { value: 32, label: '32-bit Float' },
];

// ── File Dialog Filters ──────────────────────────────────────────────────

const DIALOG_FILTERS: Record<ExportFormat, { name: string; extensions: string[] }[]> = {
    wav: [{ name: 'WAV Audio', extensions: ['wav'] }],
    mp3: [{ name: 'MP3 Audio', extensions: ['mp3'] }],
};

// ── Component ────────────────────────────────────────────────────────────

export const ExportModal = ({ isOpen, onClose, projectName = 'Untitled' }: ExportModalProps) => {
    // ── Settings State ───────────────────────────────────────────────
    const [format, setFormat] = useState<ExportFormat>('wav');
    const [sampleRate, setSampleRate] = useState<SampleRate>(48000);
    const [bitDepth, setBitDepth] = useState<BitDepth>(24);
    const [exportRange, setExportRange] = useState<ExportRange>('full');
    const [normalize, setNormalize] = useState(false);
    const [tailMs, setTailMs] = useState(500);

    // ── Bounce State ─────────────────────────────────────────────────
    const [isBouncing, setIsBouncing] = useState(false);
    const [progress, setProgress] = useState(0);
    const [phase, setPhase] = useState('');
    const [bounceError, setBounceError] = useState<string | null>(null);

    // ── Event Listener Ref ───────────────────────────────────────────
    const unlistenRef = useRef<UnlistenFn | null>(null);
    const activeJobIdRef = useRef<string | null>(null);

    // ── Cleanup event listener on unmount ─────────────────────────────
    useEffect(() => {
        return () => {
            if (unlistenRef.current) {
                unlistenRef.current();
                unlistenRef.current = null;
            }
        };
    }, []);

    // ── Reset state when modal opens ─────────────────────────────────
    useEffect(() => {
        if (isOpen) {
            setIsBouncing(false);
            setProgress(0);
            setPhase('');
            setBounceError(null);
            activeJobIdRef.current = null;
        }
    }, [isOpen]);

    // ── Bounce Handler ───────────────────────────────────────────────
    const handleBounce = useCallback(async () => {
        setBounceError(null);

        try {
            if (unlistenRef.current) {
                unlistenRef.current();
                unlistenRef.current = null;
            }

            // 1. Open native OS save dialog via Tauri dialog plugin
            const { save } = await import('@tauri-apps/plugin-dialog');
            const ext = format === 'mp3' ? 'mp3' : 'wav';
            const outputPath = await save({
                title: 'Export Audio',
                defaultPath: `${projectName}.${ext}`,
                filters: DIALOG_FILTERS[format],
            });

            if (!outputPath) {
                // User cancelled the dialog
                return;
            }

            // 2. Lock UI — enter bouncing state
            setIsBouncing(true);
            setProgress(0);
            setPhase('Initializing offline render...');

            // 3. Subscribe to bounce_progress events from Rust
            unlistenRef.current = await listen<BounceProgressPayload>('bounce_progress', (event) => {
                if (event.payload.jobId) {
                    if (activeJobIdRef.current === null) {
                        activeJobIdRef.current = event.payload.jobId;
                    }
                    if (event.payload.jobId !== activeJobIdRef.current) {
                        return;
                    }
                }
                setProgress(event.payload.progress);
                if (event.payload.phase) {
                    setPhase(event.payload.phase);
                }

                if (event.payload.status === 'failed') {
                    setBounceError('Export failed');
                    setIsBouncing(false);
                    if (unlistenRef.current) {
                        unlistenRef.current();
                        unlistenRef.current = null;
                    }
                    return;
                }

                if (event.payload.status === 'cancelled') {
                    setPhase('Export cancelled');
                    setIsBouncing(false);
                    if (unlistenRef.current) {
                        unlistenRef.current();
                        unlistenRef.current = null;
                    }
                    return;
                }

                // Auto-complete on 100%
                if (event.payload.progress >= 100) {
                    setPhase('Export complete!');
                    if (unlistenRef.current) {
                        unlistenRef.current();
                        unlistenRef.current = null;
                    }
                    setTimeout(() => {
                        setIsBouncing(false);
                        onClose();
                    }, 1200);
                }
            });

            // 4. Fire the export IPC command
            const jobId = await engineApi.exportMix({
                outputPath,
                sampleRate,
                bitDepth,
                range: exportRange,
                normalize,
                tailMs,
                format,
            });
            activeJobIdRef.current = jobId;

        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[ExportModal] Bounce failed:', msg);
            setBounceError(msg);
            setIsBouncing(false);

            // Cleanup listener
            if (unlistenRef.current) {
                unlistenRef.current();
                unlistenRef.current = null;
            }
        }
    }, [sampleRate, bitDepth, exportRange, normalize, tailMs, format, projectName, onClose]);

    if (!isOpen) return null;

    return (
        <>
            {/* ── Glass Overlay (locks entire UI during bounce) ── */}
            {isBouncing && (
                <div style={{
                    position: 'fixed',
                    inset: 0,
                    zIndex: 9999,
                    background: 'rgba(0, 0, 0, 0.65)',
                    backdropFilter: 'blur(8px)',
                    WebkitBackdropFilter: 'blur(8px)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 20,
                }}>
                    {/* Progress Ring + Percentage */}
                    <div style={{ position: 'relative', width: 120, height: 120 }}>
                        <svg width="120" height="120" viewBox="0 0 120 120">
                            {/* Background ring */}
                            <circle
                                cx="60" cy="60" r="52"
                                fill="none"
                                stroke="rgba(255,255,255,0.08)"
                                strokeWidth="6"
                            />
                            {/* Progress ring */}
                            <circle
                                cx="60" cy="60" r="52"
                                fill="none"
                                stroke="var(--color-accent-primary, #58a6ff)"
                                strokeWidth="6"
                                strokeLinecap="round"
                                strokeDasharray={`${2 * Math.PI * 52}`}
                                strokeDashoffset={`${2 * Math.PI * 52 * (1 - progress / 100)}`}
                                transform="rotate(-90 60 60)"
                                style={{ transition: 'stroke-dashoffset 0.2s ease' }}
                            />
                        </svg>
                        <div style={{
                            position: 'absolute',
                            inset: 0,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}>
                            <span style={{
                                fontSize: 28,
                                fontWeight: 700,
                                color: '#fff',
                                fontFamily: 'var(--font-mono)',
                            }}>
                                {Math.round(progress)}%
                            </span>
                        </div>
                    </div>

                    {/* Phase label */}
                    <span style={{
                        fontSize: 13,
                        color: 'rgba(255,255,255,0.7)',
                        fontWeight: 500,
                        textAlign: 'center',
                    }}>
                        {phase}
                    </span>

                    {/* Linear progress bar */}
                    <div style={{
                        width: 280,
                        height: 4,
                        borderRadius: 2,
                        background: 'rgba(255,255,255,0.08)',
                        overflow: 'hidden',
                    }}>
                        <div style={{
                            width: `${progress}%`,
                            height: '100%',
                            background: 'var(--color-accent-primary, #58a6ff)',
                            borderRadius: 2,
                            transition: 'width 0.15s ease',
                        }} />
                    </div>
                </div>
            )}

            {/* ── Modal Backdrop ── */}
            <div
                onClick={isBouncing ? undefined : onClose}
                style={{
                    position: 'fixed',
                    inset: 0,
                    zIndex: 9000,
                    background: 'rgba(0, 0, 0, 0.5)',
                    backdropFilter: 'blur(4px)',
                    WebkitBackdropFilter: 'blur(4px)',
                }}
            />

            {/* ── Modal Panel ── */}
            <div style={{
                position: 'fixed',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                zIndex: 9001,
                width: 420,
                background: 'var(--color-bg-panel, #1a1a1a)',
                border: '1px solid var(--color-border-subtle, #333)',
                borderRadius: 12,
                padding: 24,
                boxShadow: '0 16px 64px rgba(0,0,0,0.6)',
                display: 'flex',
                flexDirection: 'column',
                gap: 16,
            }}>
                {/* Header */}
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                }}>
                    <h2 style={{
                        margin: 0,
                        fontSize: 16,
                        fontWeight: 700,
                        color: 'var(--color-text-primary, #fff)',
                    }}>
                        Export Audio
                    </h2>
                    <button
                        onClick={onClose}
                        style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--color-text-secondary, #888)',
                            fontSize: 18,
                            cursor: 'pointer',
                            padding: '2px 6px',
                        }}
                    >
                        ✕
                    </button>
                </div>

                {/* Project name */}
                <div style={{
                    fontSize: 12,
                    color: 'var(--color-text-secondary, #aaa)',
                }}>
                    Project: <strong style={{ color: 'var(--color-text-primary, #fff)' }}>{projectName}</strong>
                </div>

                {/* ── Format ── */}
                <SettingRow label="Format">
                    <ChipGroup
                        options={FORMATS.map(f => ({ value: f.value, label: f.label }))}
                        value={format}
                        onChange={setFormat}
                    />
                </SettingRow>

                {/* ── Sample Rate ── */}
                <SettingRow label="Sample Rate">
                    <ChipGroup
                        options={SAMPLE_RATES}
                        value={sampleRate}
                        onChange={setSampleRate}
                    />
                </SettingRow>

                {/* ── Bit Depth (WAV only) ── */}
                {format === 'wav' && (
                    <SettingRow label="Bit Depth">
                        <ChipGroup
                            options={BIT_DEPTHS}
                            value={bitDepth}
                            onChange={setBitDepth}
                        />
                    </SettingRow>
                )}

                {/* ── Export Range ── */}
                <SettingRow label="Range">
                    <ChipGroup
                        options={[
                            { value: 'full' as ExportRange, label: 'Full Project' },
                            { value: 'loop' as ExportRange, label: 'Loop Region' },
                        ]}
                        value={exportRange}
                        onChange={setExportRange}
                    />
                </SettingRow>

                {/* ── Normalize ── */}
                <SettingRow label="Normalize">
                    <ToggleSwitch checked={normalize} onChange={setNormalize} />
                </SettingRow>

                {/* ── Tail Length ── */}
                <SettingRow label="Tail (ms)">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                            type="range"
                            min={0}
                            max={5000}
                            step={100}
                            value={tailMs}
                            onChange={e => setTailMs(Number(e.target.value))}
                            style={{ width: 120, accentColor: 'var(--color-accent-primary, #58a6ff)' }}
                        />
                        <span style={{
                            fontSize: 11,
                            color: 'var(--color-text-primary, #fff)',
                            fontFamily: 'var(--font-mono)',
                            minWidth: 40,
                        }}>
                            {tailMs}ms
                        </span>
                    </div>
                </SettingRow>

                {/* ── Error Display ── */}
                {bounceError && (
                    <div style={{
                        padding: '8px 12px',
                        background: 'rgba(255, 60, 60, 0.1)',
                        border: '1px solid rgba(255, 60, 60, 0.3)',
                        borderRadius: 6,
                        fontSize: 11,
                        color: '#ff5c5c',
                    }}>
                        {bounceError}
                    </div>
                )}

                {/* ── Actions ── */}
                <div style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    gap: 8,
                    paddingTop: 4,
                }}>
                    <button
                        onClick={() => {
                            if (isBouncing) {
                                const currentJobId = activeJobIdRef.current;
                                if (currentJobId) {
                                    void engineApi.cancelBackgroundJob(currentJobId)
                                        .catch(() => engineApi.cancelExport());
                                } else {
                                    void engineApi.cancelExport();
                                }
                                return;
                            }
                            onClose();
                        }}
                        style={{
                            padding: '8px 16px',
                            borderRadius: 6,
                            border: '1px solid var(--color-control-border, #444)',
                            background: 'transparent',
                            color: 'var(--color-text-secondary, #aaa)',
                            fontSize: 12,
                            fontWeight: 500,
                            cursor: 'pointer',
                            opacity: 1,
                        }}
                    >
                        {isBouncing ? 'Stop' : 'Cancel'}
                    </button>
                    <button
                        onClick={handleBounce}
                        disabled={isBouncing}
                        style={{
                            padding: '8px 20px',
                            borderRadius: 6,
                            border: 'none',
                            background: 'var(--color-accent-primary, #58a6ff)',
                            color: '#fff',
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: isBouncing ? 'not-allowed' : 'pointer',
                            opacity: isBouncing ? 0.5 : 1,
                            transition: 'all 0.15s ease',
                        }}
                    >
                        Bounce
                    </button>
                </div>
            </div>
        </>
    );
};

// ═══════════════════════════════════════════════════════════════════════════
// Sub-Components
// ═══════════════════════════════════════════════════════════════════════════

/** Row container for a setting label + control. */
const SettingRow = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
    }}>
        <span style={{
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--color-text-secondary, #aaa)',
        }}>
            {label}
        </span>
        {children}
    </div>
);

/** Chip group for selecting from a set of options (radio-button style). */
function ChipGroup<T extends string | number>({
    options,
    value,
    onChange,
}: {
    options: { value: T; label: string }[];
    value: T;
    onChange: (v: T) => void;
}) {
    return (
        <div style={{ display: 'flex', gap: 4 }}>
            {options.map((opt) => {
                const isActive = opt.value === value;
                return (
                    <button
                        key={String(opt.value)}
                        onClick={() => onChange(opt.value)}
                        style={{
                            padding: '4px 10px',
                            borderRadius: 4,
                            border: isActive
                                ? '1px solid var(--color-accent-primary, #58a6ff)'
                                : '1px solid var(--color-control-border, #444)',
                            background: isActive
                                ? 'color-mix(in srgb, var(--color-accent-primary, #58a6ff) 15%, transparent)'
                                : 'transparent',
                            color: isActive
                                ? 'var(--color-accent-primary, #58a6ff)'
                                : 'var(--color-text-tertiary, #777)',
                            fontSize: 10,
                            fontWeight: 600,
                            cursor: 'pointer',
                            transition: 'all 0.12s ease',
                        }}
                    >
                        {opt.label}
                    </button>
                );
            })}
        </div>
    );
}

/** Toggle switch component. */
const ToggleSwitch = ({
    checked,
    onChange,
}: {
    checked: boolean;
    onChange: (v: boolean) => void;
}) => (
    <button
        onClick={() => onChange(!checked)}
        style={{
            width: 36,
            height: 20,
            borderRadius: 10,
            border: 'none',
            background: checked
                ? 'var(--color-accent-primary, #58a6ff)'
                : 'var(--color-control-bg, #333)',
            position: 'relative',
            cursor: 'pointer',
            transition: 'background 0.15s ease',
        }}
    >
        <div style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: '#fff',
            position: 'absolute',
            top: 3,
            left: checked ? 19 : 3,
            transition: 'left 0.15s ease',
            boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
        }} />
    </button>
);
