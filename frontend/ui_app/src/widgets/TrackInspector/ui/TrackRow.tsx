import React, { memo, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { getTrackHeightLevel } from '@/shared/config/trackHeightLevels';
import { TrackRowHeader } from '@/widgets/TrackInspector/ui/TrackRowHeader';
import { TrackRowMixer } from '@/widgets/TrackInspector/ui/TrackRowMixer';
import { TrackRowResizeHandle } from '@/widgets/TrackInspector/ui/TrackRowResizeHandle';
import { TrackRowRouting } from '@/widgets/TrackInspector/ui/TrackRowRouting';
import type { TrackData, TrackRowLayoutMetrics } from '@/widgets/TrackInspector/model/trackModels';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import { TrackAutomationLaneHeader } from './TrackAutomationLaneHeader';

interface TrackRowProps {
    trackId: string;
    trackSnapshot: TrackData;
    routingTargets: Array<{ id: string; name: string }>;
    anySoloed: boolean;
    trackHeight: number;
    baseHeight?: number;
    displayNum?: number;
    isSelected: boolean;
    isHeaderSelected?: boolean;
    isCollapsed: boolean;
    depth: number;
    isRenaming: boolean;
    renameValue: string;
    onRenameChange: (v: string) => void;
    onRenameCommit: () => void;
    onRenameCancel: () => void;
    onClick: (e: React.MouseEvent<HTMLDivElement>) => void;
    onToggleDisabled: () => void;
    onToggleSolo: () => void;
    onToggleArm: () => void;
    onToggleCollapse?: () => void;
    onVolumeChange?: (gain: number) => void;
    onPanChange?: (pan: number) => void;
    onOutputChange?: (targetId: string) => void;
    onInputChange?: (inputId: string) => void;
    onVolumeContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
    onPanContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
    onContextMenu?: (e: React.MouseEvent) => void;
    onHeaderPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
    onHeaderClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
    onParamSelectorClick?: (x: number, y: number, laneId: string) => void;
    isGroupDropTarget?: boolean;
    groupAncestorColors?: string[];
    layout: TrackRowLayoutMetrics;
    isResizing?: boolean;
    onResizeStart?: (startY: number) => void;
    isMasterFixed?: boolean;
    mixerFocusMode?: boolean;
    isActive?: boolean;
}

export const TrackRow = memo(({
    trackId,
    trackSnapshot,
    routingTargets,
    anySoloed,
    trackHeight,
    baseHeight,
    displayNum,
    isSelected,
    isHeaderSelected = false,
    isCollapsed,
    depth,
    isRenaming,
    renameValue,
    onRenameChange,
    onRenameCommit,
    onRenameCancel,
    onClick,
    onToggleDisabled,
    onToggleSolo,
    onToggleArm,
    onToggleCollapse,
    onVolumeChange,
    onPanChange,
    onOutputChange,
    onInputChange,
    onVolumeContextMenu,
    onPanContextMenu,
    onContextMenu,
    onHeaderPointerDown,
    onHeaderClick,
    onParamSelectorClick,
    isGroupDropTarget = false,
    groupAncestorColors,
    layout,
    isResizing = false,
    onResizeStart,
    isMasterFixed,
    mixerFocusMode = false,
    isActive = true,
}: TrackRowProps) => {
    const selectedTrack = useEngineStore(useShallow((s) => {
        const track = s.tracks.byId[trackId];
        if (!track) {
            return null;
        }
        const typeRaw = (track.track_type ?? '').toLowerCase();
        const type: TrackData['type'] =
            typeRaw === 'master' ? 'master'
                : typeRaw === 'group' ? 'group'
                    : typeRaw === 'midi' ? 'midi'
                        : 'audio';
        return {
            id: track.id,
            name: track.name,
            color: track.color,
            type,
            volume: track.volume,
            pan: track.pan,
            isDisabled: track.is_disabled,
            isSoloed: track.is_solo,
            isArmed: track.is_armed,
            input: track.input || 'none',
            output: track.output || 'master',
            groupId: track.parent_track_id ?? undefined,
            height: Number.isFinite(track.height) ? track.height : trackSnapshot.height,
        };
    }));

    const track: TrackData = selectedTrack
        ? {
            ...trackSnapshot,
            ...selectedTrack,
            // VU values are realtime-derived view data, keep snapshot values.
            vuLevel: trackSnapshot.vuLevel,
            vuLevelL: trackSnapshot.vuLevelL,
            vuLevelR: trackSnapshot.vuLevelR,
            sends: trackSnapshot.sends,
            routing: trackSnapshot.routing,
        }
        : trackSnapshot;

    const isMaster = track.type === 'master';
    const isGroup = track.type === 'group';
    const isNestedGroup = isGroup && depth > 0;
    const groupRailColor = isNestedGroup
        ? (groupAncestorColors?.[groupAncestorColors.length - 1] || track.color)
        : isGroup
            ? track.color
            : (groupAncestorColors?.[groupAncestorColors.length - 1] || track.color);

    const heightLevel = getTrackHeightLevel(trackHeight);

    // ENTERPRISE: Automation lane integration
    const automationVisible = useAutomationStore((s) => s.globalVisible);
    const allLanes = useAutomationStore((s) => s.lanes);
    const lanes = useMemo(
        () => Object.values(allLanes).filter(l => l.trackId === track.id && l.visible),
        [allLanes, track.id],
    );
    const hasAutomation = automationVisible && lanes.length > 0;
    const bodyHeight = baseHeight ?? trackHeight;

    return (
        <div
            data-track-row="true"
            data-track-id={track.id}
            onClick={onClick}
            onContextMenu={onContextMenu}
            style={{
                display: 'flex',
                flexDirection: 'column',
                height: trackHeight,
                // ENTERPRISE FIX: Use a dark semi-transparent border that's visible against
                // any track color (yellow, red, green, etc.). The previous --color-divider
                // was too subtle and invisible against colored group backgrounds.
                borderBottom: isMasterFixed ? 'none' : 'var(--space-px) solid rgba(0, 0, 0, 0.35)',
                borderTop: 'none',
                background: isGroupDropTarget
                    ? 'color-mix(in srgb, var(--color-accent-primary) 20%, var(--surface-1))'
                    : isHeaderSelected
                        ? 'color-mix(in srgb, var(--color-text-primary) 10%, var(--surface-1))'
                        : isSelected
                            ? 'color-mix(in srgb, var(--color-text-primary) 8%, var(--surface-1))'
                            : 'var(--surface-1)',
                cursor: 'default',
                transition: `background var(--transition-linear)`,
                position: 'relative',
                flexShrink: 0,
                boxSizing: 'border-box',
                // ENTERPRISE FIX: Clip inner content so colored track backgrounds
                // don't overflow and cover the borderBottom divider line.
                overflow: 'hidden',
                width: '100%',
                outline: isGroupDropTarget ? 'var(--space-0-5) solid color-mix(in srgb, var(--color-accent-primary) 82%, white)' : 'none',
                outlineOffset: isGroupDropTarget ? 'calc(-1 * var(--token-size-px-2))' : 0,
                boxShadow: isGroupDropTarget
                    ? 'inset 0 0 0 var(--space-px) color-mix(in srgb, var(--color-accent-primary) 45%, transparent), 0 0 var(--space-2-5) color-mix(in srgb, var(--color-accent-primary) 32%, transparent)'
                    : 'none',
                zIndex: isHeaderSelected || isSelected ? 'var(--z-local-raised)' : 'auto',
            }}
        >
            <div
                style={{
                    display: 'flex',
                    alignItems: 'stretch',
                    height: bodyHeight, // Prevents body from stretching to full height
                    boxSizing: 'border-box',
                    width: '100%',
                }}
            >
                <TrackRowHeader
                    track={track}
                    trackHeight={trackHeight}
                    heightLevel={heightLevel}
                    isMaster={isMaster}
                    isGroup={isGroup}
                    isHeaderSelected={isHeaderSelected}
                    isCollapsed={isCollapsed}
                    isRenaming={isRenaming}
                    renameValue={renameValue}
                    depth={depth}
                    groupRailColor={groupRailColor}
                    groupAncestorColors={groupAncestorColors ?? []}
                    layout={layout}
                    mixerFocusMode={mixerFocusMode}
                    isActive={isActive}
                    onRenameChange={onRenameChange}
                    onRenameCommit={onRenameCommit}
                    onRenameCancel={onRenameCancel}
                    onToggleCollapse={onToggleCollapse}
                    onHeaderPointerDown={onHeaderPointerDown}
                    onHeaderClick={onHeaderClick}
                />

                <TrackRowRouting
                    track={track}
                    routingTargets={routingTargets}
                    isMasterFixed={isMasterFixed}
                    layout={layout}
                    heightLevel={heightLevel}
                    onOutputChange={onOutputChange}
                    onInputChange={onInputChange}
                    automationVisible={automationVisible}
                    automationLanes={lanes}
                    onAutomationParamClick={onParamSelectorClick}
                />

                <TrackRowMixer
                    track={track}
                    trackHeight={trackHeight}
                    heightLevel={heightLevel}
                    displayNum={displayNum}
                    anySoloed={anySoloed}
                    isMaster={isMaster}
                    isGroup={isGroup}
                    isActive={isActive}
                    mixerFocusMode={mixerFocusMode}
                    layout={layout}
                    onToggleDisabled={onToggleDisabled}
                    onToggleSolo={onToggleSolo}
                    onToggleArm={onToggleArm}
                    onVolumeChange={onVolumeChange}
                    onPanChange={onPanChange}
                    onVolumeContextMenu={onVolumeContextMenu}
                    onPanContextMenu={onPanContextMenu}
                />

                {isGroupDropTarget && isGroup && (
                    <div
                        style={{
                            position: 'absolute',
                            inset: 0,
                            pointerEvents: 'none',
                            zIndex: 'var(--z-local-raised)',
                            boxShadow:
                                'inset 0 0 0 var(--space-0-5) color-mix(in srgb, var(--color-text-bright) 78%, transparent), inset 0 0 var(--space-4) color-mix(in srgb, var(--color-text-bright) 22%, transparent)',
                        }}
                    />
                )}

                <TrackRowResizeHandle isResizing={isResizing} onResizeStart={onResizeStart} />
            </div>

            {hasAutomation && (
                <div style={{ display: 'flex', flexDirection: 'column', width: layout.headerColWidth }}>
                    {lanes.slice(1).map((lane) => (
                        <TrackAutomationLaneHeader
                            key={lane.id}
                            lane={lane}
                            trackColor={track.color}
                            isFirstLane={false}
                            onParamContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                const rect = e.currentTarget.getBoundingClientRect();
                                onParamSelectorClick?.(rect.left, rect.bottom + 4, lane.id);
                            }}
                        />
                    ))}
                </div>
            )}
        </div>
    );
});
