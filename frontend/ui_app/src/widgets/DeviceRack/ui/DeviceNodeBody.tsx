import type React from 'react';
import { PluginSettingsPanel } from '@/widgets/DeviceRack/ui/PluginSettingsPanel';
import { PluginGuiSurface } from '@/widgets/DeviceRack/ui/PluginGuiSurface';
import { QUICK_PRESETS_BY_EFFECT } from '@/widgets/DeviceRack/model/presets';
import type { DeviceSlot, QuickPreset } from '@/widgets/DeviceRack/model/types';
import type { DeviceRuntimeStatus } from '@/widgets/DeviceRack/ui/DeviceNodeHeader';

interface DeviceNodeBodyProps {
    device: DeviceSlot;
    showSettings: boolean;
    supportsSettingsToggle: boolean;
    sidechainSourceTrackId?: string;
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
}

export function DeviceNodeBody({
    device,
    showSettings,
    supportsSettingsToggle,
    sidechainSourceTrackId,
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
}: DeviceNodeBodyProps) {
    const quickPresets = device.source === 'internal'
        ? (QUICK_PRESETS_BY_EFFECT[device.effectType] ?? [])
        : [];

    const settingsPanel = (
        <PluginSettingsPanel
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
            runtimeStatus={runtimeStatus}
            editorSupported={editorSupported}
            editorReason={editorReason}
        />
    );

    if (device.source === 'internal') {
        return (
            <div
                data-no-drag
                style={{
                    padding: 'var(--space-1)',
                    flex: 1,
                    minWidth: 0,
                    minHeight: 0,
                    display: 'grid',
                    gridTemplateRows: showSettings && supportsSettingsToggle ? '1fr auto' : '1fr',
                    gap: 'var(--space-1)',
                    overflow: 'hidden',
                }}
            >
                <div style={{ minHeight: 0 }}>
                    <PluginGuiSurface
                        device={device}
                        onParamChange={onParamChange}
                        onParamGestureStart={onParamGestureStart}
                        onParamGestureEnd={onParamGestureEnd}
                        onApplyUtilityScene={onApplyUtilityScene}
                        onDropSample={onDropSample}
                        onLoadSample={onLoadSample}
                        onParamContextMenu={onParamContextMenu}
                    />
                </div>
                {showSettings && supportsSettingsToggle && (
                    <div
                        style={{
                            maxHeight: 230,
                            overflow: 'auto',
                            border: 'var(--space-px) solid var(--token-color-rgba-255-255-255-0d04)',
                            borderRadius: 'var(--radius-sm)',
                            background: 'var(--token-color-rgba-0-0-0-0d15)',
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
            {/* BUG-45 FIX: Only show sidechain for VST devices that support it */}
            {device.source === 'vst' && device.supportsSidechain && (
                <div data-no-drag style={{ display: 'grid', gap: 'var(--space-1)', width: '100%' }}>
                    <span
                        style={{
                            fontSize: 'var(--font-size-2xs)',
                            color: 'var(--color-text-tertiary)',
                            fontWeight: 'var(--font-weight-bold)' as unknown as number,
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
                            background: 'var(--token-color-hex-2a2a2a)',
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
}
