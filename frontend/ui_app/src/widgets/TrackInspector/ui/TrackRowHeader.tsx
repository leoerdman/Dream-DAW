import { useEffect, useRef } from 'react';
import type React from 'react';
import { getContrastColor } from '@/shared/lib/colorUtils';
import type { TrackData, TrackRowLayoutMetrics } from '@/widgets/TrackInspector/model/trackModels';

interface TrackRowHeaderProps {
    track: TrackData;
    trackHeight: number;
    isMaster: boolean;
    isGroup: boolean;
    isHeaderSelected: boolean;
    isHeaderPrimarySelected: boolean;
    isCollapsed: boolean;
    isRenaming: boolean;
    renameValue: string;
    depth: number;
    groupRailColor: string;
    layout: TrackRowLayoutMetrics;
    mixerFocusMode: boolean;
    onRenameChange: (v: string) => void;
    onRenameCommit: () => void;
    onRenameCancel: () => void;
    onToggleCollapse?: () => void;
    onHeaderPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
    onHeaderClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
}

export function TrackRowHeader({
    track,
    isMaster,
    isGroup,
    isHeaderPrimarySelected,
    isCollapsed,
    isRenaming,
    renameValue,
    depth,
    groupRailColor,
    layout,
    mixerFocusMode,
    onRenameChange,
    onRenameCommit,
    onRenameCancel,
    onToggleCollapse,
    onHeaderPointerDown,
    onHeaderClick,
}: TrackRowHeaderProps) {
    const renameInputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (isRenaming && renameInputRef.current) {
            renameInputRef.current.focus();
            renameInputRef.current.select();
        }
    }, [isRenaming]);

    const headerBgColor = track.color;
    const headerContrast = getContrastColor(track.color);
    const headerTextColor =
        headerContrast === 'black'
            ? 'var(--glass-bg)'
            : 'color-mix(in srgb, var(--color-text-primary) 94%, transparent)';
    const indentW = !isMaster && depth > 0 ? Math.min(layout.maxIndentPx, depth * layout.indentStepPx) : 0;
    const stripeW = !isMaster && depth > 0 ? layout.groupStripeWidthPx : 0;
    // Master gets extra base padding to visually align text with other tracks
    const basePaddingLeft = (mixerFocusMode ? 5 : 4) + indentW + (isMaster ? 4 : 0);

    return (
        <div
            data-track-header="true"
            onPointerDown={onHeaderPointerDown}
            onClick={onHeaderClick}
            style={{
                width: layout.headerColWidth,
                minWidth: layout.headerColWidth,
                maxWidth: layout.headerColWidth,
                display: 'flex',
                alignItems: 'stretch',
                borderRight: 'var(--space-px) solid var(--color-border-subtle)',
                boxSizing: 'border-box',
                cursor: !isMaster ? 'grab' : 'default',
            }}
        >
            {stripeW > 0 && (
                <div
                    aria-hidden
                    style={{
                        width: stripeW,
                        minWidth: stripeW,
                        background: `color-mix(in srgb, ${groupRailColor} 70%, var(--token-color-hex-000000))`,
                        opacity: 1,
                    }}
                />
            )}
            <div
                style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    padding: `var(--space-0-5) ${mixerFocusMode ? 8 : 6}px var(--space-0-5) ${basePaddingLeft}px`,
                    background: headerBgColor,
                    boxShadow: isHeaderPrimarySelected
                        ? 'inset 0 0 0 var(--token-size-px-2) color-mix(in srgb, var(--color-text-bright) 90%, transparent)'
                        : 'none',
                    gap: 1,
                    position: 'relative',
                    boxSizing: 'border-box',
                    minWidth: 0,
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                    {isGroup && onToggleCollapse ? (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onToggleCollapse();
                            }}
                            style={{
                                width: 12,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: 'none',
                                border: 'none',
                                color: headerTextColor,
                                fontSize: 'var(--font-size-micro)',
                                cursor: 'pointer',
                                flexShrink: 0,
                                padding: 0,
                            }}
                        >
                            {isCollapsed ? '▶' : '▼'}
                        </button>
                    ) : null}

                    {isRenaming ? (
                        <input
                            ref={renameInputRef}
                            value={renameValue}
                            onChange={(e) => onRenameChange(e.target.value)}
                            onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === 'Enter') onRenameCommit();
                                if (e.key === 'Escape') onRenameCancel();
                            }}
                            onBlur={onRenameCommit}
                            onClick={(e) => e.stopPropagation()}
                            style={{
                                fontSize: 'var(--font-size-xs)',
                                fontWeight: 'var(--font-weight-semibold)',
                                background:
                                    headerContrast === 'black'
                                        ? 'var(--token-color-rgba-255-255-255-0d42)'
                                        : 'var(--token-color-rgba-0-0-0-0d34)',
                                border: `var(--space-px) solid ${track.color}`,
                                borderRadius: 'var(--radius-xs)',
                                color: headerTextColor,
                                padding: 'var(--space-px) var(--token-size-px-3)',
                                outline: 'none',
                                minWidth: 0,
                            }}
                        />
                    ) : (
                        <span
                            style={{
                                flex: 1,
                                fontSize: 'var(--font-size-base)',
                                fontWeight: isGroup ? 700 : 600,
                                color: headerTextColor,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                minWidth: 0,
                            }}
                        >
                            {track.name}
                        </span>
                    )}
                </div>

                {!isGroup && !isMaster && (
                    <span
                        style={{
                            position: 'absolute',
                            top: 3,
                            right: 4,
                            display: 'inline-flex',
                            alignItems: 'center',
                            opacity: 0.55,
                        }}
                    >
                        {track.type === 'midi' ? (
                            <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                                <rect x="0" y="1" width="3" height="10" rx="0.5" fill={headerTextColor} />
                                <rect x="4.5" y="1" width="3" height="10" rx="0.5" fill={headerTextColor} />
                                <rect x="9" y="1" width="3" height="10" rx="0.5" fill={headerTextColor} />
                                <rect
                                    x="2"
                                    y="1"
                                    width="2"
                                    height="6"
                                    rx="0.3"
                                    fill={headerContrast === 'black' ? 'var(--token-color-rgba-255-255-255-0d65)' : 'var(--token-color-rgba-0-0-0-0d65)'}
                                />
                                <rect
                                    x="6.5"
                                    y="1"
                                    width="2"
                                    height="6"
                                    rx="0.3"
                                    fill={headerContrast === 'black' ? 'var(--token-color-rgba-255-255-255-0d65)' : 'var(--token-color-rgba-0-0-0-0d65)'}
                                />
                            </svg>
                        ) : (
                            <svg width="9" height="9" viewBox="0 0 14 10" fill="none">
                                <path
                                    d="M1 5 L2.5 2 L4 7 L5.5 1 L7 9 L8.5 3 L10 6 L11.5 4 L13 5"
                                    stroke={headerTextColor}
                                    strokeWidth="1.2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                />
                            </svg>
                        )}
                    </span>
                )}
            </div>
        </div>
    );
}
