import { useMemo, useState } from 'react';
import type { PluginSlotRuntimeStatus } from '@/shared/api/engine';
import type { DeviceSlot, QuickPreset } from '@/widgets/DeviceRack/model/types';
import { pluginPanelKnobGrid } from '@/widgets/DeviceRack/ui/styles';
import { MacroKnob } from '@/widgets/DeviceRack/ui/MacroKnob';
import { buildSurfaceKnobParams } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';

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
    onParamContextMenu?: (e: React.MouseEvent, paramName: string) => void;
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
    onParamContextMenu,
}: PluginSettingsPanelProps) => {
    const showSidechainSelector = device.source === 'vst' || device.pluginId === 'internal://instrument/flow';
    const [paramSearch, setParamSearch] = useState('');
    const baseParams = useMemo(() => (
        device.source === 'internal' ? buildSurfaceKnobParams(device) : device.params
    ), [device]);
    const filteredParams = useMemo(() => {
        const q = paramSearch.trim().toLowerCase();
        if (!q) return baseParams;
        return baseParams.filter((p) => p.name.toLowerCase().includes(q));
    }, [baseParams, paramSearch]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            {device.source === 'vst' && (
                <div style={{
                    border: 'var(--space-px) solid var(--color-divider)',
                    borderRadius: 'var(--radius-sm)',
                    background: 'color-mix(in srgb, var(--color-bg-header) 88%, var(--token-color-hex-0e1117))',
                    padding: 'var(--space-2)',
                    display: 'grid',
                    gap: 'var(--space-1-5)',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
                        <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 'var(--font-weight-bold)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>
                            External Plugin
                        </span>
                        <span style={{
                            fontSize: 'var(--font-size-xs)',
                            fontWeight: 'var(--font-weight-bold)',
                            borderRadius: 'var(--radius-full)',
                            border: 'var(--space-px) solid var(--color-divider)',
                            padding: 'var(--space-0-5) var(--token-size-px-7)',
                            color: runtimeStatus?.loaded ? 'var(--token-color-hex-7edb90)' : 'var(--token-color-hex-ff9b9b)',
                            background: runtimeStatus?.loaded
                                ? 'color-mix(in srgb, var(--token-color-hex-7edb90) 16%, transparent)'
                                : 'color-mix(in srgb, var(--token-color-hex-ff7070) 16%, transparent)',
                        }}>
                            {runtimeStatus?.loaded ? (runtimeStatus.runtime || 'loaded') : 'offline'}
                        </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>
                        <span>{filteredParams.length} mapped params</span>
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
                            border: 'var(--space-px) solid var(--color-divider)',
                            background: 'var(--color-bg-panel)',
                            color: 'var(--color-text-primary)',
                            fontSize: 'var(--font-size-sm)',
                            padding: '0 var(--space-2)',
                            outline: 'none',
                        }}
                    />
                </div>
            )}
            {showSidechainSelector && (
                <div style={{ display: 'grid', gap: 4, width: 240, maxWidth: '100%' }}>
                    <span style={{
                        fontSize: 'var(--font-size-xs)',
                        color: 'var(--color-text-tertiary)',
                        fontWeight: 'var(--font-weight-bold)',
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                    }}>
                        Side Chain
                    </span>
                    <select
                        value={sidechainSourceTrackId || 'none'}
                        onChange={(e) => onSidechainSourceChange?.(e.target.value)}
                        style={{
                            border: 'var(--space-px) solid var(--color-divider)',
                            borderRadius: 'var(--radius-md)',
                            background: 'var(--color-bg-header)',
                            color: 'var(--color-text-primary)',
                            fontSize: 'var(--font-size-sm)',
                            padding: 'var(--token-size-px-5) var(--token-size-px-7)',
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
                        fontWeight: 'var(--font-weight-bold)',
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                    }}>
                        Quick Presets
                    </span>
                    <div style={{ display: 'flex', gap: 'var(--space-1-5)', flexWrap: 'wrap' }}>
                        {quickPresets.map((preset) => (
                            <button
                                key={preset.label}
                                type="button"
                                onClick={() => onApplyQuickPreset?.(preset)}
                                style={{
                                    border: 'var(--space-px) solid var(--color-divider)',
                                    borderRadius: 'var(--radius-md)',
                                    background: 'var(--color-bg-header)',
                                    color: 'var(--color-text-secondary)',
                                    fontSize: 'var(--font-size-xs)',
                                    padding: 'var(--space-1) var(--space-2)',
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
                        fontWeight: 'var(--font-weight-bold)',
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                    }}>
                        Performance
                    </span>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button type="button" onClick={() => onRandomize?.()} style={{ border: 'var(--space-px) solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: 'var(--space-1) var(--space-2)', cursor: 'pointer' }}>Random</button>
                        <button type="button" onClick={() => onReset?.()} style={{ border: 'var(--space-px) solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: 'var(--space-1) var(--space-2)', cursor: 'pointer' }}>Reset</button>
                        <button type="button" onClick={() => onStoreSnapshot?.('A')} style={{ border: 'var(--space-px) solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: snapshotState?.active === 'A' ? 'color-mix(in srgb, var(--color-accent-primary) 25%, var(--color-bg-header))' : 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: 'var(--space-1) var(--space-2)', cursor: 'pointer' }}>Store A</button>
                        <button type="button" onClick={() => onStoreSnapshot?.('B')} style={{ border: 'var(--space-px) solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: snapshotState?.active === 'B' ? 'color-mix(in srgb, var(--color-accent-primary) 25%, var(--color-bg-header))' : 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: 'var(--space-1) var(--space-2)', cursor: 'pointer' }}>Store B</button>
                        <button type="button" onClick={() => onRecallSnapshot?.('A')} disabled={!snapshotState?.A} style={{ border: 'var(--space-px) solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: 'var(--space-1) var(--space-2)', cursor: snapshotState?.A ? 'pointer' : 'not-allowed', opacity: snapshotState?.A ? 1 : 0.55 }}>A</button>
                        <button type="button" onClick={() => onRecallSnapshot?.('B')} disabled={!snapshotState?.B} style={{ border: 'var(--space-px) solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: 'var(--space-1) var(--space-2)', cursor: snapshotState?.B ? 'pointer' : 'not-allowed', opacity: snapshotState?.B ? 1 : 0.55 }}>B</button>
                        <button type="button" onClick={() => onToggleSnapshot?.()} disabled={!snapshotState?.A || !snapshotState?.B} style={{ border: 'var(--space-px) solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: 'var(--space-1) var(--space-2)', cursor: snapshotState?.A && snapshotState?.B ? 'pointer' : 'not-allowed', opacity: snapshotState?.A && snapshotState?.B ? 1 : 0.55 }}>A/B</button>
                    </div>
                </div>
            )}
            {device.effectType === 'sampler' && (
                <button
                    type="button"
                    onClick={() => onLoadSample?.()}
                    style={{
                        width: 'fit-content',
                        border: 'var(--space-px) solid var(--color-divider)',
                        borderRadius: 'var(--radius-md)',
                        background: 'var(--color-bg-header)',
                        color: 'var(--color-text-secondary)',
                        fontSize: 'var(--font-size-sm)',
                        padding: 'var(--space-1-5) var(--space-2-5)',
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
                            onContextMenu={onParamContextMenu}
                            compact
                        />
                    ))}
                </div>
            ) : (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    border: 'var(--space-px) solid var(--color-divider)',
                    borderRadius: 'var(--radius-lg)',
                    padding: 'var(--space-2) var(--space-2-5)',
                    color: 'var(--color-text-secondary)',
                    fontSize: 'var(--font-size-xs)',
                }}>
                    {/* BUG-47 FIX: Show actual total count when filter matches nothing */}
                    <span>{baseParams.length > 0 ? `No parameters match filter (${baseParams.length} total)` : 'No exported params'}</span>
                    <span style={{ color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-role-data)' }}>
                        {baseParams.length} params
                    </span>
                </div>
            )}
        </div>
    );
};
