import { useState } from 'react';
import { MeterStrip } from '@/shared/ui/MeterStrip';
import * as engineApi from '@/shared/api/engine';
import { useFocusPanelStore } from '@/shared/stores/useFocusPanelStore';
import type { DeviceRackLogicOutput } from '@/widgets/DeviceRack/model/useDeviceRackLogic';
import type { DeviceSlot as DeviceSlotModel } from '@/widgets/DeviceRack/model/types';
import { AddDeviceButton } from '@/widgets/DeviceRack/ui/AddDeviceButton';
import { DeviceSlot, EmptyState } from '@/widgets/DeviceRack/ui/DeviceRackSlots';
import { DeviceContextMenuPopup } from '@/widgets/DeviceRack/ui/DeviceContextMenuPopup';

interface DeviceRackContentProps {
    logic: DeviceRackLogicOutput;
    rackExpanded?: boolean;
}

export function DeviceRackContent({ logic, rackExpanded }: DeviceRackContentProps) {
    const {
        chain,
        selectedTrack,
        rackRef,
        selectedDeviceIds,
        isDropActive,
        draggingItem,
        inLevelL,
        inLevelR,
        selectDevice,
        statusClear,
    } = logic;

    const [deviceContextMenu, setDeviceContextMenu] = useState<{ device: DeviceSlotModel; x: number; y: number } | null>(null);

    const selectedDeviceId = selectedDeviceIds[0] ?? '';
    const pluginDragName = draggingItem?.type === 'plugin' ? draggingItem.name : '';
    const isPluginDropActive = isDropActive && draggingItem?.type === 'plugin';
    const effectIds = (selectedTrack?.effects ?? [])
        .map((effect) => effect?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    const effectIdSet = new Set(effectIds);

    return (
        <div
            ref={rackRef}
            tabIndex={0}
            data-keyboard-scope="device-rack"
            data-selected-device-id={selectedDeviceId}
            onMouseDown={() => { useFocusPanelStore.getState().setActivePanel('device-rack'); rackRef.current?.focus(); }}
            style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                background: 'var(--color-bg-panel)',
                position: 'relative',
                outline: isDropActive ? 'var(--space-0-5) solid var(--color-accent-primary)' : 'none',
                boxShadow: isDropActive
                    ? 'inset 0 0 0 var(--space-px) color-mix(in srgb, var(--color-accent-primary) 35%, transparent)'
                    : 'none',
            }}
        >
            <div
                className="scrollbar-hide"
                onClick={(e) => {
                    if (e.target === e.currentTarget) selectDevice('', false);
                }}
                style={{
                    display: 'flex',
                    alignItems: 'stretch',
                    flexWrap: rackExpanded ? 'wrap' : 'nowrap',
                    alignContent: rackExpanded ? 'flex-start' : undefined,
                    gap: 'var(--space-1-5)',
                    padding: 'var(--space-2-5)',
                    flex: 1,
                    minHeight: 0,
                    overflowX: rackExpanded ? 'hidden' : 'auto',
                    overflowY: rackExpanded ? 'auto' : 'hidden',
                    // In 2-row mode, each slot fills exactly half the container height
                    // (minus gap between rows). Fallback: 100% for 1-row mode.
                    ...(rackExpanded ? { '--rack-row-height': 'calc(50% - var(--space-1-5) / 2)' } as React.CSSProperties : {}),
                }}
            >
                <MeterStrip levelL={inLevelL} levelR={inLevelR} isMidi={selectedTrack?.track_type === 'Midi'} />
                {chain.length > 0 ? (
                    chain.map((device, deviceIndex) => (
                        <DeviceSlot
                            key={device.id}
                            device={device}
                            deviceIndex={deviceIndex}
                            logic={logic}
                            onContextMenu={(e, dev) => {
                                setDeviceContextMenu({ device: dev, x: e.clientX, y: e.clientY });
                            }}
                        />
                    ))
                ) : (
                    <EmptyState />
                )}
                {effectIds.length > 0 && (
                    <div
                        className="dream-device-drop-indicator-end"
                        onDragOver={(e) => {
                            const draggedId = e.dataTransfer.getData('application/x-dream-device-id')
                                || e.dataTransfer.getData('text/plain');
                            if (!draggedId || !effectIdSet.has(draggedId)) return;
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                            (e.currentTarget as HTMLElement).style.borderLeft = 'var(--token-size-px-3) solid var(--color-accent-primary)';
                        }}
                        onDragLeave={(e) => {
                            (e.currentTarget as HTMLElement).style.borderLeft = '';
                        }}
                        onDrop={(e) => {
                            e.preventDefault();
                            (e.currentTarget as HTMLElement).style.borderLeft = '';
                            const draggedId = e.dataTransfer.getData('application/x-dream-device-id')
                                || e.dataTransfer.getData('text/plain');
                            if (!draggedId || !selectedTrack || !effectIdSet.has(draggedId)) return;
                            const fromEffectIndex = effectIds.findIndex((id) => id === draggedId);
                            if (fromEffectIndex < 0 || fromEffectIndex === effectIds.length - 1) return;
                            void engineApi
                                .moveEffectSlotWithDeltas(selectedTrack.id, draggedId, effectIds.length - 1)
                                .then((response) => logic.applyProjectDeltas(response.deltas, 'device-rack:move-effect-slot-end'))
                                .catch((err) => console.error('[Dream] moveEffectSlot(end) failed:', err));
                        }}
                        style={{
                            width: 14,
                            minWidth: 14,
                            borderLeft: 'var(--space-px) solid transparent',
                            transition: 'border-color 0.1s ease',
                            flexShrink: 0,
                            height: rackExpanded ? 'var(--rack-row-height, 100%)' : '100%',
                        }}
                    />
                )}
                <AddDeviceButton onClick={statusClear} />
            </div>
            {isPluginDropActive && (
                <div
                    style={{
                        position: 'absolute',
                        right: 10,
                        top: 10,
                        zIndex: 'var(--z-header)',
                        border: 'var(--space-px) solid color-mix(in srgb, var(--color-accent-primary) 65%, var(--token-color-hex-ffffff22))',
                        borderRadius: 'var(--radius-lg)',
                        padding: 'var(--token-size-px-5) var(--space-2)',
                        background: 'color-mix(in srgb, var(--color-bg-panel) 72%, var(--color-accent-primary) 28%)',
                        color: 'var(--color-text-primary)',
                        fontSize: 'var(--font-size-xs)',
                        fontWeight: 'var(--font-weight-bold)',
                        letterSpacing: '0.03em',
                        pointerEvents: 'none',
                        textTransform: 'uppercase',
                    }}
                >
                    Drop Plugin: {pluginDragName}
                </div>
            )}
            {deviceContextMenu && (
                <DeviceContextMenuPopup
                    x={deviceContextMenu.x}
                    y={deviceContextMenu.y}
                    deviceId={deviceContextMenu.device.id}
                    deviceName={deviceContextMenu.device.name}
                    isEnabled={deviceContextMenu.device.isEnabled}
                    onGroup={() => {
                        // TODO: Implement wrap-in-rack via backend API when available
                        console.log('[Dream] Group device into rack:', deviceContextMenu.device.id);
                        setDeviceContextMenu(null);
                    }}
                    onBypass={() => {
                        logic.toggleDevice(deviceContextMenu.device);
                        setDeviceContextMenu(null);
                    }}
                    onDelete={() => {
                        if (!selectedTrack) { setDeviceContextMenu(null); return; }
                        void engineApi
                            .removePluginFromTrackWithDeltas(selectedTrack.id, deviceContextMenu.device.id)
                            .then((res) => logic.applyProjectDeltas(res.deltas, 'device-rack:remove-device-ctx'))
                            .catch((err) => console.error('[Dream] removePlugin via context menu failed:', err));
                        setDeviceContextMenu(null);
                    }}
                    onDismiss={() => setDeviceContextMenu(null)}
                />
            )}
        </div>
    );
}
