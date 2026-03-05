import React, { lazy, Suspense } from 'react';
import { QUICK_PRESETS_BY_EFFECT } from '@/widgets/DeviceRack/model/presets';
import type { DeviceSlot, QuickPreset } from '@/widgets/DeviceRack/model/types';
import type { SidechainSendMode } from '@/shared/api/engine';
import type { DeviceRuntimeStatus } from '@/widgets/DeviceRack/ui/DeviceNodeHeader';

const PluginSettingsPanelLazy = lazy(async () => ({
    default: (await import('@/widgets/DeviceRack/ui/PluginSettingsPanel')).PluginSettingsPanel,
}));

const PluginGuiSurfaceLazy = lazy(async () => ({
    default: (await import('@/widgets/DeviceRack/ui/PluginGuiSurface')).PluginGuiSurface,
}));

interface DeviceNodeBodyProps {
    device: DeviceSlot;
    showSettings: boolean;
    supportsSettingsToggle: boolean;
    sidechainSourceTrackId?: string;
    sidechainSendMode?: SidechainSendMode;
    sidechainOptions?: Array<{ id: string; name: string }>;
    runtimeStatus?: DeviceRuntimeStatus;
    editorSupported?: boolean;
    editorReason?: string;
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
    onApplyUtilityScene?: (scene: 'center' | 'mono' | 'wide') => void;
    onDropSample?: (samplePath: string) => void;
    onLoadSample?: () => void;
    onParamContextMenu?: (e: React.MouseEvent, paramName: string) => void;
    onSidechainSourceChange?: (sourceTrackId: string) => void;
    onSidechainSendModeChange?: (mode: SidechainSendMode) => void;
}

export const DeviceNodeBody = React.memo(({
    device,
    showSettings,
    supportsSettingsToggle,
    sidechainSourceTrackId,
    sidechainSendMode,
    sidechainOptions,
    runtimeStatus,
    editorSupported,
    editorReason,
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
    onApplyUtilityScene,
    onDropSample,
    onLoadSample,
    onParamContextMenu,
    onSidechainSourceChange,
    onSidechainSendModeChange,
}: DeviceNodeBodyProps) => {
    const showSidechainSelector = device.source === 'vst' || device.pluginId === 'internal://instrument/flow';
    const quickPresets = device.source === 'internal'
        ? (QUICK_PRESETS_BY_EFFECT[device.effectType] ?? [])
        : [];

    // ── ENTERPRISE: Rack body — show chain list, macros, and structure ──
    if (device.rack) {
        const rack = device.rack;
        const rackColors: Record<string, string> = {
            Instrument: '#e066aa',
            DrumRack: '#f0a040',
            MidiEffect: '#40d0c0',
            AudioEffect: '#50b8e0',
        };
        const accent = rackColors[rack.rack_type] ?? '#50b8e0';
        const rackLabels: Record<string, string> = {
            Instrument: 'Instrument Rack',
            DrumRack: 'Drum Rack',
            MidiEffect: 'MIDI Effect Rack',
            AudioEffect: 'Audio Effect Rack',
        };

        return (
            <div
                data-no-drag
                style={{
                    flex: 1,
                    minWidth: 0,
                    minHeight: 0,
                    overflow: 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 0,
                    padding: 'var(--space-1-5)',
                }}
            >
                {/* Rack type label */}
                <div style={{
                    fontSize: 9,
                    fontWeight: 700,
                    color: accent,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    marginBottom: 4,
                    paddingBottom: 3,
                    borderBottom: `1px solid ${accent}33`,
                }}>
                    {rackLabels[rack.rack_type] ?? 'Rack'} · {rack.chains.length} chain{rack.chains.length !== 1 ? 's' : ''}
                </div>

                {/* Chains */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {rack.chains.map((chain, chainIdx) => (
                        <div
                            key={chain.id || chainIdx}
                            style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 1,
                                padding: '3px 4px',
                                borderRadius: 3,
                                background: chain.is_disabled
                                    ? 'rgba(255,255,255,0.02)'
                                    : 'rgba(255,255,255,0.04)',
                                opacity: chain.is_disabled ? 0.45 : 1,
                            }}
                        >
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                                fontSize: 9,
                                fontWeight: 600,
                                color: chain.is_solo
                                    ? '#ffc040'
                                    : 'var(--color-text-secondary)',
                            }}>
                                {chain.is_solo && <span style={{ fontSize: 7, color: '#ffc040' }}>S</span>}
                                {chain.is_disabled && <span style={{ fontSize: 7, color: '#ff6060' }}>M</span>}
                                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {chain.name || `Chain ${String.fromCharCode(65 + chainIdx)}`}
                                </span>
                                <span style={{ fontSize: 7, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>
                                    {chain.deviceCount}
                                </span>
                            </div>
                            {/* Device names within chain */}
                            {chain.deviceNames.length > 0 && (
                                <div style={{
                                    display: 'flex',
                                    flexWrap: 'wrap',
                                    gap: '2px 6px',
                                    paddingLeft: 8,
                                }}>
                                    {chain.deviceNames.map((devName, devIdx) => (
                                        <span
                                            key={devIdx}
                                            style={{
                                                fontSize: 8,
                                                color: 'var(--color-text-tertiary)',
                                                letterSpacing: '0.02em',
                                            }}
                                        >
                                            {devName}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>
                    ))}
                </div>

                {/* Macro controls summary */}
                {rack.macro_controls.length > 0 && (
                    <div style={{
                        marginTop: 6,
                        paddingTop: 4,
                        borderTop: '1px solid rgba(255,255,255,0.06)',
                    }}>
                        <div style={{
                            fontSize: 8,
                            fontWeight: 600,
                            color: 'var(--color-text-tertiary)',
                            letterSpacing: '0.05em',
                            textTransform: 'uppercase',
                            marginBottom: 3,
                        }}>
                            Macros
                        </div>
                        <div style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fill, minmax(70px, 1fr))',
                            gap: '2px 4px',
                        }}>
                            {rack.macro_controls
                                .filter(mc => mc.name !== `Macro ${mc.index + 1}` || mc.value !== 0)
                                .slice(0, 16)
                                .map((mc) => (
                                    <div
                                        key={mc.index}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 3,
                                            fontSize: 8,
                                            color: 'var(--color-text-secondary)',
                                        }}
                                    >
                                        <div style={{
                                            width: 24,
                                            height: 3,
                                            borderRadius: 1.5,
                                            background: 'rgba(255,255,255,0.08)',
                                            position: 'relative',
                                            overflow: 'hidden',
                                        }}>
                                            <div style={{
                                                width: `${Math.min(100, (mc.value / 127) * 100)}%`,
                                                height: '100%',
                                                borderRadius: 1.5,
                                                background: accent,
                                                opacity: 0.7,
                                            }} />
                                        </div>
                                        <span style={{
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                            flex: 1,
                                        }}>
                                            {mc.name}
                                        </span>
                                    </div>
                                ))}
                        </div>
                    </div>
                )}
            </div>
        );
    }

    const settingsPanel = (
        <Suspense fallback={null}>
            <PluginSettingsPanelLazy
                device={device}
                quickPresets={quickPresets}
                onParamChange={onParamChange}
                onParamGestureStart={onParamGestureStart}
                onParamGestureEnd={onParamGestureEnd}
                onApplyQuickPreset={onApplyQuickPreset}
                onRandomize={onRandomize}
                onReset={onReset}
                onStoreSnapshot={onStoreSnapshot}
                onRecallSnapshot={onRecallSnapshot}
                onToggleSnapshot={onToggleSnapshot}
                snapshotState={snapshotState}
                onLoadSample={onLoadSample}
                sidechainSourceTrackId={sidechainSourceTrackId}
                sidechainOptions={sidechainOptions}
                onSidechainSourceChange={onSidechainSourceChange}
                sidechainSendMode={sidechainSendMode}
                onSidechainSendModeChange={onSidechainSendModeChange}
                runtimeStatus={runtimeStatus}
                editorSupported={editorSupported}
                editorReason={editorReason}
                onParamContextMenu={onParamContextMenu}
            />
        </Suspense>
    );

    if (device.source === 'internal') {
        const showFlowSidechain = device.pluginId === 'internal://instrument/flow';
        return (
            <div
                data-no-drag
                style={{
                    padding: 'var(--space-1)',
                    flex: 1,
                    minWidth: 0,
                    minHeight: 0,
                    display: 'grid',
                    gridTemplateRows: showSettings && supportsSettingsToggle
                        ? (showFlowSidechain ? 'auto 1fr auto' : '1fr auto')
                        : (showFlowSidechain ? 'auto 1fr' : '1fr'),
                    gap: 'var(--space-1)',
                    overflow: 'hidden',
                }}
            >
                {/* Sidechain selector for Flow synth instrument */}
                {showFlowSidechain && (
                    <div data-no-drag style={{ display: 'grid', gap: 'var(--space-1)', padding: '0 var(--space-1)' }}>
                        <span
                            style={{
                                fontSize: 'var(--font-size-2xs)',
                                color: 'var(--color-text-tertiary)',
                                fontWeight: 'var(--font-weight-bold)',
                                letterSpacing: '0.04em',
                                textTransform: 'uppercase',
                            }}
                        >
                            Side Chain
                        </span>
                        <select
                            value={sidechainSourceTrackId || 'none'}
                            onChange={(e) => onSidechainSourceChange?.(e.target.value)}
                            style={{
                                border: 'var(--space-px) solid var(--color-divider)',
                                borderRadius: 'var(--radius-md)',
                                background: 'var(--plugin-control-bg)',
                                color: 'var(--color-text-primary)',
                                fontSize: 'var(--font-size-2xs)',
                                padding: 'var(--space-1) var(--space-1-5)',
                                outline: 'none',
                                width: '100%',
                            }}
                        >
                            <option value="none">None</option>
                            {(sidechainOptions ?? []).map((track) => (
                                <option key={track.id} value={track.id}>
                                    {track.name}
                                </option>
                            ))}
                        </select>
                    </div>
                )}
                <div style={{ minHeight: 0 }}>
                    <Suspense fallback={null}>
                        <PluginGuiSurfaceLazy
                            device={device}
                            onParamChange={onParamChange}
                            onParamGestureStart={onParamGestureStart}
                            onParamGestureEnd={onParamGestureEnd}
                            onApplyUtilityScene={onApplyUtilityScene}
                            onDropSample={onDropSample}
                            onLoadSample={onLoadSample}
                            onParamContextMenu={onParamContextMenu}
                        />
                    </Suspense>
                </div>
                {showSettings && supportsSettingsToggle && (
                    <div
                        style={{
                            maxHeight: 230,
                            overflow: 'auto',
                            border: 'var(--space-px) solid var(--color-border-subtle)',
                            borderRadius: 'var(--radius-sm)',
                            background: 'var(--color-overlay-light)',
                            padding: 'var(--space-1-5)',
                        }}
                    >
                        {settingsPanel}
                    </div>
                )}
            </div>
        );
    }

    if (showSettings && supportsSettingsToggle) {
        return <div style={{ padding: 'var(--space-1-5)', flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' }}>{settingsPanel}</div>;
    }

    return (
        <div
            style={{
                padding: device.source === 'vst' ? 'var(--space-2)' : 0,
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: device.source === 'vst' ? 'flex-start' : 'center',
                alignItems: 'center',
                gap: 'var(--space-1-5)',
            }}
        >
            {/* Show sidechain selector for all VST devices. The VST3 scanner
               cannot determine bus layout without loading the plugin, so
               supportsSidechain is unreliable. The runtime safely ignores
               sidechain input for plugins that don't expose a sidechain bus. */}
            {showSidechainSelector && (
                <div data-no-drag style={{ display: 'grid', gap: 'var(--space-1)', width: '100%' }}>
                    <span
                        style={{
                            fontSize: 'var(--font-size-2xs)',
                            color: 'var(--color-text-tertiary)',
                            fontWeight: 'var(--font-weight-bold)',
                            letterSpacing: '0.04em',
                            textTransform: 'uppercase',
                        }}
                    >
                        Side Chain
                    </span>
                    <select
                        value={sidechainSourceTrackId || 'none'}
                        onChange={(e) => onSidechainSourceChange?.(e.target.value)}
                        style={{
                            border: 'var(--space-px) solid var(--color-divider)',
                            borderRadius: 'var(--radius-md)',
                            background: 'var(--plugin-control-bg)',
                            color: 'var(--color-text-primary)',
                            fontSize: 'var(--font-size-2xs)',
                            padding: 'var(--space-1) var(--space-1-5)',
                            outline: 'none',
                            width: '100%',
                        }}
                    >
                        <option value="none">None</option>
                        {(sidechainOptions ?? []).map((track) => (
                            <option key={track.id} value={track.id}>
                                {track.name}
                            </option>
                        ))}
                    </select>
                </div>
            )}
        </div>
    );
});
DeviceNodeBody.displayName = 'DeviceNodeBody';
