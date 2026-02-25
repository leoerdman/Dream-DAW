import { useEffect, useRef } from 'react';
import type React from 'react';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import type { DeviceRackLogicOutput } from '@/widgets/DeviceRack/model/useDeviceRackLogic';

const autoCtxMenuItemStyle: React.CSSProperties = {
    display: 'block',
    width: '100%',
    padding: 'var(--token-size-px-5) var(--space-2)',
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
    const { autoCtxMenu, setAutoCtxMenu } = logic;
    const menuRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!autoCtxMenu) return;
        const handleClick = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setAutoCtxMenu(null);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [autoCtxMenu, setAutoCtxMenu]);

    if (!autoCtxMenu) return null;

    const existingLane = Object.values(logic.automationLanes).find(
        (lane) =>
            lane.trackId === selectedTrackId &&
            lane.paramKey === `${autoCtxMenu.deviceId}:${autoCtxMenu.paramName}`,
    );

    return (
        <div
            ref={menuRef}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
                position: 'fixed',
                left: autoCtxMenu.x,
                top: autoCtxMenu.y,
                zIndex: 'var(--z-menu)',
                background: 'var(--color-bg-elevated)',
                border: 'var(--space-px) solid var(--color-divider)',
                borderRadius: 'var(--radius-sm)',
                padding: 'var(--space-1)',
                minWidth: 200,
                boxShadow: '0 var(--space-2) var(--space-6) var(--color-overlay-dark)',
            }}
        >
            <div
                style={{
                    fontSize: 'var(--font-size-xs)',
                    color: 'var(--color-text-tertiary)',
                    padding: 'var(--space-1) var(--space-2)',
                    fontWeight: 'var(--font-weight-semibold)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                }}
            >
                Automation: {autoCtxMenu.paramName}
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
                            autoCtxMenu.paramName,
                            `${autoCtxMenu.deviceId}:${autoCtxMenu.paramName}`,
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
