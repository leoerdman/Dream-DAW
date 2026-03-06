import React, { memo } from 'react';
import type { TrackData, TrackRowLayoutMetrics } from '@/widgets/TrackInspector/model/trackModels';
import type { AutomationLane } from '@/shared/stores/useAutomationStore';

type RoutingTarget = {
    id: string;
    name: string;
};

interface TrackRowRoutingProps {
    track: TrackData;
    routingTargets: RoutingTarget[];
    isMasterFixed?: boolean;
    layout: TrackRowLayoutMetrics;
    heightLevel: number;
    onOutputChange?: (targetId: string) => void;
    onInputChange?: (inputId: string) => void;
    /** When true, switch to automation parameter display instead of routing. */
    automationVisible?: boolean;
    /** Visible automation lanes for this track (from the store). */
    automationLanes?: AutomationLane[];
    /** Called when the user clicks the automation parameter dropdown trigger. */
    onAutomationParamClick?: (x: number, y: number, laneId: string) => void;
}

export const TrackRowRouting = memo(({
    track,
    routingTargets,
    isMasterFixed,
    layout,
    heightLevel,
    onOutputChange,
    onInputChange,
    automationVisible,
    automationLanes,
    onAutomationParamClick,
}: TrackRowRoutingProps) => {
    // ── Automation Mode ───────────────────────────────────────────
    // When automation is visible, replace Input/Output selects with
    // the automation parameter label + dropdown trigger (Ableton-style).
    if (automationVisible && automationLanes && automationLanes.length > 0) {
        const firstLane = automationLanes[0];
        return (
            <div
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    gap: 3,
                    padding: 4,
                    borderRight: 'var(--space-px) solid var(--color-border-subtle)',
                    width: layout.routingColWidth,
                    minWidth: layout.routingColWidth,
                    maxWidth: layout.routingColWidth,
                    boxSizing: 'border-box',
                    background: 'color-mix(in srgb, var(--color-accent-primary) 6%, var(--surface-2) 94%)',
                }}
            >
                {/* Label */}
                <div
                    style={{
                        fontSize: 'var(--font-size-micro)',
                        fontWeight: 'var(--font-weight-semibold)',
                        color: 'var(--color-accent-primary)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        lineHeight: 1,
                        userSelect: 'none',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                    }}
                >
                    Automation
                </div>
                {/* Parameter Dropdown Trigger */}
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        const rect = e.currentTarget.getBoundingClientRect();
                        onAutomationParamClick?.(rect.left, rect.bottom + 4, firstLane.id);
                    }}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 4,
                        fontSize: 'var(--font-size-2xs)',
                        fontWeight: 'var(--font-weight-medium)',
                        color: firstLane.color || 'var(--color-text-primary)',
                        background: 'var(--color-control-bg)',
                        border: 'var(--space-px) solid var(--color-control-border)',
                        borderRadius: 'var(--radius-md)',
                        padding: '0 var(--space-1-5) 0 var(--space-1-5)',
                        lineHeight: 'var(--token-size-px-15)',
                        height: 15,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        textAlign: 'left',
                        minWidth: 0,
                        width: '100%',
                        boxSizing: 'border-box',
                        transition: 'background var(--transition-fast)',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-control-bg)'; }}
                    title={`Automation: ${firstLane.paramName}`}
                >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
                        {firstLane.paramName}
                    </span>
                    <svg width="8" height="5" viewBox="0 0 8 5" fill="currentColor" style={{ flexShrink: 0, opacity: 0.5 }}>
                        <path d="M0.5 0.5L4 4L7.5 0.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    </svg>
                </button>
            </div>
        );
    }

    // ── Normal Routing Mode ───────────────────────────────────────
    const availableRoutingTargets = routingTargets.filter((t) => t.id !== track.id);
    const outputValue =
        track.output &&
            (track.output === 'master' || availableRoutingTargets.some((t) => t.id === track.output))
            ? track.output
            : 'master';
    const inputValue =
        track.input &&
            (track.input === 'none' ||
                track.input === 'ext-1' ||
                track.input === 'ext-2' ||
                availableRoutingTargets.some((t) => t.id === track.input))
            ? track.input
            : 'none';

    if (isMasterFixed) {
        return (
            <div
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    gap: 4,
                    padding: 4,
                    borderRight: 'var(--space-px) solid var(--color-border-subtle)',
                    width: layout.routingColWidth,
                    minWidth: layout.routingColWidth,
                    maxWidth: layout.routingColWidth,
                    boxSizing: 'border-box',
                    background: 'color-mix(in srgb, var(--surface-2) 55%, transparent)',
                }}
            >
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        fontSize: 'var(--font-size-2xs)',
                        fontWeight: 'var(--font-weight-medium)',
                        color: 'var(--color-text-tertiary)',
                        background: 'var(--color-control-bg)',
                        border: 'var(--space-px) solid var(--color-control-border)',
                        borderRadius: 'var(--radius-md)',
                        padding: '0 var(--space-2) 0 var(--space-1-5)',
                        lineHeight: 'var(--token-size-px-15)',
                        height: 15,
                        cursor: 'default',
                        userSelect: 'none',
                    }}
                >
                    <span style={{ marginRight: 4, fontSize: 'var(--font-size-micro)' }}>←</span>
                    No Input
                </div>
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        fontSize: 'var(--font-size-2xs)',
                        fontWeight: 'var(--font-weight-medium)',
                        color: 'var(--color-text-secondary)',
                        background: 'var(--color-control-bg)',
                        border: 'var(--space-px) solid var(--color-control-border)',
                        borderRadius: 'var(--radius-md)',
                        padding: '0 var(--space-2) 0 var(--space-1-5)',
                        lineHeight: 'var(--token-size-px-15)',
                        height: 15,
                        cursor: 'default',
                        userSelect: 'none',
                    }}
                >
                    <span style={{ marginRight: 4, fontSize: 'var(--font-size-micro)' }}>→</span>
                    Out 1-2
                </div>
            </div>
        );
    }

    // ENTERPRISE FIX: Always show at least output routing — never collapse to width:0.
    // Input routing shown at Level 2+ (48px) where space permits.
    const showInput = heightLevel >= 2;

    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'flex-start',
                gap: 4,
                padding: 4,
                borderRight: 'var(--space-px) solid var(--color-border-subtle)',
                width: layout.routingColWidth,
                minWidth: layout.routingColWidth,
                maxWidth: layout.routingColWidth,
                boxSizing: 'border-box',
                background: 'color-mix(in srgb, var(--surface-2) 55%, transparent)',
            }}
        >
            {showInput && (
                <RoutingSelect
                    arrow="←"
                    value={inputValue}
                    title="Audio From"
                    options={[
                        { value: 'none', label: 'No Input' },
                        { value: 'ext-1', label: 'Ext. In 1' },
                        { value: 'ext-2', label: 'Ext. In 2' },
                        ...availableRoutingTargets.map((t) => ({ value: t.id, label: t.name })),
                    ]}
                    onChange={onInputChange}
                />
            )}
            <RoutingSelect
                arrow="→"
                value={outputValue}
                title="Audio To"
                options={[
                    { value: 'master', label: 'Master' },
                    ...availableRoutingTargets.map((t) => ({ value: t.id, label: t.name })),
                ]}
                onChange={onOutputChange}
            />
        </div>
    );
});

interface RoutingSelectProps {
    arrow: string;
    value: string;
    title: string;
    options: Array<{ value: string; label: string }>;
    onChange?: (value: string) => void;
}

function RoutingSelect({ arrow, value, title, options, onChange }: RoutingSelectProps) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ position: 'relative', display: 'flex', flex: 1, minWidth: 0 }}>
                <span
                    style={{
                        position: 'absolute',
                        left: 6,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        fontSize: 'var(--font-size-micro)',
                        color: 'var(--color-text-tertiary)',
                        pointerEvents: 'none',
                        zIndex: 'var(--z-local)',
                    }}
                >
                    {arrow}
                </span>
                <select
                    onClick={(e) => e.stopPropagation()}
                    value={value}
                    onChange={(e) => {
                        e.stopPropagation();
                        onChange?.(e.target.value);
                    }}
                    title={title}
                    style={{
                        fontSize: 'var(--font-size-2xs)',
                        fontWeight: 'var(--font-weight-medium)',
                        color: 'var(--color-text-primary)',
                        background: 'var(--color-control-bg)',
                        border: 'var(--space-px) solid var(--color-control-border)',
                        borderRadius: 'var(--radius-md)',
                        padding: '0 var(--space-4) 0 var(--space-3-5)',
                        cursor: 'pointer',
                        minWidth: 0,
                        flexShrink: 1,
                        flex: 1,
                        appearance: 'auto' as React.CSSProperties['appearance'],
                        lineHeight: 'var(--token-size-px-15)',
                        height: 15,
                    }}
                >
                    {options.map((option) => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
            </div>
        </div>
    );
}
