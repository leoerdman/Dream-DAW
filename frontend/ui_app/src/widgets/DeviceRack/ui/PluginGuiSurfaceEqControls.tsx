import React from 'react';
import { PluginKnob, type PluginParam } from '@/widgets/DeviceRack/StandardPluginControls';

type Props = {
    activeBandIsFilterOnly: boolean;
    freqParam?: PluginParam;
    gainParam?: PluginParam;
    qParam?: PluginParam;
    outParam?: PluginParam;
    enabledBandsCount: number;
    onParamChange: (paramName: string, value: number) => void;
    onParamGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onParamGestureEnd?: (paramName: string) => void;
    onParamContextMenu?: (e: React.MouseEvent, paramName: string) => void;
    eqSpectrumEnabled: boolean;
    setEqSpectrumEnabled: React.Dispatch<React.SetStateAction<boolean>>;
};

/** Inject `defaultValue` for EQ-specific double-click reset behavior. */
function withDefault(param: PluginParam | undefined, defaultValue: number): PluginParam | undefined {
    if (!param) return undefined;
    return { ...param, defaultValue };
}

/**
 * EQ Controls Panel — 2 cards stacked vertically.
 *
 * Card 1 (top): 2×2 knob grid (FREQ + GAIN / Q + OUT)
 *   - Double-click resets: FREQ→1000Hz, GAIN→0dB, Q→1.0, OUT→0dB
 *
 * Card 2 (bottom): Spectrum toggle
 */
export function PluginGuiSurfaceEqControls({
    freqParam,
    gainParam,
    qParam,
    outParam,
    onParamChange,
    onParamGestureStart,
    onParamGestureEnd,
    onParamContextMenu,
    eqSpectrumEnabled,
    setEqSpectrumEnabled,
}: Props): React.ReactNode {
    const cardStyle: React.CSSProperties = {
        background: 'color-mix(in srgb, var(--color-bg-panel) 90%, var(--color-bg-header) 10%)',
        borderRadius: 'var(--plugin-card-radius)',
        border: 'var(--space-px) solid color-mix(in srgb, var(--color-text-primary) 14%, transparent)',
    };

    return (
        <div
            style={{
                width: 130,
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-1)',
            }}
        >
            {/* Card 1: Knobs — top aligned */}
            <div style={{ ...cardStyle, padding: 'var(--space-1-5) var(--space-1)' }}>
                {/* Row 1: FREQ + GAIN */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-0-5)' }}>
                    {freqParam && (
                        <PluginKnob
                            key={`freq-${freqParam.name}`}
                            param={withDefault(freqParam, 1000)!}
                            label="FREQ"
                            scale="log"
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            onContextMenu={onParamContextMenu}
                            compact
                        />
                    )}
                    {gainParam && (
                        <PluginKnob
                            key={`gain-${gainParam.name}`}
                            param={withDefault(gainParam, 0)!}
                            label="GAIN"
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            onContextMenu={onParamContextMenu}
                            compact
                        />
                    )}
                </div>
                {/* Row 2: Q + OUT */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-0-5)', marginTop: 'var(--space-1)' }}>
                    {qParam && (
                        <PluginKnob
                            key={`q-${qParam.name}`}
                            param={withDefault(qParam, 1.0)!}
                            label="Q"
                            scale="log"
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            onContextMenu={onParamContextMenu}
                            compact
                        />
                    )}
                    {outParam && (
                        <PluginKnob
                            key="out"
                            param={withDefault(outParam, 0)!}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            onContextMenu={onParamContextMenu}
                            compact
                        />
                    )}
                </div>
            </div>

            {/* Card 2: Spectrum toggle */}
            <div
                style={{
                    ...cardStyle,
                    padding: 'var(--space-1) var(--space-1-5)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-1-5)',
                    cursor: 'pointer',
                    userSelect: 'none',
                }}
                onClick={() => setEqSpectrumEnabled(prev => !prev)}
            >
                <div
                    style={{
                        width: 14,
                        height: 14,
                        borderRadius: 'var(--radius-sm)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: eqSpectrumEnabled
                            ? 'var(--color-accent-primary)'
                            : 'color-mix(in srgb, var(--color-text-primary) 12%, transparent)',
                        border: `var(--space-px) solid ${eqSpectrumEnabled
                            ? 'var(--color-accent-primary)'
                            : 'color-mix(in srgb, var(--color-text-primary) 28%, transparent)'}`,
                        transition: 'background 0.15s ease, border-color 0.15s ease',
                        flexShrink: 0,
                    }}
                >
                    {eqSpectrumEnabled && (
                        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                            <path d="M1.5 4L3.2 5.7L6.5 2.3" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    )}
                </div>
                <span
                    style={{
                        fontSize: 'var(--font-size-2xs)',
                        fontFamily: 'var(--font-role-body)',
                        color: eqSpectrumEnabled
                            ? 'color-mix(in srgb, var(--color-text-primary) 92%, transparent)'
                            : 'color-mix(in srgb, var(--color-text-primary) 58%, transparent)',
                        fontWeight: 500,
                    }}
                >
                    Spectrum
                </span>
            </div>
        </div>
    );
}
