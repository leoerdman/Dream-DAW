import { resolvePlugin } from '@/shared/config/pluginManifest';
import { useDragStore } from '@/shared/stores/useDragStore';
import type * as engineApi from '@/shared/api/engine';
import type { DeviceSlot, QuickPreset } from '@/widgets/DeviceRack/model/types';
import { canDropInZone } from '@/shared/lib/dndMatrix';
import { DeviceNodeBody } from '@/widgets/DeviceRack/ui/DeviceNodeBody';
import { DeviceNodeHeader } from '@/widgets/DeviceRack/ui/DeviceNodeHeader';

interface DeviceNodeProps {
    device: DeviceSlot;
    deviceIndex: number;
    onToggle: () => void;
    isSelected: boolean;
    showSettings: boolean;
    onSelect: (e: React.MouseEvent<HTMLDivElement>) => void;
    onOpenSettings: () => void;
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
    onOpenGUI?: () => void;
    isNativeEditorOpen?: boolean;
    editorSupported?: boolean;
    editorReason?: string;
    runtimeStatus?: engineApi.PluginSlotRuntimeStatus;
    onParamContextMenu?: (e: React.MouseEvent, paramName: string) => void;
    sidechainSourceTrackId?: string;
    sidechainOptions?: Array<{ id: string; name: string }>;
    onSidechainSourceChange?: (sourceTrackId: string) => void;
    onEnsureActive?: () => void;
}

export const DeviceNode = ({
    device,
    deviceIndex,
    onToggle,
    onOpenGUI,
    isSelected,
    isNativeEditorOpen,
    showSettings,
    onSelect,
    onOpenSettings,
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
    editorSupported,
    editorReason,
    runtimeStatus,
    onParamContextMenu,
    sidechainSourceTrackId,
    sidechainOptions,
    onSidechainSourceChange,
    onEnsureActive,
}: DeviceNodeProps) => {
    const isInstrumentSlot = device.effectType === 'instrument' || device.effectType === 'sampler' || device.effectType === 'waveSynth';
    const manifest = resolvePlugin(device.pluginId, device.name, device.source, isInstrumentSlot);
    const baseWidth =
        device.source === 'internal' && device.effectType === 'waveSynth'
            ? 980
            : device.source === 'internal' && device.effectType === 'eq'
                ? 540
                : manifest.cardWidth;
    const settingsWidth = Math.min(1460, Math.max(baseWidth, 280 + device.params.length * 110));
    const rackWidth = showSettings ? settingsWidth : baseWidth;
    const supportsSettingsToggle = manifest.supportsSettings;
    const showUiButton = manifest.hasEditor;
    const nativeEditorOpen = isNativeEditorOpen ?? false;
    const showRecoverAction = !!runtimeStatus && !runtimeStatus.loaded;

    return (
        <div
            className="device-node"
            data-effect={device.effectType}
            style={{
                minWidth: rackWidth,
                width: rackWidth,
                display: 'flex',
                flexDirection: 'row',
                background: '#3a3a3a',
                borderRadius: 'var(--radius-sm)',
                border: isSelected ? '1px solid rgba(255,255,255,0.7)' : '1px solid #3a3a3a',
                overflow: 'hidden',
                opacity: device.isEnabled ? 1 : 0.5,
                transition: 'opacity var(--transition-fast)',
                flexShrink: 0,
                height: '100%',
                minHeight: '100%',
                position: 'relative',
                boxShadow: 'none',
            }}
            onMouseUp={() => {
                const dragging = useDragStore.getState().draggingItem;
                const acceptance = dragging ? canDropInZone(dragging, 'sampler-surface') : { allowed: false };
                const isSamplerDevice =
                    device.source === 'internal' &&
                    (device.effectType === 'sampler' || device.effectType === 'instrument');
                if (!isSamplerDevice) return;
                if (dragging?.path && acceptance.allowed) {
                    onDropSample?.(dragging.path);
                    useDragStore.getState().endDrag();
                }
            }}
        >
            <DeviceNodeHeader
                device={device}
                deviceIndex={deviceIndex}
                showSettings={showSettings}
                supportsSettingsToggle={supportsSettingsToggle}
                showUiButton={showUiButton}
                nativeEditorOpen={nativeEditorOpen}
                showRecoverAction={showRecoverAction}
                pluginFormat={manifest.format}
                editorSupported={editorSupported}
                editorReason={editorReason}
                onToggle={onToggle}
                onOpenGUI={onOpenGUI}
                onEnsureActive={onEnsureActive}
                onOpenSettings={onOpenSettings}
                onSelect={onSelect}
            />
            <DeviceNodeBody
                device={device}
                showSettings={showSettings}
                supportsSettingsToggle={supportsSettingsToggle}
                sidechainSourceTrackId={sidechainSourceTrackId}
                sidechainOptions={sidechainOptions}
                runtimeStatus={runtimeStatus}
                editorSupported={editorSupported}
                editorReason={editorReason}
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
                onApplyUtilityScene={onApplyUtilityScene}
                onDropSample={onDropSample}
                onLoadSample={onLoadSample}
                onParamContextMenu={onParamContextMenu}
                onSidechainSourceChange={onSidechainSourceChange}
            />
        </div>
    );
};
