import { memo } from 'react';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import type { AutomationLane } from '@/shared/stores/useAutomationStore';
import { AUTOMATION_LANE_HEIGHT_PX } from '@/shared/config/layoutConstants';

interface TrackAutomationLaneHeaderProps {
    lane: AutomationLane;
    trackColor: string;
    isFirstLane: boolean;
    onParamContextMenu: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

export const TrackAutomationLaneHeader = memo(({
    lane,
    trackColor,
    isFirstLane,
    onParamContextMenu,
}: TrackAutomationLaneHeaderProps) => {
    const removeLane = useAutomationStore((s) => s.removeLane);

    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                height: AUTOMATION_LANE_HEIGHT_PX,
                boxSizing: 'border-box',
                borderTop: 'var(--space-px) solid var(--color-divider)',
                background: 'color-mix(in srgb, var(--color-bg-panel) 85%, var(--token-color-hex-000000) 15%)',
                paddingLeft: 24,
                paddingRight: 8,
                position: 'relative',
            }}
        >
            {/* Color stripe on the left to match track hierarchy vibe */}
            <div
                style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: 4,
                    background: lane.color || trackColor,
                    opacity: 0.8,
                }}
            />

            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                {/* Parameter dropdown / context menu trigger */}
                <button
                    onClick={onParamContextMenu}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        background: 'var(--surface-2)',
                        border: 'var(--space-px) solid var(--color-border-subtle)',
                        borderRadius: 'var(--radius-sm)',
                        padding: '4px 8px',
                        color: 'var(--color-text-primary)',
                        fontSize: 'var(--font-size-xs)',
                        fontWeight: 500,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        flex: 1,
                        minWidth: 0,
                        textAlign: 'left',
                        boxShadow: 'var(--shadow-sm)',
                        transition: 'background var(--transition-fast)',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
                >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', color: lane.color || 'inherit' }}>
                        {lane.paramName}
                    </span>
                    <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor" style={{ flexShrink: 0, opacity: 0.5 }}>
                        <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    </svg>
                </button>

                {/* Remove lane button */}
                {!isFirstLane && (
                    <button
                        onClick={() => removeLane(lane.id)}
                        title="Remove Automation Lane"
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--color-text-tertiary)',
                            cursor: 'pointer',
                            padding: 4,
                            borderRadius: 'var(--radius-xs)',
                            flexShrink: 0,
                            transition: 'color var(--transition-fast), background var(--transition-fast)',
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.color = 'var(--color-status-error)';
                            e.currentTarget.style.background = 'color-mix(in srgb, var(--color-status-error) 15%, transparent)';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.color = 'var(--color-text-tertiary)';
                            e.currentTarget.style.background = 'transparent';
                        }}
                    >
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <path d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    </button>
                )}
            </div>
        </div>
    );
});
