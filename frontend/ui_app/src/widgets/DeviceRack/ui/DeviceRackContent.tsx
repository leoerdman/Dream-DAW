import React, { useMemo, useState } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { MeterStrip } from '@/shared/ui/MeterStrip';
import * as engineApi from '@/shared/api/engine';
import { useFocusPanelStore } from '@/shared/stores/useFocusPanelStore';
import type { DeviceRackLogicOutput } from '@/widgets/DeviceRack/model/useDeviceRackLogic';
import type { DeviceSlot as DeviceSlotModel } from '@/widgets/DeviceRack/model/types';
import { AddDeviceButton } from '@/widgets/DeviceRack/ui/AddDeviceButton';
import { DeviceSlot, EmptyState } from '@/widgets/DeviceRack/ui/DeviceRackSlots';
import { DeviceContextMenuPopup } from '@/widgets/DeviceRack/ui/DeviceContextMenuPopup';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { clamp01 } from '@/shared/lib/audioMath';
import { dbToMeterNorm } from '@/shared/lib/meterManifest';

const DeviceRackInputMeter = React.memo(function DeviceRackInputMeter({
    trackId,
    isMaster,
    isMidi,
}: {
    trackId: string;
    isMaster: boolean;
    isMidi: boolean;
}) {
    const meterLRef = React.useRef(0);
    const meterRRef = React.useRef(0);
    const holdLRef = React.useRef(0);
    const holdRRef = React.useRef(0);
    const rafIdRef = React.useRef(0);
    const mountedRef = React.useRef(true);
    const lastValuesRef = React.useRef({ mL: 0, mR: 0, hL: 0, hR: 0 });

    const [meterState, setMeterState] = React.useState({ mL: 0, mR: 0, hL: 0, hR: 0 });

    React.useEffect(() => {
        mountedRef.current = true;
        const unsub = useEngineStore.subscribe((state) => {
            const trackIndex = state.tracks.allIds.indexOf(trackId);
            const meterPair = isMaster ? null : (trackIndex >= 0 ? state.meters.tracks[trackIndex] ?? null : null);

            const peakDbL = isMaster ? state.meters.master_left.peak : (meterPair?.[0]?.peak ?? -96);
            const peakDbR = isMaster ? state.meters.master_right.peak : (meterPair?.[1]?.peak ?? -96);

            const mL = clamp01(dbToMeterNorm(peakDbL));
            const mR = clamp01(dbToMeterNorm(peakDbR));

            const peakHoldDbL = isMaster ? (state.meters.master_left.peak_hold ?? peakDbL) : (meterPair?.[0]?.peak_hold ?? peakDbL);
            const peakHoldDbR = isMaster ? (state.meters.master_right.peak_hold ?? peakDbR) : (meterPair?.[1]?.peak_hold ?? peakDbR);

            const hL = clamp01(dbToMeterNorm(peakHoldDbL));
            const hR = clamp01(dbToMeterNorm(peakHoldDbR));

            const last = lastValuesRef.current;
            if (mL === last.mL && mR === last.mR && hL === last.hL && hR === last.hR) return;

            meterLRef.current = mL;
            meterRRef.current = mR;
            holdLRef.current = hL;
            holdRRef.current = hR;
            lastValuesRef.current = { mL, mR, hL, hR };

            if (rafIdRef.current) return;
            rafIdRef.current = requestAnimationFrame(() => {
                rafIdRef.current = 0;
                if (mountedRef.current) {
                    setMeterState({
                        mL: meterLRef.current,
                        mR: meterRRef.current,
                        hL: holdLRef.current,
                        hR: holdRRef.current,
                    });
                }
            });
        });

        return () => {
            mountedRef.current = false;
            unsub();
            if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
        };
    }, [trackId, isMaster]);

    return (
        <MeterStrip
            levelL={meterState.mL}
            levelR={meterState.mR}
            peakHoldL={meterState.hL}
            peakHoldR={meterState.hR}
            isMidi={isMidi}
        />
    );
});

interface DeviceRackContentProps {
    logic: DeviceRackLogicOutput;
    rackExpanded?: boolean;
}

export function DeviceRackContent({ logic, rackExpanded }: DeviceRackContentProps) {
    const {
        chain,
        selectedTrack,
        selectedTrackId,
        isMaster,
        rackRef,
        selectedDeviceIds,
        isDropActive,
        draggingItem,
        selectDevice,
        statusClear,
    } = logic;

    const [deviceContextMenu, setDeviceContextMenu] = useState<{ device: DeviceSlotModel; x: number; y: number } | null>(null);

    const selectedDeviceId = selectedDeviceIds[0] ?? '';
    const pluginDragName = draggingItem?.type === 'plugin' ? draggingItem.name : '';
    const isPluginDropActive = isDropActive && draggingItem?.type === 'plugin';
    const effectIds = useMemo(() =>
        (selectedTrack?.effects ?? [])
            .map((effect) => effect?.id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0),
        [selectedTrack?.effects],
    );
    const effectIdSet = useMemo(() => new Set(effectIds), [effectIds]);

    return (
        <div
            ref={rackRef}
            tabIndex={0}
            data-keyboard-scope="device-rack"
            data-selected-device-id={selectedDeviceId}
            onPointerDown={() => { useFocusPanelStore.getState().setActivePanel('device-rack'); rackRef.current?.focus(); }}
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
                <DeviceRackInputMeter
                    trackId={selectedTrackId}
                    isMaster={isMaster}
                    isMidi={selectedTrack?.track_type === 'Midi'}
                />
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
                                .catch((err) => { console.error('[Dream] moveEffectSlot(end) failed:', err); useStatusStore.getState().setError(`Move effect failed: ${err instanceof Error ? err.message : String(err)}`); });
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
                        if (!selectedTrack) { setDeviceContextMenu(null); return; }
                        const deviceId = deviceContextMenu.device.id;
                        const deviceName = deviceContextMenu.device.name;
                        void engineApi
                            .createRackFromDevicesWithDeltas(selectedTrack.id, [deviceId], `${deviceName} Rack`, 'audio_effect')
                            .then((response) => {
                                logic.applyProjectDeltas(response.deltas, 'device-rack:wrap-in-rack');
                            })
                            .catch((err) => { console.error('[Dream] Wrap-in-rack failed:', err); useStatusStore.getState().setError(`Wrap in rack failed: ${err instanceof Error ? err.message : String(err)}`); });
                        setDeviceContextMenu(null);
                    }}
                    onBypass={() => {
                        logic.toggleDevice(deviceContextMenu.device);
                        setDeviceContextMenu(null);
                    }}
                    onDelete={() => {
                        if (!selectedTrack) { setDeviceContextMenu(null); return; }
                        const deletedDevice = deviceContextMenu.device;
                        void engineApi
                            .removePluginFromTrackWithDeltas(selectedTrack.id, deletedDevice.id)
                            .then(async (res) => {
                                logic.applyProjectDeltas(res.deltas, 'device-rack:remove-device-ctx');
                                // ENTERPRISE FIX: Disable instrument engines on the audio thread.
                                // Without this, Flow/Essence synth engines continue to produce
                                // audio even after the device is removed from the project model.
                                if (deletedDevice.pluginId === 'internal://instrument/flow') {
                                    const { disableFlowEngine } = await import('@/widgets/FlowSynth/model/useFlowSynthStore');
                                    void disableFlowEngine(selectedTrack.id);
                                }
                            })
                            .catch((err) => { console.error('[Dream] removePlugin via context menu failed:', err); useStatusStore.getState().setError(`Remove plugin failed: ${err instanceof Error ? err.message : String(err)}`); });
                        setDeviceContextMenu(null);
                    }}
                    onDismiss={() => setDeviceContextMenu(null)}
                />
            )}
        </div>
    );
}
