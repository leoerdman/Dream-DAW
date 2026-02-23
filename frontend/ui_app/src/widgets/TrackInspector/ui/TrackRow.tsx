import type React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { TrackRowHeader } from '@/widgets/TrackInspector/ui/TrackRowHeader';
import { TrackRowMixer } from '@/widgets/TrackInspector/ui/TrackRowMixer';
import { TrackRowResizeHandle } from '@/widgets/TrackInspector/ui/TrackRowResizeHandle';
import { TrackRowRouting } from '@/widgets/TrackInspector/ui/TrackRowRouting';
import type { TrackData, TrackRowLayoutMetrics } from '@/widgets/TrackInspector/model/trackModels';

interface TrackRowProps {
    trackId: string;
    trackSnapshot: TrackData;
    routingTargets: Array<{ id: string; name: string }>;
    anySoloed: boolean;
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
}

export const TrackRow = ({
    trackId,
    trackSnapshot,
    routingTargets,
    anySoloed,
    trackHeight,
    displayNum,
    isSelected,
    isPrimarySelected = false,
    isCollapsed,
    depth,
    isRenaming,
    renameValue,
    onRenameChange,
    onRenameCommit,
    onRenameCancel,
    onClick,
    onToggleMute,
    onToggleSolo,
    onToggleArm,
    onToggleCollapse,
    onVolumeChange,
    onPanChange,
    onOutputChange,
    onInputChange,
    onContextMenu,
    onHeaderPointerDown,
    isGroupDropTarget = false,
    groupStripeColor,
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
            isMuted: track.is_mute,
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
        ? (groupStripeColor || track.color)
        : isGroup
            ? track.color
            : (groupStripeColor || track.color);

    return (
        <div
            data-track-row="true"
            data-track-id={track.id}
            onClick={onClick}
            onContextMenu={onContextMenu}
            style={{
                display: 'flex',
                alignItems: 'stretch',
                height: trackHeight,
                borderBottom: isMasterFixed ? 'none' : 'var(--space-px) solid var(--color-divider)',
                borderTop: 'none',
                background: isGroupDropTarget
                    ? 'color-mix(in srgb, var(--color-accent-primary) 20%, var(--surface-1))'
                    : isPrimarySelected
                        ? 'color-mix(in srgb, var(--color-text-primary) 10%, var(--surface-1))'
                        : isSelected
                            ? 'color-mix(in srgb, var(--color-text-primary) 6%, var(--surface-1))'
                            : 'var(--surface-1)',
                cursor: 'default',
                opacity: isActive ? 1 : 0.45,
                transition: `background var(--transition-linear), opacity var(--transition-linear)`,
                position: 'relative',
                flexShrink: 0,
                boxSizing: 'border-box',
                width: '100%',
                outline: isGroupDropTarget ? 'var(--space-0-5) solid color-mix(in srgb, var(--color-accent-primary) 82%, white)' : 'none',
                outlineOffset: isGroupDropTarget ? '-var(--token-size-px-2)' : 0,
                boxShadow: isGroupDropTarget
                    ? 'inset 0 0 0 var(--space-px) color-mix(in srgb, var(--color-accent-primary) 45%, transparent), 0 0 var(--space-2-5) color-mix(in srgb, var(--color-accent-primary) 32%, transparent)'
                    : 'none',
            }}
        >
            <TrackRowHeader
                track={track}
                trackHeight={trackHeight}
                isMaster={isMaster}
                isGroup={isGroup}
                isCollapsed={isCollapsed}
                isRenaming={isRenaming}
                renameValue={renameValue}
                depth={depth}
                groupRailColor={groupRailColor}
                layout={layout}
                mixerFocusMode={mixerFocusMode}
                onRenameChange={onRenameChange}
                onRenameCommit={onRenameCommit}
                onRenameCancel={onRenameCancel}
                onToggleCollapse={onToggleCollapse}
                onHeaderPointerDown={onHeaderPointerDown}
            />

            <TrackRowRouting
                track={track}
                routingTargets={routingTargets}
                isMasterFixed={isMasterFixed}
                layout={layout}
                onOutputChange={onOutputChange}
                onInputChange={onInputChange}
            />

            <TrackRowMixer
                track={track}
                trackHeight={trackHeight}
                displayNum={displayNum}
                anySoloed={anySoloed}
                isMaster={isMaster}
                isGroup={isGroup}
                isActive={isActive}
                mixerFocusMode={mixerFocusMode}
                layout={layout}
                onToggleMute={onToggleMute}
                onToggleSolo={onToggleSolo}
                onToggleArm={onToggleArm}
                onVolumeChange={onVolumeChange}
                onPanChange={onPanChange}
            />

            {isGroupDropTarget && isGroup && (
                <div
                    style={{
                        position: 'absolute',
                        inset: 0,
                        pointerEvents: 'none',
                        zIndex: 'var(--z-local-raised)' as unknown as number,
                        boxShadow:
                            'inset 0 0 0 var(--space-0-5) color-mix(in srgb, var(--color-text-bright) 78%, transparent), inset 0 0 var(--space-4) color-mix(in srgb, var(--color-text-bright) 22%, transparent)',
                    }}
                />
            )}

            <TrackRowResizeHandle isResizing={isResizing} onResizeStart={onResizeStart} />
        </div>
    );
};
