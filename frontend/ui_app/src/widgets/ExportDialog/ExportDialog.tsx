// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — ExportDialog (Render/Bounce to Disk)
// ═══════════════════════════════════════════════════════════════════════════
//
// LEVIATHAN Epic 4: Modal dialog for exporting/bouncing the project.
//
// Features:
//   - Format selection (WAV, AIFF, MP3, FLAC, OGG)
//   - Bit depth & sample rate settings
//   - Export range (full project / loop region / selection)
//   - Real-time / offline rendering toggle
//   - Tail length for reverb/delay tails
//   - Normalize option
//   - Progress bar for active exports
//
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useCallback, memo } from 'react';

// ── Types ────────────────────────────────────────────────────────────────

export type ExportFormat = 'wav' | 'aiff' | 'mp3' | 'flac' | 'ogg';
export type ExportRange = 'full' | 'loop' | 'selection';
export type BitDepth = 16 | 24 | 32;
export type SampleRate = 44100 | 48000 | 88200 | 96000;

interface ExportSettings {
    format: ExportFormat;
    bitDepth: BitDepth;
    sampleRate: SampleRate;
    range: ExportRange;
    normalize: boolean;
    tailMs: number;
    realtime: boolean;
    fileName: string;
}

interface ExportDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onExport: (settings: ExportSettings) => void;
    projectName?: string;
    /** Whether an export is currently in progress. */
    isExporting?: boolean;
    /** Export progress 0..100. */
    progress?: number;
}

// ── Constants ────────────────────────────────────────────────────────────

const FORMATS: { value: ExportFormat; label: string; desc: string }[] = [
    { value: 'wav', label: 'WAV', desc: 'Uncompressed, highest quality' },
    { value: 'aiff', label: 'AIFF', desc: 'Uncompressed (Apple)' },
    { value: 'flac', label: 'FLAC', desc: 'Lossless compression' },
    { value: 'mp3', label: 'MP3', desc: 'Lossy, small files' },
    { value: 'ogg', label: 'OGG', desc: 'Lossy, open format' },
];

const BIT_DEPTHS: BitDepth[] = [16, 24, 32];
const SAMPLE_RATES: SampleRate[] = [44100, 48000, 88200, 96000];

// ── Component ────────────────────────────────────────────────────────────

export const ExportDialog = memo(function ExportDialog({
    isOpen,
    onClose,
    onExport,
    projectName = 'Untitled',
    isExporting = false,
    progress = 0,
}: ExportDialogProps) {
    const [settings, setSettings] = useState<ExportSettings>({
        format: 'wav',
        bitDepth: 24,
        sampleRate: 48000,
        range: 'full',
        normalize: false,
        tailMs: 500,
        realtime: false,
        fileName: projectName,
    });

    const updateSetting = useCallback(<K extends keyof ExportSettings>(key: K, value: ExportSettings[K]) => {
        setSettings((prev) => ({ ...prev, [key]: value }));
    }, []);

    const handleExport = useCallback(() => {
        onExport(settings);
    }, [settings, onExport]);

    if (!isOpen) return null;

    return (
        <div style={overlayStyle}>
            <div style={dialogStyle}>
                {/* ── Header ── */}
                <div style={headerStyle}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>
                        Export Audio
                    </span>
                    <button onClick={onClose} style={closeBtnStyle}>✕</button>
                </div>

                {/* ── Body ── */}
                <div style={bodyStyle}>
                    {/* File name */}
                    <Row label="File Name">
                        <input
                            type="text"
                            value={settings.fileName}
                            onChange={(e) => updateSetting('fileName', e.target.value)}
                            style={inputStyle}
                        />
                    </Row>

                    {/* Format selector */}
                    <Row label="Format">
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {FORMATS.map(f => (
                                <button
                                    key={f.value}
                                    onClick={() => updateSetting('format', f.value)}
                                    title={f.desc}
                                    style={{
                                        ...chipStyle,
                                        background: settings.format === f.value
                                            ? 'var(--color-accent-primary)'
                                            : 'rgba(255,255,255,0.06)',
                                        color: settings.format === f.value ? '#fff' : 'var(--color-text-secondary)',
                                        fontWeight: settings.format === f.value ? 700 : 400,
                                    }}
                                >
                                    {f.label}
                                </button>
                            ))}
                        </div>
                    </Row>

                    {/* Bit depth (only for lossless) */}
                    {(settings.format === 'wav' || settings.format === 'aiff' || settings.format === 'flac') && (
                        <Row label="Bit Depth">
                            <div style={{ display: 'flex', gap: 4 }}>
                                {BIT_DEPTHS.map(b => (
                                    <button
                                        key={b}
                                        onClick={() => updateSetting('bitDepth', b)}
                                        style={{
                                            ...chipStyle,
                                            background: settings.bitDepth === b
                                                ? 'var(--color-accent-primary)'
                                                : 'rgba(255,255,255,0.06)',
                                            color: settings.bitDepth === b ? '#fff' : 'var(--color-text-secondary)',
                                            fontWeight: settings.bitDepth === b ? 700 : 400,
                                        }}
                                    >
                                        {b}-bit
                                    </button>
                                ))}
                            </div>
                        </Row>
                    )}

                    {/* Sample rate */}
                    <Row label="Sample Rate">
                        <div style={{ display: 'flex', gap: 4 }}>
                            {SAMPLE_RATES.map(sr => (
                                <button
                                    key={sr}
                                    onClick={() => updateSetting('sampleRate', sr)}
                                    style={{
                                        ...chipStyle,
                                        background: settings.sampleRate === sr
                                            ? 'var(--color-accent-primary)'
                                            : 'rgba(255,255,255,0.06)',
                                        color: settings.sampleRate === sr ? '#fff' : 'var(--color-text-secondary)',
                                        fontWeight: settings.sampleRate === sr ? 700 : 400,
                                    }}
                                >
                                    {sr / 1000}k
                                </button>
                            ))}
                        </div>
                    </Row>

                    {/* Export range */}
                    <Row label="Range">
                        <div style={{ display: 'flex', gap: 4 }}>
                            {(['full', 'loop', 'selection'] as const).map(r => (
                                <button
                                    key={r}
                                    onClick={() => updateSetting('range', r)}
                                    style={{
                                        ...chipStyle,
                                        background: settings.range === r
                                            ? 'var(--color-accent-primary)'
                                            : 'rgba(255,255,255,0.06)',
                                        color: settings.range === r ? '#fff' : 'var(--color-text-secondary)',
                                        fontWeight: settings.range === r ? 700 : 400,
                                    }}
                                >
                                    {r === 'full' ? 'Full Project' : r === 'loop' ? 'Loop Region' : 'Selection'}
                                </button>
                            ))}
                        </div>
                    </Row>

                    {/* Options */}
                    <Row label="Options">
                        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                            <label style={checkboxLabelStyle}>
                                <input
                                    type="checkbox"
                                    checked={settings.normalize}
                                    onChange={(e) => updateSetting('normalize', e.target.checked)}
                                />
                                <span>Normalize</span>
                            </label>
                            <label style={checkboxLabelStyle}>
                                <input
                                    type="checkbox"
                                    checked={settings.realtime}
                                    onChange={(e) => updateSetting('realtime', e.target.checked)}
                                />
                                <span>Realtime</span>
                            </label>
                        </div>
                    </Row>

                    {/* Tail length */}
                    <Row label="Tail">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <input
                                type="range"
                                min={0}
                                max={5000}
                                step={100}
                                value={settings.tailMs}
                                onChange={(e) => updateSetting('tailMs', Number(e.target.value))}
                                style={{ width: 120 }}
                            />
                            <span style={{ fontSize: 10, color: 'var(--color-text-secondary)', minWidth: 40 }}>
                                {settings.tailMs}ms
                            </span>
                        </div>
                    </Row>
                </div>

                {/* ── Progress bar (when exporting) ── */}
                {isExporting && (
                    <div style={{ padding: '0 16px 8px' }}>
                        <div style={{
                            width: '100%',
                            height: 4,
                            background: 'rgba(255,255,255,0.08)',
                            borderRadius: 2,
                            overflow: 'hidden',
                        }}>
                            <div style={{
                                width: `${progress}%`,
                                height: '100%',
                                background: 'var(--color-accent-primary)',
                                borderRadius: 2,
                                transition: 'width 0.3s linear',
                            }} />
                        </div>
                        <div style={{ fontSize: 9, color: 'var(--color-text-tertiary)', textAlign: 'center', marginTop: 4 }}>
                            Exporting... {Math.round(progress)}%
                        </div>
                    </div>
                )}

                {/* ── Footer ── */}
                <div style={footerStyle}>
                    <button onClick={onClose} style={cancelBtnStyle}>
                        Cancel
                    </button>
                    <button
                        onClick={handleExport}
                        disabled={isExporting}
                        style={{
                            ...exportBtnStyle,
                            opacity: isExporting ? 0.6 : 1,
                            cursor: isExporting ? 'not-allowed' : 'pointer',
                        }}
                    >
                        {isExporting ? 'Exporting...' : 'Export'}
                    </button>
                </div>
            </div>
        </div>
    );
});

// ── Sub-components ────────────────────────────────────────────────────────

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 32 }}>
            <span style={{
                width: 80,
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--color-text-secondary)',
                textAlign: 'right',
                flexShrink: 0,
            }}>
                {label}
            </span>
            <div style={{ flex: 1 }}>
                {children}
            </div>
        </div>
    );
}

// ── Styles ────────────────────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.5)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10000,
};

const dialogStyle: React.CSSProperties = {
    width: 440,
    maxHeight: '80vh',
    background: '#1a1a1e',
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.08)',
    boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
};

const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: '1px solid var(--color-divider)',
};

const bodyStyle: React.CSSProperties = {
    flex: 1,
    padding: '12px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    overflowY: 'auto',
};

const footerStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    padding: '12px 16px',
    borderTop: '1px solid var(--color-divider)',
};

const closeBtnStyle: React.CSSProperties = {
    width: 24,
    height: 24,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    color: 'var(--color-text-tertiary)',
    border: 'none',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
};

const chipStyle: React.CSSProperties = {
    padding: '4px 10px',
    borderRadius: 4,
    border: '1px solid rgba(255,255,255,0.08)',
    fontSize: 10,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
};

const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '4px 8px',
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 4,
    color: '#fff',
    fontSize: 11,
    outline: 'none',
};

const checkboxLabelStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 10,
    color: 'var(--color-text-secondary)',
    cursor: 'pointer',
};

const cancelBtnStyle: React.CSSProperties = {
    padding: '6px 16px',
    background: 'transparent',
    color: 'var(--color-text-secondary)',
    border: '1px solid var(--color-control-border)',
    borderRadius: 6,
    fontSize: 11,
    cursor: 'pointer',
};

const exportBtnStyle: React.CSSProperties = {
    padding: '6px 24px',
    background: 'var(--color-accent-primary)',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    fontSize: 11,
    fontWeight: 700,
    cursor: 'pointer',
};

export default ExportDialog;
