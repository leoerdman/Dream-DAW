import type React from 'react';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import type { DeviceRackLogicOutput } from '@/widgets/DeviceRack/model/useDeviceRackLogic';

const autoCtxMenuItemStyle: React.CSSProperties = {
    display: 'block',
    width: '100%',
    padding: '5px 8px',
    border: 'none',
    background: 'transparent',
    color: 'var(--color-text-primary)',
    fontSize: 'var(--font-size-sm)',
    fontWeight: 500,
    textAlign: 'left',
    cursor: 'pointer',
    borderRadius: 'var(--radius-sm)',
    transition: 'background var(--transition-fast)',
};

interface DeviceRackAutomationMenuProps {
    selectedTrackId: string;
    logic: DeviceRackLogicOutput;
}

export function DeviceRackAutomationMenu({ selectedTrackId, logic }: DeviceRackAutomationMenuProps) {
    if (!logic.autoCtxMenu) return null;

    const existingLane = Object.values(logic.automationLanes).find(
        (lane) =>
            lane.trackId === selectedTrackId &&
            lane.paramKey === `${logic.autoCtxMenu!.deviceId}:${logic.autoCtxMenu!.paramName}`,
    );

    return (
        <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
                position: 'fixed',
                left: logic.autoCtxMenu.x,
                top: logic.autoCtxMenu.y,
                zIndex: 'var(--z-menu)' as unknown as number,
                background: 'var(--color-bg-elevated)',
                border: '1px solid var(--color-divider)',
                borderRadius: 'var(--radius-sm)',
                padding: 4,
                minWidth: 200,
                boxShadow: '0 8px 24px var(--color-overlay-dark)',
            }}
        >
            <div
                style={{
                    fontSize: 'var(--font-size-xs)',
                    color: 'var(--color-text-tertiary)',
                    padding: '4px 8px',
                    fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                }}
            >
                Automation: {logic.autoCtxMenu.paramName}
            </div>
            {existingLane ? (
                <button
                    onClick={() => {
                        logic.removeAutomationLane(existingLane.id);
                        logic.setAutoCtxMenu(null);
                    }}
                    style={autoCtxMenuItemStyle}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'var(--color-bg-hover)';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                    }}
                >
                    ✕ Remove Automation Lane
                </button>
            ) : (
                <button
                    onClick={() => {
                        logic.addAutomationLane(
                            selectedTrackId,
                            logic.autoCtxMenu!.paramName,
                            `${logic.autoCtxMenu!.deviceId}:${logic.autoCtxMenu!.paramName}`,
                        );
                        if (!useAutomationStore.getState().globalVisible) {
                            logic.toggleGlobalAutomation();
                        }
                        logic.setAutoCtxMenu(null);
                    }}
                    style={autoCtxMenuItemStyle}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'var(--color-bg-hover)';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                    }}
                >
                    ⊕ Add Automation Lane
                </button>
            )}
        </div>
    );
}
