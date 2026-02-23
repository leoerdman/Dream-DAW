import { MeterStrip } from '@/shared/ui/MeterStrip';
import type { DeviceRackLogicOutput } from '@/widgets/DeviceRack/model/useDeviceRackLogic';
import { AddDeviceButton } from '@/widgets/DeviceRack/ui/AddDeviceButton';
import { DeviceSlot, EmptyState } from '@/widgets/DeviceRack/ui/DeviceRackSlots';

interface DeviceRackContentProps {
    logic: DeviceRackLogicOutput;
}

export function DeviceRackContent({ logic }: DeviceRackContentProps) {
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

    const selectedDeviceId = selectedDeviceIds[0] ?? '';
    const pluginDragName = draggingItem?.type === 'plugin' ? draggingItem.name : '';
    const isPluginDropActive = isDropActive && draggingItem?.type === 'plugin';

    return (
        <div
            ref={rackRef}
            tabIndex={0}
            data-keyboard-scope="device-rack"
            data-selected-device-id={selectedDeviceId}
            onMouseDown={() => rackRef.current?.focus()}
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
                    gap: 6,
                    padding: 'var(--space-2-5)',
                    flex: 1,
                    minHeight: 0,
                    overflowX: 'auto',
                    overflowY: 'hidden',
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
                        />
                    ))
                ) : (
                    <EmptyState />
                )}
                <AddDeviceButton onClick={statusClear} />
            </div>
            {isPluginDropActive && (
                <div
                    style={{
                        position: 'absolute',
                        right: 10,
                        top: 10,
                        zIndex: 'var(--z-header)' as unknown as number,
                        border: 'var(--space-px) solid color-mix(in srgb, var(--color-accent-primary) 65%, var(--token-color-hex-ffffff22))',
                        borderRadius: 'var(--radius-lg)',
                        padding: 'var(--token-size-px-5) var(--space-2)',
                        background: 'color-mix(in srgb, var(--color-bg-panel) 72%, var(--color-accent-primary) 28%)',
                        color: 'var(--color-text-primary)',
                        fontSize: 'var(--font-size-xs)',
                        fontWeight: 'var(--font-weight-bold)' as unknown as number,
                        letterSpacing: '0.03em',
                        pointerEvents: 'none',
                        textTransform: 'uppercase',
                    }}
                >
                    Drop Plugin: {pluginDragName}
                </div>
            )}
        </div>
    );
}
