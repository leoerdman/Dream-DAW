import { useRef } from 'react';
import { resolvePlugin } from '@/shared/config/pluginManifest';
import { useDragStore } from '@/shared/stores/useDragStore';
import type * as engineApi from '@/shared/api/engine';
import type { DeviceSlot, QuickPreset } from '@/widgets/DeviceRack/model/types';
import { canDropInZone } from '@/shared/lib/dndMatrix';
import { DeviceNodeBody } from '@/widgets/DeviceRack/ui/DeviceNodeBody';
import { DeviceNodeHeader } from '@/widgets/DeviceRack/ui/DeviceNodeHeader';
import { resolveDeviceCardWidth } from '@/widgets/DeviceRack/model/deviceCardSizing';

interface DeviceNodeProps {
    device: DeviceSlot;
    deviceIndex: number;
    canReorder: boolean;
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
    canReorder,
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
    const lastPointerTargetRef = useRef<HTMLElement | null>(null);
    const isInstrumentSlot =
        device.effectType === 'instrument'
        || device.effectType === 'sampler'
        || device.effectType === 'sample_rack'
        || device.effectType === 'waveSynth';
    const manifest = resolvePlugin(device.pluginId, device.name, device.source, isInstrumentSlot);
    const baseWidth = resolveDeviceCardWidth(device.source, device.effectType, manifest.cardWidth);
    const settingsWidth = Math.min(1460, Math.max(baseWidth, 280 + device.params.length * 110));
    const rackWidth = showSettings ? settingsWidth : baseWidth;
    const supportsSettingsToggle = manifest.supportsSettings;
    // Always show the "eye" button for external plugin formats (VST2/VST3/AU).
    // If native editor support is unavailable at runtime, the click handler
    // falls back to inline controls.
    const showUiButton = manifest.hasEditor;
    const nativeEditorOpen = isNativeEditorOpen ?? false;
    const showRecoverAction = !!runtimeStatus && !runtimeStatus.loaded;

    return (
        <div
            className="device-node"
            draggable={canReorder}
            onMouseDownCapture={(e) => {
                lastPointerTargetRef.current = e.target as HTMLElement;
                // Click-anywhere selection: any left-button mousedown on the
                // device card selects it. Uses capture phase so selection
                // fires before knob drag or button handlers.
                if (e.button === 0) {
                    onSelect(e as unknown as React.MouseEvent<HTMLDivElement>);
                }
            }}
            onDragStart={(e) => {
                if (!canReorder) {
                    e.preventDefault();
                    return;
                }
                const target = e.target as HTMLElement;
                const downTarget = lastPointerTargetRef.current;
                // Allow reordering from any non-interactive part of the card/header
                // and never hijack controls (knobs, buttons, selects, text inputs).
                if (
                    target.closest('button, input, select, textarea, [data-no-drag], canvas')
                    || downTarget?.closest('button, input, select, textarea, [data-no-drag], canvas')
                ) {
                    e.preventDefault();
                    return;
                }
                e.dataTransfer.setData('application/x-dream-device-id', device.id);
                e.dataTransfer.setData('application/x-dream-device-index', String(deviceIndex));
                // WebKit/macOS can ignore custom mime types in some drag contexts.
                // Keep a plain-text fallback so drop handlers can always resolve source id.
                e.dataTransfer.setData('text/plain', device.id);
                e.dataTransfer.effectAllowed = 'move';
                const slot = (e.currentTarget as HTMLElement).closest('.dream-device-drop-indicator') as HTMLElement | null;
                if (slot) slot.style.opacity = '0.4';
            }}
            onDragEnd={() => {
                lastPointerTargetRef.current = null;
                const slot = document.querySelector('.dream-device-drop-indicator[style*="opacity"]') as HTMLElement | null;
                if (slot) slot.style.opacity = '1';
                document.querySelectorAll('.dream-device-drop-indicator').forEach((el) => {
                    (el as HTMLElement).style.borderLeft = '';
                    (el as HTMLElement).style.borderRight = '';
                });
                document.querySelectorAll('.dream-device-drop-indicator-end').forEach((el) => {
                    (el as HTMLElement).style.borderLeft = '';
                });
            }}
            style={{
                minWidth: rackWidth,
                width: rackWidth,
                display: 'flex',
                flexDirection: 'row',
                background: 'var(--surface-card, var(--token-color-hex-3a3a3a))',
                borderRadius: 'var(--radius-sm)',
                border: isSelected ? 'var(--space-px) solid var(--token-color-rgba-255-255-255-0d7)' : 'var(--space-px) solid var(--surface-card, var(--token-color-hex-3a3a3a))',
                overflow: 'hidden',
                opacity: device.isEnabled ? 1 : 0.5,
                transition: 'opacity var(--transition-fast)',
                flexShrink: 0,
                height: '100%',
                minHeight: '100%',
                position: 'relative',
                boxShadow: 'none',
                cursor: canReorder ? 'grab' : 'default',
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
                canReorder={canReorder}
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
