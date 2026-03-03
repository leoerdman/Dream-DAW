import React, { memo } from 'react';
import type { TrackData, TrackRowLayoutMetrics } from '@/widgets/TrackInspector/model/trackModels';

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
}

export const TrackRowRouting = memo(({
    track,
    routingTargets,
    isMasterFixed,
    layout,
    heightLevel,
    onOutputChange,
    onInputChange,
}: TrackRowRoutingProps) => {
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
