import { useMemo, useState } from 'react';
import type { PluginSlotRuntimeStatus } from '@/shared/api/engine';
import type { DeviceSlot, QuickPreset } from '@/widgets/DeviceRack/model/types';
import { pluginPanelKnobGrid } from '@/widgets/DeviceRack/ui/styles';
import { MacroKnob } from '@/widgets/DeviceRack/ui/MacroKnob';

type PluginSettingsPanelProps = {
    device: DeviceSlot;
    quickPresets: QuickPreset[];
    onParamChange: (paramName: string, value: number) => void;
    onParamGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onParamGestureEnd?: (paramName: string) => void;
    onApplyQuickPreset?: (preset: QuickPreset) => void;
    onRandomize?: () => void;
    onReset?: () => void;
    onStoreSnapshot?: (slot: 'A' | 'B') => void;
    onRecallSnapshot?: (slot: 'A' | 'B') => void;
    onToggleSnapshot?: () => void;
    snapshotState?: { A?: Record<string, number>; B?: Record<string, number>; active?: 'A' | 'B' };
    onLoadSample?: () => void;
    sidechainSourceTrackId?: string;
    sidechainOptions?: Array<{ id: string; name: string }>;
    onSidechainSourceChange?: (sourceTrackId: string) => void;
    runtimeStatus?: PluginSlotRuntimeStatus;
    editorSupported?: boolean;
    editorReason?: string;
};

export const PluginSettingsPanel = ({
    device,
    quickPresets,
    onParamChange,
    onParamGestureStart,
    onParamGestureEnd,
    onApplyQuickPreset,
    onRandomize,
    onReset,
    onStoreSnapshot,
    onRecallSnapshot,
    onToggleSnapshot,
    snapshotState,
    onLoadSample,
    sidechainSourceTrackId = 'none',
    sidechainOptions = [],
    onSidechainSourceChange,
    runtimeStatus,
    editorSupported,
    editorReason,
}: PluginSettingsPanelProps) => {
    const [paramSearch, setParamSearch] = useState('');
    const filteredParams = useMemo(() => {
        const q = paramSearch.trim().toLowerCase();
        if (!q) return device.params;
        return device.params.filter((p) => p.name.toLowerCase().includes(q));
    }, [device.params, paramSearch]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {device.source === 'vst' && (
                <div style={{
                    border: '1px solid var(--color-divider)',
                    borderRadius: 'var(--radius-sm)',
                    background: 'color-mix(in srgb, var(--color-bg-header) 88%, var(--token-color-hex-0e1117))',
                    padding: 8,
                    display: 'grid',
                    gap: 6,
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 'var(--font-weight-bold)' as unknown as number, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>
                            External Plugin
                        </span>
                        <span style={{
                            fontSize: 'var(--font-size-xs)',
                            fontWeight: 'var(--font-weight-bold)' as unknown as number,
                            borderRadius: 'var(--radius-full)',
                            border: '1px solid var(--color-divider)',
                            padding: '2px 7px',
                            color: runtimeStatus?.loaded ? 'var(--token-color-hex-7edb90)' : 'var(--token-color-hex-ff9b9b)',
                            background: runtimeStatus?.loaded
                                ? 'color-mix(in srgb, var(--token-color-hex-7edb90) 16%, transparent)'
                                : 'color-mix(in srgb, var(--token-color-hex-ff7070) 16%, transparent)',
                        }}>
                            {runtimeStatus?.loaded ? (runtimeStatus.runtime || 'loaded') : 'offline'}
                        </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>
                        <span>{device.params.length} mapped params</span>
                        <span>
                            {runtimeStatus?.latencyFrames != null
                                ? `Latency ${runtimeStatus.latencyFrames} fr`
                                : (editorSupported === false ? 'Native editor unavailable' : 'Inline editor')}
                        </span>
                    </div>
                    {editorReason && (
                        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>{editorReason}</div>
                    )}
                    <input
                        value={paramSearch}
                        onChange={(e) => setParamSearch(e.target.value)}
                        placeholder="Find parameter..."
                        style={{
                            height: 24,
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid var(--color-divider)',
                            background: 'var(--color-bg-panel)',
                            color: 'var(--color-text-primary)',
                            fontSize: 'var(--font-size-sm)',
                            padding: '0 8px',
                            outline: 'none',
                        }}
                    />
                </div>
            )}
            {device.supportsSidechain && (
                <div style={{ display: 'grid', gap: 4, width: 240, maxWidth: '100%' }}>
                    <span style={{
                        fontSize: 'var(--font-size-xs)',
                        color: 'var(--color-text-tertiary)',
                        fontWeight: 'var(--font-weight-bold)' as unknown as number,
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                    }}>
                        Side Chain
                    </span>
                    <select
                        value={sidechainSourceTrackId || 'none'}
                        onChange={(e) => onSidechainSourceChange?.(e.target.value)}
                        style={{
                            border: '1px solid var(--color-divider)',
                            borderRadius: 'var(--radius-md)',
                            background: 'var(--color-bg-header)',
                            color: 'var(--color-text-primary)',
                            fontSize: 'var(--font-size-sm)',
                            padding: '5px 7px',
                            outline: 'none',
                        }}
                    >
                        <option value="none">None</option>
                        {sidechainOptions.map((track) => (
                            <option key={track.id} value={track.id}>{track.name}</option>
                        ))}
                    </select>
                </div>
            )}
            {quickPresets.length > 0 && (
                <div style={{ display: 'grid', gap: 5 }}>
                    <span style={{
                        fontSize: 'var(--font-size-xs)',
                        color: 'var(--color-text-tertiary)',
                        fontWeight: 'var(--font-weight-bold)' as unknown as number,
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                    }}>
                        Quick Presets
                    </span>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {quickPresets.map((preset) => (
                            <button
                                key={preset.label}
                                type="button"
                                onClick={() => onApplyQuickPreset?.(preset)}
                                style={{
                                    border: '1px solid var(--color-divider)',
                                    borderRadius: 'var(--radius-md)',
                                    background: 'var(--color-bg-header)',
                                    color: 'var(--color-text-secondary)',
                                    fontSize: 'var(--font-size-xs)',
                                    padding: '4px 8px',
                                    cursor: 'pointer',
                                }}
                            >
                                {preset.label}
                            </button>
                        ))}
                    </div>
                </div>
            )}
            {device.source === 'internal' && (
                <div style={{ display: 'grid', gap: 5 }}>
                    <span style={{
                        fontSize: 'var(--font-size-xs)',
                        color: 'var(--color-text-tertiary)',
                        fontWeight: 'var(--font-weight-bold)' as unknown as number,
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                    }}>
                        Performance
                    </span>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button type="button" onClick={() => onRandomize?.()} style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: '4px 8px', cursor: 'pointer' }}>Random</button>
                        <button type="button" onClick={() => onReset?.()} style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: '4px 8px', cursor: 'pointer' }}>Reset</button>
                        <button type="button" onClick={() => onStoreSnapshot?.('A')} style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: snapshotState?.active === 'A' ? 'color-mix(in srgb, var(--color-accent-primary) 25%, var(--color-bg-header))' : 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: '4px 8px', cursor: 'pointer' }}>Store A</button>
                        <button type="button" onClick={() => onStoreSnapshot?.('B')} style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: snapshotState?.active === 'B' ? 'color-mix(in srgb, var(--color-accent-primary) 25%, var(--color-bg-header))' : 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: '4px 8px', cursor: 'pointer' }}>Store B</button>
                        <button type="button" onClick={() => onRecallSnapshot?.('A')} disabled={!snapshotState?.A} style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: '4px 8px', cursor: snapshotState?.A ? 'pointer' : 'not-allowed', opacity: snapshotState?.A ? 1 : 0.55 }}>A</button>
                        <button type="button" onClick={() => onRecallSnapshot?.('B')} disabled={!snapshotState?.B} style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: '4px 8px', cursor: snapshotState?.B ? 'pointer' : 'not-allowed', opacity: snapshotState?.B ? 1 : 0.55 }}>B</button>
                        <button type="button" onClick={() => onToggleSnapshot?.()} disabled={!snapshotState?.A || !snapshotState?.B} style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: '4px 8px', cursor: snapshotState?.A && snapshotState?.B ? 'pointer' : 'not-allowed', opacity: snapshotState?.A && snapshotState?.B ? 1 : 0.55 }}>A/B</button>
                    </div>
                </div>
            )}
            {device.effectType === 'sampler' && (
                <button
                    type="button"
                    onClick={() => onLoadSample?.()}
                    style={{
                        width: 'fit-content',
                        border: '1px solid var(--color-divider)',
                        borderRadius: 'var(--radius-md)',
                        background: 'var(--color-bg-header)',
                        color: 'var(--color-text-secondary)',
                        fontSize: 'var(--font-size-sm)',
                        padding: '6px 10px',
                        cursor: 'pointer',
                    }}
                >
                    Load Sample
                </button>
            )}
            {filteredParams.length > 0 ? (
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(10, Math.max(3, filteredParams.length))}, minmax(0, 1fr))`)}>
                    {filteredParams.map((p) => (
                        <MacroKnob
                            key={p.name}
                            param={p}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            compact
                        />
                    ))}
                </div>
            ) : (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    border: '1px solid var(--color-divider)',
                    borderRadius: 'var(--radius-lg)',
                    padding: '8px 10px',
                    color: 'var(--color-text-secondary)',
                    fontSize: 'var(--font-size-xs)',
                }}>
                    <span>{device.params.length > 0 ? 'No parameters match filter' : 'No exported params'}</span>
                    <span style={{ color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                        {filteredParams.length} params
                    </span>
                </div>
            )}
        </div>
    );
};
