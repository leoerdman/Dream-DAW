import type { CSSProperties } from 'react';
import { MeterStrip } from '@/shared/ui/MeterStrip';

function gainToDb(gain: number): number {
    const safe = Math.max(0.0001, gain);
    return Math.max(-60, Math.min(6, 20 * Math.log10(safe)));
}

function dbToGain(db: number): number {
    return Math.pow(10, db / 20);
}

export function SessionIoRow({ label, value }: { label: string; value: string }) {
    return (
        <label style={{ display: 'grid', gap: 2 }}>
            <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-secondary)' }}>{label}</span>
            <select
                value={value}
                onChange={() => { /* routing apply follows dedicated inspector pipeline */ }}
                style={{
                    width: '100%',
                    height: 20,
                    borderRadius: 'var(--radius-sm)',
                    border: 'var(--space-px) solid var(--color-overlay-medium)',
                    background: 'var(--color-bg-header)',
                    color: 'var(--color-text-primary)',
                    fontSize: 'var(--font-size-2xs)',
                    padding: '0 var(--space-1)',
                }}
            >
                <option value={value}>{value}</option>
            </select>
        </label>
    );
}

export function SessionSendRow({
    sendA,
    sendB,
    onChangeA,
    onChangeB,
    disabled = false,
}: {
    sendA: number;
    sendB: number;
    onChangeA: (value: number) => void;
    onChangeB: (value: number) => void;
    disabled?: boolean;
}) {
    return (
        <div style={{ display: 'grid', gap: 2 }}>
            <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-secondary)' }}>Sends</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                <label style={{ display: 'grid', gap: 2 }}>
                    <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-tertiary)' }}>A</span>
                    <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={Math.max(0, Math.min(1, sendA))}
                        onChange={(e) => onChangeA(Number(e.target.value))}
                        disabled={disabled}
                        style={{ width: '100%', accentColor: 'var(--color-accent-primary)', opacity: disabled ? 0.4 : 1 }}
                    />
                </label>
                <label style={{ display: 'grid', gap: 2 }}>
                    <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-tertiary)' }}>B</span>
                    <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={Math.max(0, Math.min(1, sendB))}
                        onChange={(e) => onChangeB(Number(e.target.value))}
                        disabled={disabled}
                        style={{ width: '100%', accentColor: 'var(--color-accent-primary)', opacity: disabled ? 0.4 : 1 }}
                    />
                </label>
            </div>
        </div>
    );
}

export function SessionStripFader({
    gain,
    pan,
    meterL,
    meterR,
    onGainChange,
    onPanChange,
    panDisabled = false,
}: {
    gain: number;
    pan: number;
    meterL: number;
    meterR: number;
    onGainChange: (gain: number) => void;
    onPanChange: (pan: number) => void;
    panDisabled?: boolean;
}) {
    const volumeDb = gainToDb(gain);
    return (
        <div style={{ flex: 1, display: 'grid', gridTemplateRows: '1fr auto auto', gap: 4 }}>
            <div style={{
                minHeight: 92,
                borderRadius: 'var(--radius-xs)',
                border: 'var(--space-px) solid var(--token-color-hex-3d3d3d)',
                background: 'var(--color-bg-canvas)',
                position: 'relative',
                overflow: 'hidden',
                display: 'grid',
                gridTemplateColumns: '10px 1fr',
                gap: 4,
                padding: 4,
            }}>
                <MeterStrip
                    levelL={meterL}
                    levelR={meterR}
                    width={8}
                    style={{ alignSelf: 'stretch' }}
                />
                <input
                    type="range"
                    min={-60}
                    max={6}
                    step={0.1}
                    value={volumeDb}
                    onChange={(e) => onGainChange(dbToGain(Number(e.target.value)))}
                    style={{
                        writingMode: 'vertical-lr',
                        direction: 'rtl',
                        width: '100%',
                        height: '100%',
                        accentColor: 'var(--color-accent-primary)',
                        background: 'transparent',
                    }}
                />
            </div>
            <input
                type="range"
                min={-1}
                max={1}
                step={0.01}
                value={pan}
                onChange={(e) => onPanChange(Number(e.target.value))}
                disabled={panDisabled}
                style={{ width: '100%', accentColor: 'var(--color-accent-primary)', opacity: panDisabled ? 0.35 : 1 }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
                <span>{volumeDb >= 0 ? '+' : ''}{volumeDb.toFixed(1)}dB</span>
                <span>Pan {Math.round(pan * 50)}</span>
            </div>
        </div>
    );
}

export const sessionMixerBtnStyle = (active: boolean): CSSProperties => ({
    minWidth: 24,
    height: 18,
    borderRadius: 'var(--radius-sm)',
    border: active ? 'var(--space-px) solid color-mix(in srgb, var(--color-accent-primary) 55%, transparent)' : 'var(--space-px) solid var(--token-color-hex-4b4b4b)',
    background: active ? 'var(--color-accent-primary-dim)' : 'var(--color-bg-header)',
    color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 'var(--font-weight-bold)' as unknown as number,
    cursor: 'default',
});

export const sessionClipTransportBtnStyle = (active: boolean): CSSProperties => ({
    minWidth: 16,
    height: 14,
    borderRadius: 'var(--radius-sm)',
    border: active ? 'var(--space-px) solid color-mix(in srgb, var(--color-accent-primary) 50%, transparent)' : 'var(--space-px) solid var(--color-overlay-medium)',
    background: active ? 'color-mix(in srgb, var(--color-text-bright) 25%, transparent)' : 'var(--color-overlay-dark)',
    color: active ? 'var(--color-text-bright)' : 'color-mix(in srgb, var(--color-text-bright) 90%, transparent)',
    fontSize: 'var(--font-size-2xs)',
    fontWeight: 'var(--font-weight-bold)' as unknown as number,
    lineHeight: 1,
    padding: 0,
    cursor: 'pointer',
});
