// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Export Modal (Render/Bounce to Disk)
// ═══════════════════════════════════════════════════════════════════════════
//
// Enterprise-grade offline bounce dialog.
//
// Architecture:
//   1. User configures format (WAV/MP3), sample rate, bit depth, range
//   2. "Bounce" opens native OS save dialog (Tauri dialog plugin)
//   3. Rust starts background export job immediately
//   4. Global BlockingJobPopup locks UI and shows progress/cancel
//
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback } from 'react';
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

    // ── Submit State ─────────────────────────────────────────────────
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [bounceError, setBounceError] = useState<string | null>(null);

    // ── Reset state when modal opens ─────────────────────────────────
    useEffect(() => {
        if (isOpen) {
            setIsSubmitting(false);
            setBounceError(null);
        }
    }, [isOpen]);

    // ── Bounce Handler ───────────────────────────────────────────────
    const handleBounce = useCallback(async () => {
        setBounceError(null);
        setIsSubmitting(true);

        try {
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
                setIsSubmitting(false);
                return;
            }

            // 2. Fire export as background job (blocking popup is global).
            await engineApi.exportMix({
                outputPath,
                sampleRate,
                bitDepth,
                range: exportRange,
                normalize,
                tailMs,
                format,
            });
            onClose();

        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[ExportModal] Bounce failed:', msg);
            setBounceError(msg);
        } finally {
            setIsSubmitting(false);
        }
    }, [sampleRate, bitDepth, exportRange, normalize, tailMs, format, projectName, onClose]);

    if (!isOpen) return null;

    return (
        <>
            {/* ── Modal Backdrop ── */}
            <div
                onClick={isSubmitting ? undefined : onClose}
                style={{
                    position: 'fixed',
                    inset: 0,
                    zIndex: 'var(--z-modal)' as unknown as number,
                    background: 'var(--color-overlay-modal)',
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
                zIndex: 'var(--z-modal-content)' as unknown as number,
                width: 420,
                background: 'var(--color-bg-panel)',
                border: '1px solid var(--color-border-subtle)',
                borderRadius: 'var(--radius-2xl)',
                padding: 24,
                boxShadow: '0 16px 64px var(--color-overlay-dark)',
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
                        fontSize: 'var(--font-size-xl)',
                        fontWeight: 700,
                        color: 'var(--color-text-primary)',
                    }}>
                        Export Audio
                    </h2>
                    <button
                        onClick={onClose}
                        style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--color-text-secondary)',
                            fontSize: 'var(--font-size-lg)',
                            cursor: 'pointer',
                            padding: '2px 6px',
                        }}
                    >
                        ✕
                    </button>
                </div>

                {/* Project name */}
                <div style={{
                    fontSize: 'var(--font-size-xs)',
                    color: 'var(--color-text-secondary)',
                }}>
                    Project: <strong style={{ color: 'var(--color-text-primary)' }}>{projectName}</strong>
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
                            style={{ width: 120, accentColor: 'var(--color-accent-primary)' }}
                        />
                        <span style={{
                            fontSize: 'var(--font-size-sm)',
                            color: 'var(--color-text-primary)',
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
                        background: 'color-mix(in srgb, var(--color-status-error) 10%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--color-status-error) 30%, transparent)',
                        borderRadius: 'var(--radius-md)',
                        fontSize: 'var(--font-size-sm)',
                        color: 'var(--color-status-error)',
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
                        onClick={onClose}
                        disabled={isSubmitting}
                        style={{
                            padding: '8px 16px',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid var(--color-control-border)',
                            background: 'transparent',
                            color: 'var(--color-text-secondary)',
                            fontSize: 'var(--font-size-xs)',
                            fontWeight: 500,
                            cursor: isSubmitting ? 'not-allowed' : 'pointer',
                            opacity: isSubmitting ? 0.5 : 1,
                        }}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleBounce}
                        disabled={isSubmitting}
                        style={{
                            padding: '8px 20px',
                            borderRadius: 'var(--radius-md)',
                            border: 'none',
                            background: 'var(--color-accent-primary)',
                            color: 'var(--color-text-on-accent)',
                            fontSize: 'var(--font-size-xs)',
                            fontWeight: 600,
                            cursor: isSubmitting ? 'not-allowed' : 'pointer',
                            opacity: isSubmitting ? 0.5 : 1,
                            transition: `all var(--transition-fast)`,
                        }}
                    >
                        {isSubmitting ? 'Starting...' : 'Bounce'}
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
            fontSize: 'var(--font-size-xs)',
            fontWeight: 500,
            color: 'var(--color-text-secondary)',
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
                            borderRadius: 'var(--radius-md)',
                            border: isActive
                                ? '1px solid var(--color-accent-primary)'
                                : '1px solid var(--color-control-border)',
                            background: isActive
                                ? 'color-mix(in srgb, var(--color-accent-primary) 15%, transparent)'
                                : 'transparent',
                            color: isActive
                                ? 'var(--color-accent-primary)'
                                : 'var(--color-text-tertiary)',
                            fontSize: 'var(--font-size-xs)',
                            fontWeight: 600,
                            cursor: 'pointer',
                            transition: `all var(--transition-linear)`,
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
            borderRadius: 'var(--radius-xl)',
            border: 'none',
            background: checked
                ? 'var(--color-accent-primary)'
                : 'var(--color-control-bg)',
            position: 'relative',
            cursor: 'pointer',
            transition: `background var(--transition-fast)`,
        }}
    >
        <div style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: 'var(--color-text-on-accent)',
            position: 'absolute',
            top: 3,
            left: checked ? 19 : 3,
            transition: `left var(--transition-fast)`,
            boxShadow: '0 1px 3px var(--color-overlay-dark)',
        }} />
    </button>
);
