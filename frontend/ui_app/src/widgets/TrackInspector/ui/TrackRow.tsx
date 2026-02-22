import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { getContrastColor } from '@/shared/lib/colorUtils';
import { VolumeFader } from '@/widgets/TrackInspector/ui/VolumeFader';
import { PanFader } from '@/widgets/TrackInspector/ui/PanFader';
import { TriColorVU, VerticalMixerStrip } from '@/widgets/TrackInspector/ui/MixerWidgets';
import type { TrackData, TrackRowLayoutMetrics } from '@/widgets/TrackInspector/model/trackModels';

export const TrackRow = ({
    track, allTracks, trackHeight, displayNum, isSelected, isPrimarySelected = false, isCollapsed, depth,
    isRenaming, renameValue, onRenameChange, onRenameCommit, onRenameCancel,
    onClick, onToggleMute, onToggleSolo, onToggleArm, onToggleCollapse,
    onVolumeChange, onPanChange, onOutputChange, onInputChange, onContextMenu,
    onHeaderPointerDown,
    isGroupDropTarget = false,
    groupStripeColor,
    layout,
    isResizing = false,
    onResizeStart,
    isMasterFixed, mixerFocusMode = false,
    isActive = true,
}: {
    track: TrackData;
    allTracks: TrackData[];
    trackHeight: number;
    displayNum?: number;
    isSelected: boolean;
    isPrimarySelected?: boolean;
    isCollapsed: boolean;
    depth: number;
    isRenaming: boolean;
    renameValue: string;
    onRenameChange: (v: string) => void;
    onRenameCommit: () => void;
    onRenameCancel: () => void;
    onClick: (e: React.MouseEvent<HTMLDivElement>) => void;
    onToggleMute: () => void;
    onToggleSolo: () => void;
    onToggleArm: () => void;
    onToggleCollapse?: () => void;
    onVolumeChange?: (gain: number) => void;
    onPanChange?: (pan: number) => void;
    onOutputChange?: (targetId: string) => void;
    onInputChange?: (inputId: string) => void;
    onContextMenu?: (e: React.MouseEvent) => void;
    onHeaderPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
    isGroupDropTarget?: boolean;
    groupStripeColor?: string;
    layout: TrackRowLayoutMetrics;
    isResizing?: boolean;
    onResizeStart?: (startY: number) => void;
    isMasterFixed?: boolean;
    mixerFocusMode?: boolean;
    isActive?: boolean;
}) => {
    const isMaster = track.type === 'master';
    const isGroup = track.type === 'group';
    const isNestedGroup = isGroup && depth > 0;
    const groupRailColor = isNestedGroup
        ? (groupStripeColor || track.color)
        : isGroup
            ? track.color
            : (groupStripeColor || track.color);
    const renameInputRef = useRef<HTMLInputElement>(null);

    const availableRoutingTargets = allTracks.filter(t => t.id !== track.id && t.type !== 'master');
    const outputValue = track.output && (track.output === 'master' || availableRoutingTargets.some(t => t.id === track.output))
        ? track.output : 'master';
    const inputValue = track.input && (
        track.input === 'none' || track.input === 'ext-1' || track.input === 'ext-2' ||
        availableRoutingTargets.some(t => t.id === track.input)
    ) ? track.input : 'none';

    // Focus rename input
    useEffect(() => {
        if (isRenaming && renameInputRef.current) {
            renameInputRef.current.focus();
            renameInputRef.current.select();
        }
    }, [isRenaming]);

    const showRoutingExpanded = !isMasterFixed;
    const showRoutingCompact = false;

    // Track row dims when either explicitly muted or implicitly muted (due to solos)
    const isEnabled = isActive;
    // Meter dims on both mute AND solo (non-soloed tracks get grey meters)
    const anySoloed = allTracks.some(t => t.isSoloed);
    const isMeterActive = !track.isMuted && (!anySoloed || track.isSoloed || track.type === 'group' || track.type === 'master');
    const compactControlHeight = Math.max(16, Math.min(36, Math.round(trackHeight * 0.38)));
    const [resizeHot, setResizeHot] = useState(false);
    const headerBgColor = track.color;
    const headerContrast = getContrastColor(track.color);
    const headerTextColor = headerContrast === 'black' ? 'var(--glass-bg)' : 'color-mix(in srgb, var(--color-text-primary) 94%, transparent)';

    const indentW = !isMaster && depth > 0 ? Math.min(layout.maxIndentPx, depth * layout.indentStepPx) : 0;
    const stripeW = !isMaster && depth > 0 ? layout.groupStripeWidthPx : 0;

    return (
        <div
            data-track-row="true"
            data-track-id={track.id}
            onClick={onClick}
            onContextMenu={onContextMenu}
            style={{
                display: 'flex', alignItems: 'stretch', height: trackHeight,
                borderBottom: isMasterFixed ? 'none' : '1px solid var(--color-divider)',
                borderTop: 'none',
                background: isGroupDropTarget
                    ? 'color-mix(in srgb, var(--color-accent-primary) 20%, var(--surface-1))'
                    : isPrimarySelected
                        ? 'color-mix(in srgb, var(--color-accent-primary) 14%, var(--surface-1))'
                        : isSelected
                            ? 'color-mix(in srgb, var(--color-accent-primary) 8%, var(--surface-1))'
                            : 'var(--surface-1)',
                cursor: 'default',
                opacity: isEnabled ? 1 : 0.45,
                transition: `background var(--transition-linear), opacity var(--transition-linear)`,
                position: 'relative', flexShrink: 0, boxSizing: 'border-box', width: '100%',
                outline: isGroupDropTarget ? '2px solid color-mix(in srgb, var(--color-accent-primary) 82%, white)' : 'none',
                outlineOffset: isGroupDropTarget ? '-2px' : 0,
                boxShadow: isGroupDropTarget
                    ? 'inset 0 0 0 1px color-mix(in srgb, var(--color-accent-primary) 45%, transparent), 0 0 10px color-mix(in srgb, var(--color-accent-primary) 32%, transparent)'
                    : 'none',
            }}
        >
            {/* ════ BLOCK 1: Track Header (colored) ════ */}
            <div
                onPointerDown={onHeaderPointerDown}
                style={{
                    width: layout.headerColWidth,
                    minWidth: layout.headerColWidth,
                    maxWidth: layout.headerColWidth,
                    display: 'flex',
                    alignItems: 'stretch',
                    borderRight: isMasterFixed ? 'none' : '1px solid var(--color-border-subtle)',
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
                            background: `color-mix(in srgb, ${groupRailColor} 70%, #000)`,
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
                        padding: `2px ${mixerFocusMode ? 8 : 6}px 2px ${(mixerFocusMode ? 5 : 4) + indentW}px`,
                        background: headerBgColor,
                        gap: 1,
                        position: 'relative',
                        boxSizing: 'border-box',
                        minWidth: 0,
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        {/* Collapse / Group icon */}
                        {isGroup && onToggleCollapse ? (
                            <button
                                onClick={e => { e.stopPropagation(); onToggleCollapse(); }}
                                style={{
                                    width: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    background: 'none', border: 'none', color: headerTextColor,
                                    fontSize: 'var(--font-size-micro)', cursor: 'pointer', flexShrink: 0, padding: 0,
                                }}
                            >
                                {isCollapsed ? '▶' : '▼'}
                            </button>
                        ) : null}

                        {/* Track Name */}
                        {isRenaming ? (
                            <input
                                ref={renameInputRef}
                                value={renameValue}
                                onChange={e => onRenameChange(e.target.value)}
                                onKeyDown={e => {
                                    e.stopPropagation();
                                    if (e.key === 'Enter') onRenameCommit();
                                    if (e.key === 'Escape') onRenameCancel();
                                }}
                                onBlur={onRenameCommit}
                                onClick={e => e.stopPropagation()}
                                style={{
                                    fontSize: 'var(--font-size-xs)', fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                                    background: headerContrast === 'black'
                                        ? 'rgba(255, 255, 255, 0.42)'
                                        : 'rgba(0, 0, 0, 0.34)',
                                    border: `1px solid ${track.color}`,
                                    borderRadius: 'var(--radius-xs)', color: headerTextColor,
                                    padding: '1px 3px', outline: 'none', minWidth: 0,
                                }}
                            />
                        ) : (
                            <span style={{
                                flex: 1, fontSize: 'var(--font-size-base)',
                                fontWeight: isGroup || isMasterFixed ? 700 : 600,
                                color: headerTextColor,
                                whiteSpace: 'nowrap', overflow: 'hidden',
                                textOverflow: 'ellipsis', minWidth: 0,
                            }}>
                                {track.name}
                            </span>
                        )}
                    </div>

                    {/* ── Type Icon (absolute top-right) ── */}
                    {!isMasterFixed && !isGroup && (
                        <span style={{
                            position: 'absolute',
                            top: 3,
                            right: 4,
                            display: 'inline-flex',
                            alignItems: 'center',
                            opacity: 0.55,
                        }}>
                            {track.type === 'midi' ? (
                                <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                                    <rect x="0" y="1" width="3" height="10" rx="0.5" fill={headerTextColor} />
                                    <rect x="4.5" y="1" width="3" height="10" rx="0.5" fill={headerTextColor} />
                                    <rect x="9" y="1" width="3" height="10" rx="0.5" fill={headerTextColor} />
                                    <rect x="2" y="1" width="2" height="6" rx="0.3" fill={headerContrast === 'black' ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)'} />
                                    <rect x="6.5" y="1" width="2" height="6" rx="0.3" fill={headerContrast === 'black' ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)'} />
                                </svg>
                            ) : (
                                <svg width="9" height="9" viewBox="0 0 14 10" fill="none">
                                    <path d="M1 5 L2.5 2 L4 7 L5.5 1 L7 9 L8.5 3 L10 6 L11.5 4 L13 5" stroke={headerTextColor} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                            )}
                        </span>
                    )}
                </div>
            </div>

            {/* ════ BLOCK 2: Routing (gray) ════ */}
            {showRoutingExpanded && (
                <div style={{
                    display: 'flex', flexDirection: 'column', justifyContent: 'center',
                    gap: 4, padding: 4,
                    borderRight: '1px solid var(--color-border-subtle)',
                    width: layout.routingColWidth,
                    minWidth: layout.routingColWidth,
                    maxWidth: layout.routingColWidth,
                    boxSizing: 'border-box',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <div style={{ position: 'relative', display: 'flex', flex: 1, minWidth: 0 }}>
                            <span style={{
                                position: 'absolute',
                                left: 6,
                                top: '50%',
                                transform: 'translateY(-50%)',
                                fontSize: 'var(--font-size-micro)',
                                color: 'var(--color-text-tertiary)',
                                pointerEvents: 'none',
                                zIndex: 'var(--z-local)' as unknown as number,
                            }}>←</span>
                            <select
                                onClick={e => e.stopPropagation()}
                                value={inputValue}
                                onChange={(e) => {
                                    e.stopPropagation();
                                    onInputChange?.(e.target.value);
                                }}
                                title="Audio From"
                                style={{
                                    fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--font-weight-medium)' as unknown as number,
                                    color: 'var(--color-text-primary)',
                                    background: 'var(--color-control-bg)',
                                    border: '1px solid var(--color-control-border)',
                                    borderRadius: 'var(--radius-md)', padding: '0 16px 0 14px', cursor: 'pointer',
                                    minWidth: 0, flexShrink: 1, flex: 1,
                                    appearance: 'auto' as React.CSSProperties['appearance'],
                                    lineHeight: '15px', height: 15,
                                }}
                            >
                                <option value="none">No Input</option>
                                <option value="ext-1">Ext. In 1</option>
                                <option value="ext-2">Ext. In 2</option>
                                {availableRoutingTargets.map(t => (
                                    <option key={t.id} value={t.id}>{t.name}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <div style={{ position: 'relative', display: 'flex', flex: 1, minWidth: 0 }}>
                            <span style={{
                                position: 'absolute',
                                left: 6,
                                top: '50%',
                                transform: 'translateY(-50%)',
                                fontSize: 'var(--font-size-micro)',
                                color: 'var(--color-text-tertiary)',
                                pointerEvents: 'none',
                                zIndex: 'var(--z-local)' as unknown as number,
                            }}>→</span>
                            <select
                                onClick={e => e.stopPropagation()}
                                value={outputValue}
                                onChange={(e) => {
                                    e.stopPropagation();
                                    onOutputChange?.(e.target.value);
                                }}
                                title="Audio To"
                                style={{
                                    fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--font-weight-medium)' as unknown as number,
                                    color: 'var(--color-text-primary)',
                                    background: 'var(--color-control-bg)',
                                    border: '1px solid var(--color-control-border)',
                                    borderRadius: 'var(--radius-md)', padding: '0 16px 0 14px', cursor: 'pointer',
                                    minWidth: 0, flexShrink: 1, flex: 1,
                                    appearance: 'auto' as React.CSSProperties['appearance'],
                                    lineHeight: '15px', height: 15,
                                }}
                            >
                                <option value="master">Master</option>
                                {availableRoutingTargets.map(t => (
                                    <option key={t.id} value={t.id}>{t.name}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                </div>
            )}

            {/* Master I/O labels — static, non-clickable */}
            {isMasterFixed && (
                <div style={{
                    display: 'flex', flexDirection: 'column', justifyContent: 'center',
                    gap: 4, padding: 4,
                    borderRight: '1px solid var(--color-border-subtle)',
                    width: layout.routingColWidth,
                    minWidth: layout.routingColWidth,
                    maxWidth: layout.routingColWidth,
                    boxSizing: 'border-box',
                }}>
                    <div style={{
                        display: 'flex', alignItems: 'center',
                        fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--font-weight-medium)' as unknown as number,
                        color: 'var(--color-text-tertiary)',
                        background: 'var(--color-control-bg)',
                        border: '1px solid var(--color-control-border)',
                        borderRadius: 'var(--radius-md)',
                        padding: '0 8px 0 6px',
                        lineHeight: '15px', height: 15,
                        cursor: 'default', userSelect: 'none',
                    }}>
                        <span style={{ marginRight: 4, fontSize: 'var(--font-size-micro)' }}>←</span>
                        No Input
                    </div>
                    <div style={{
                        display: 'flex', alignItems: 'center',
                        fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--font-weight-medium)' as unknown as number,
                        color: 'var(--color-text-secondary)',
                        background: 'var(--color-control-bg)',
                        border: '1px solid var(--color-control-border)',
                        borderRadius: 'var(--radius-md)',
                        padding: '0 8px 0 6px',
                        lineHeight: '15px', height: 15,
                        cursor: 'default', userSelect: 'none',
                    }}>
                        <span style={{ marginRight: 4, fontSize: 'var(--font-size-micro)' }}>→</span>
                        Out 1-2
                    </div>
                </div>
            )}

            {showRoutingCompact && (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: 64,
                    maxWidth: 76,
                    borderRight: '1px solid color-mix(in srgb, var(--surface-elevated) 72%, #000)',
                    color: 'var(--text-muted)',
                    fontSize: 'var(--font-size-2xs)',
                    fontFamily: 'var(--font-mono)',
                }}>
                    {outputValue === 'master' ? '→M' : '→T'} · {inputValue === 'none' ? '←∅' : '←IN'}
                </div>
            )}

            {/* ════ BLOCK 3: Mixer (gray background) ════ */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: `${layout.muteSoloColWidth}px ${layout.faderColWidth}px ${layout.armColWidth}px ${layout.meterColWidth}px`,
                alignItems: 'center',
                columnGap: layout.mixerColumnGapPx,
                padding: `${layout.mixerPaddingY}px ${layout.mixerPaddingX}px`,
                width: layout.mixerSectionWidthPx,
                minWidth: layout.mixerSectionWidthPx,
                maxWidth: layout.mixerSectionWidthPx,
                flex: '0 0 auto',
                overflow: 'hidden',
                background: 'color-mix(in srgb, var(--surface-2) 55%, transparent)',
                boxSizing: 'border-box',
            }}>
                {/* Column 1: Enable + Solo */}
                {!isMaster ? (
                    <div style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                        width: layout.muteSoloColWidth,
                        minWidth: layout.muteSoloColWidth,
                    }}>
                        <button
                            onClick={e => { e.stopPropagation(); onToggleMute(); }}
                            title={isEnabled ? 'Disable track' : 'Enable track'}
                            style={{
                                width: layout.muteSoloColWidth,
                                height: compactControlHeight,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: isEnabled ? 'var(--color-status-success)' : 'var(--surface-elevated)',
                                color: isEnabled ? 'var(--color-text-on-color)' : 'var(--text-muted)',
                                border: 'none',
                                borderRadius: 'var(--radius-xs)',
                                fontSize: 'var(--font-size-micro)',
                                fontWeight: 'var(--font-weight-bold)' as unknown as number,
                                fontFamily: 'var(--font-mono)',
                                cursor: 'pointer',
                                padding: 0,
                                transition: `background var(--transition-micro)`,
                            }}
                        >{displayNum ?? '●'}</button>
                        <button
                            onClick={e => { e.stopPropagation(); onToggleSolo(); }}
                            title="Solo"
                            style={{
                                width: layout.muteSoloColWidth,
                                height: compactControlHeight,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: track.isSoloed
                                    ? 'var(--color-accent-primary)'
                                    : 'color-mix(in srgb, var(--color-accent-primary) 8%, var(--surface-elevated))',
                                color: track.isSoloed ? 'var(--color-text-on-accent)' : 'var(--color-text-secondary)',
                                border: track.isSoloed
                                    ? 'none'
                                    : '1px solid color-mix(in srgb, var(--text-primary) 18%, transparent)',
                                borderRadius: 'var(--radius-xs)',
                                fontSize: 'var(--font-size-micro)',
                                fontWeight: 'var(--font-weight-bold)' as unknown as number,
                                cursor: 'pointer',
                                padding: 0,
                                transition: 'background 0.1s ease',
                            }}
                            onMouseEnter={(e) => {
                                if (track.isSoloed) return;
                                e.currentTarget.style.background = 'color-mix(in srgb, var(--color-accent-primary) 12%, var(--surface-elevated))';
                            }}
                            onMouseLeave={(e) => {
                                if (track.isSoloed) return;
                                e.currentTarget.style.background = 'color-mix(in srgb, var(--color-accent-primary) 8%, var(--surface-elevated))';
                            }}
                        >S</button>
                    </div>
                ) : (
                    <div
                        aria-hidden
                        style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 4,
                            width: layout.muteSoloColWidth,
                            minWidth: layout.muteSoloColWidth,
                        }}
                    >
                        <div style={{ width: layout.muteSoloColWidth, height: compactControlHeight }} />
                        <div style={{ width: layout.muteSoloColWidth, height: compactControlHeight }} />
                    </div>
                )}

                {/* Column 2: Faders */}
                {!isGroup && !isMaster && mixerFocusMode && onVolumeChange && onPanChange ? (
                    <VerticalMixerStrip
                        volumeLinear={track.volume}
                        pan={track.pan}
                        peakDb={track.vuLevel}
                        peakDbL={track.vuLevelL}
                        peakDbR={track.vuLevelR}
                        isMidi={false}
                        onVolumeChange={onVolumeChange}
                        onPanChange={onPanChange}
                    />
                ) : (
                    <div style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                        width: layout.faderColWidth,
                        minWidth: layout.faderColWidth,
                        maxWidth: layout.faderColWidth,
                        minHeight: compactControlHeight * 2 + 4,
                        justifyContent: 'center',
                    }}>
                        {onVolumeChange && (
                            <VolumeFader
                                volumeLinear={track.volume}
                                onVolumeChange={onVolumeChange}
                                compact
                                showZeroTick
                                controlHeight={compactControlHeight}
                            />
                        )}
                        {!isMaster && onPanChange && (
                            <PanFader
                                pan={track.pan}
                                onPanChange={onPanChange}
                                compact
                                controlHeight={compactControlHeight}
                            />
                        )}
                    </div>
                )}

                {/* Column 3: Arm + spacer (keeps grid stable) */}
                {!isMaster && !isGroup ? (
                    <div style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                        width: layout.armColWidth,
                        minWidth: layout.armColWidth,
                    }}>
                        <button
                            onClick={(e) => { e.stopPropagation(); onToggleArm(); }}
                            title="Arm for recording"
                            style={{
                                width: layout.armColWidth,
                                height: layout.armColWidth,
                                borderRadius: 'var(--radius-xs)',
                                border: '1px solid color-mix(in srgb, var(--text-primary) 12%, transparent)',
                                background: track.isArmed
                                    ? 'color-mix(in srgb, var(--color-status-record) 55%, transparent)'
                                    : 'var(--surface-elevated)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                padding: 0,
                                cursor: 'pointer',
                            }}
                        >
                            <span style={{
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                background: track.isArmed ? 'var(--color-status-record)' : 'color-mix(in srgb, var(--color-control-tint) 38%, transparent)',
                                boxShadow: track.isArmed ? '0 0 6px color-mix(in srgb, var(--color-status-record) 80%, transparent)' : 'none',
                            }} />
                        </button>
                        <div
                            aria-hidden
                            style={{
                                width: layout.armColWidth,
                                height: layout.armColWidth,
                                borderRadius: 'var(--radius-xs)',
                                border: '1px solid color-mix(in srgb, var(--text-primary) 10%, transparent)',
                                background: 'var(--surface-elevated)',
                            }}
                        />
                    </div>
                ) : (
                    <div
                        aria-hidden
                        style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 4,
                            width: layout.armColWidth,
                            minWidth: layout.armColWidth,
                        }}
                    >
                        <div
                            style={{
                                width: layout.armColWidth,
                                height: layout.armColWidth,
                                borderRadius: 'var(--radius-xs)',
                                border: '1px solid color-mix(in srgb, var(--text-primary) 7%, transparent)',
                                background: 'color-mix(in srgb, var(--surface-elevated) 85%, transparent)',
                                opacity: 0.45,
                            }}
                        />
                        <div
                            style={{
                                width: layout.armColWidth,
                                height: layout.armColWidth,
                                borderRadius: 'var(--radius-xs)',
                                border: '1px solid color-mix(in srgb, var(--text-primary) 7%, transparent)',
                                background: 'color-mix(in srgb, var(--surface-elevated) 85%, transparent)',
                                opacity: 0.45,
                            }}
                        />
                    </div>
                )}

                {/* Column 4: VU */}
                <TriColorVU
                    peakDb={track.vuLevel}
                    peakDbL={track.vuLevelL}
                    peakDbR={track.vuLevelR}
                    isMidi={false}
                    compact
                    isEnabled={isMaster ? true : isMeterActive}
                    trackHeight={trackHeight}
                />
            </div>

            {isGroupDropTarget && isGroup && (
                <div style={{
                    position: 'absolute',
                    inset: 0,
                    pointerEvents: 'none',
                    zIndex: 'var(--z-local-raised)' as unknown as number,
                    boxShadow: 'inset 0 0 0 2px color-mix(in srgb, var(--color-text-bright) 78%, transparent), inset 0 0 16px color-mix(in srgb, var(--color-text-bright) 22%, transparent)',
                }} />
            )}

            <div
                role="presentation"
                onPointerEnter={() => setResizeHot(true)}
                onPointerLeave={() => setResizeHot(false)}
                onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onResizeStart?.(e.clientY);
                }}
                style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: -3,
                    height: 7,
                    cursor: 'ns-resize',
                    zIndex: 'var(--z-local)' as unknown as number,
                }}
            />
            {(resizeHot || isResizing) && (
                <div
                    aria-hidden
                    style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        bottom: 0,
                        height: 1,
                        background: 'color-mix(in srgb, var(--color-accent-primary) 76%, white)',
                        boxShadow: '0 0 6px color-mix(in srgb, var(--color-accent-primary) 35%, transparent)',
                        pointerEvents: 'none',
                        zIndex: 'var(--z-local)' as unknown as number,
                    }}
                />
            )}
        </div>
    );
};
