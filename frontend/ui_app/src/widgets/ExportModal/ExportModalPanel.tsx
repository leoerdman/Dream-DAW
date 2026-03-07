import type { ReactNode } from 'react';
import {
    BIT_DEPTHS,
    FORMATS,
    SAMPLE_RATES,
    type BitDepth,
    type ExportFormat,
    type ExportRange,
    type SampleRate,
} from './exportModalConfig';

interface RangeInfo {
    startBar: number;
    endBar: number;
    durationBeats: number;
    durationFormatted: string;
}

interface ExportModalPanelProps {
    isSubmitting: boolean;
    onClose: () => void;
    projectName: string;
    format: ExportFormat;
    setFormat: (v: ExportFormat) => void;
    exportSampleRate: SampleRate;
    setExportSampleRate: (v: SampleRate) => void;
    bitDepth: BitDepth;
    setBitDepth: (v: BitDepth) => void;
    rangeOptions: { value: ExportRange; label: string }[];
    exportRange: ExportRange;
    setExportRange: (v: ExportRange) => void;
    rangeInfo: RangeInfo;
    normalize: boolean;
    setNormalize: (v: boolean) => void;
    includeTail: boolean;
    setIncludeTail: (v: boolean) => void;
    bounceError: string | null;
    canBounce: boolean;
    bounceDisabledReason: string | null;
    onBounce: () => void;
}

export function ExportModalPanel({
    isSubmitting,
    onClose,
    projectName,
    format,
    setFormat,
    exportSampleRate,
    setExportSampleRate,
    bitDepth,
    setBitDepth,
    rangeOptions,
    exportRange,
    setExportRange,
    rangeInfo,
    normalize,
    setNormalize,
    includeTail,
    setIncludeTail,
    bounceError,
    canBounce,
    bounceDisabledReason,
    onBounce,
}: ExportModalPanelProps) {
    return (
        <div style={{ zIndex: 'var(--z-modal-content)', width: 'min(440px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 32px)', overflowY: 'auto', background: 'var(--color-bg-panel)', border: 'var(--space-px) solid var(--color-border-subtle)', borderRadius: 'var(--radius-2xl)', padding: 24, boxShadow: '0 var(--space-4) var(--space-16) var(--color-overlay-dark)', display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 id="export-audio-title" style={{ margin: 0, fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--color-text-primary)' }}>Export Audio</h2>
                <button
                    onClick={isSubmitting ? undefined : onClose}
                    disabled={isSubmitting}
                    style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--color-text-secondary)',
                        fontSize: 'var(--font-size-lg)',
                        cursor: isSubmitting ? 'not-allowed' : 'pointer',
                        opacity: isSubmitting ? 0.5 : 1,
                        padding: 'var(--space-0-5) var(--space-1-5)',
                    }}
                >
                    ✕
                </button>
            </div>

            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                Project: <strong style={{ color: 'var(--color-text-primary)' }}>{projectName}</strong>
            </div>

            <SettingRow label="Format">
                <ChipGroup options={FORMATS.map((f) => ({ value: f.value, label: f.label }))} value={format} onChange={setFormat} />
            </SettingRow>

            <SettingRow label="Sample Rate">
                <ChipGroup options={SAMPLE_RATES} value={exportSampleRate} onChange={setExportSampleRate} />
            </SettingRow>

            {format === 'wav' && (
                <SettingRow label="Bit Depth">
                    <ChipGroup options={BIT_DEPTHS} value={bitDepth} onChange={setBitDepth} />
                </SettingRow>
            )}

            <SettingRow label="Range">
                <ChipGroup options={rangeOptions} value={exportRange} onChange={setExportRange} />
            </SettingRow>

            {rangeInfo.durationBeats > 0 && (
                <div style={{ padding: 'var(--space-2) var(--space-3)', background: 'color-mix(in srgb, var(--color-accent-primary) 6%, transparent)', border: 'var(--space-px) solid color-mix(in srgb, var(--color-accent-primary) 20%, transparent)', borderRadius: 'var(--radius-md)', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontFamily: 'var(--font-role-data)' }}>
                    <span>Bar {rangeInfo.startBar}–{rangeInfo.endBar}</span>
                    <span style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{rangeInfo.durationFormatted}</span>
                </div>
            )}

            <SettingRow label="Normalize">
                <ToggleSwitch checked={normalize} onChange={setNormalize} />
            </SettingRow>

            <SettingRow label="Effect Tail">
                <ToggleSwitch checked={includeTail} onChange={setIncludeTail} />
            </SettingRow>

            {bounceError && (
                <div
                    role="alert"
                    style={{
                        padding: 'var(--space-2) var(--space-3)',
                        background: 'color-mix(in srgb, var(--color-status-error) 10%, transparent)',
                        border: 'var(--space-px) solid color-mix(in srgb, var(--color-status-error) 30%, transparent)',
                        borderRadius: 'var(--radius-md)',
                        fontSize: 'var(--font-size-sm)',
                        color: 'var(--color-status-error)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        maxHeight: 120,
                        overflowY: 'auto',
                    }}
                >
                    <strong style={{ display: 'block', marginBottom: 4 }}>Export failed</strong>
                    {bounceError}
                </div>
            )}
            {!bounceError && bounceDisabledReason && (
                <div
                    role="status"
                    style={{
                        padding: 'var(--space-2) var(--space-3)',
                        background: 'color-mix(in srgb, var(--color-status-warning) 12%, transparent)',
                        border: 'var(--space-px) solid color-mix(in srgb, var(--color-status-warning) 35%, transparent)',
                        borderRadius: 'var(--radius-md)',
                        fontSize: 'var(--font-size-sm)',
                        color: 'var(--color-text-primary)',
                    }}
                >
                    {bounceDisabledReason}
                </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 }}>
                <button
                    onClick={onClose}
                    disabled={isSubmitting}
                    style={{ padding: 'var(--space-2) var(--space-4)', borderRadius: 'var(--radius-md)', border: 'var(--space-px) solid var(--color-control-border)', background: 'transparent', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', fontWeight: 500, cursor: isSubmitting ? 'not-allowed' : 'pointer', opacity: isSubmitting ? 0.5 : 1 }}
                >
                    Cancel
                </button>
                <button
                    onClick={onBounce}
                    disabled={isSubmitting || !canBounce}
                    style={{ padding: 'var(--space-2) var(--space-5)', borderRadius: 'var(--radius-md)', border: 'none', background: 'var(--color-accent-primary)', color: 'var(--color-text-on-accent)', fontSize: 'var(--font-size-xs)', fontWeight: 600, cursor: isSubmitting || !canBounce ? 'not-allowed' : 'pointer', opacity: isSubmitting || !canBounce ? 0.5 : 1, transition: 'all var(--transition-fast)' }}
                >
                    {isSubmitting ? 'Starting...' : 'Bounce'}
                </button>
            </div>
        </div>
    );
}

const SettingRow = ({ label, children }: { label: string; children: ReactNode }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 500, color: 'var(--color-text-secondary)' }}>{label}</span>
        {children}
    </div>
);

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
                            padding: 'var(--space-1) var(--space-2-5)',
                            borderRadius: 'var(--radius-md)',
                            border: isActive ? 'var(--space-px) solid var(--color-accent-primary)' : 'var(--space-px) solid var(--color-control-border)',
                            background: isActive ? 'color-mix(in srgb, var(--color-accent-primary) 15%, transparent)' : 'transparent',
                            color: isActive ? 'var(--color-accent-primary)' : 'var(--color-text-tertiary)',
                            fontSize: 'var(--font-size-xs)',
                            fontWeight: 600,
                            cursor: 'pointer',
                            transition: 'all var(--transition-linear)',
                        }}
                    >
                        {opt.label}
                    </button>
                );
            })}
        </div>
    );
}

/** Toggle switch dimensions (all in px). */
const TOGGLE_TRACK_W = 36;
const TOGGLE_TRACK_H = 20;
const TOGGLE_KNOB_SIZE = 14;
const TOGGLE_PADDING = 3;
/** Knob left position when ON = track width − knob size − padding */
const TOGGLE_LEFT_ON = TOGGLE_TRACK_W - TOGGLE_KNOB_SIZE - TOGGLE_PADDING;

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
            width: TOGGLE_TRACK_W,
            height: TOGGLE_TRACK_H,
            borderRadius: 'var(--radius-xl)',
            border: 'none',
            background: checked ? 'var(--color-accent-primary)' : 'var(--color-control-bg)',
            position: 'relative',
            cursor: 'pointer',
            transition: 'background var(--transition-fast)',
        }}
    >
        <div
            style={{
                width: TOGGLE_KNOB_SIZE,
                height: TOGGLE_KNOB_SIZE,
                borderRadius: '50%',
                background: 'var(--color-text-on-accent)',
                position: 'absolute',
                top: TOGGLE_PADDING,
                left: checked ? TOGGLE_LEFT_ON : TOGGLE_PADDING,
                transition: 'left var(--transition-fast)',
                boxShadow: '0 var(--space-px) var(--token-size-px-3) var(--color-overlay-dark)',
            }}
        />
    </button>
);
