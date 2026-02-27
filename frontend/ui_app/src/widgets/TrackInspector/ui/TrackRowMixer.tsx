import { VolumeFader } from '@/widgets/TrackInspector/ui/VolumeFader';
import { PanFader } from '@/widgets/TrackInspector/ui/PanFader';
import { TriColorVU, VerticalMixerStrip } from '@/widgets/TrackInspector/ui/MixerWidgets';
import type { TrackData, TrackRowLayoutMetrics } from '@/widgets/TrackInspector/model/trackModels';

interface TrackRowMixerProps {
    track: TrackData;
    trackHeight: number;
    displayNum?: number;
    anySoloed: boolean;
    isMaster: boolean;
    isGroup: boolean;
    isActive: boolean;
    mixerFocusMode: boolean;
    layout: TrackRowLayoutMetrics;
    onToggleDisabled: () => void;
    onToggleSolo: () => void;
    onToggleArm: () => void;
    onVolumeChange?: (gain: number) => void;
    onPanChange?: (pan: number) => void;
    onVolumeContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
    onPanContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
}

export function TrackRowMixer({
    track,
    trackHeight,
    displayNum,
    anySoloed,
    isMaster,
    isGroup,
    isActive,
    mixerFocusMode,
    layout,
    onToggleDisabled,
    onToggleSolo,
    onToggleArm,
    onVolumeChange,
    onPanChange,
    onVolumeContextMenu,
    onPanContextMenu,
}: TrackRowMixerProps) {
    const isMeterActive = !track.isDisabled && (!anySoloed || track.isSoloed || track.type === 'group' || track.type === 'master');
    const compactControlHeight = Math.max(16, Math.min(36, Math.round(trackHeight * 0.38)));

    return (
        <div
            style={{
                display: 'grid',
                gridTemplateColumns: `${layout.muteSoloColWidth}px ${layout.faderColWidth}px ${layout.armColWidth}px ${layout.meterColWidth}px`,
                alignItems: 'center',
                columnGap: layout.mixerColumnGapPx,
                padding: `${layout.mixerPaddingY}px ${layout.mixerPaddingX}px`,
                minWidth: layout.mixerSectionWidthPx,
                flex: '1 1 auto',
                overflow: 'hidden',
                background: 'color-mix(in srgb, var(--surface-2) 55%, transparent)',
                boxSizing: 'border-box',
                borderRight: 'var(--space-px) solid var(--color-divider)',
            }}
        >
            {!isMaster ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: layout.muteSoloColWidth, minWidth: layout.muteSoloColWidth }}>
                    <button
                        onClick={(e) => { e.stopPropagation(); onToggleDisabled(); }}
                        title={isActive ? 'Disable track' : 'Enable track'}
                        style={{
                            width: layout.muteSoloColWidth,
                            height: compactControlHeight,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: isActive ? 'var(--color-status-success)' : 'var(--surface-elevated)',
                            color: isActive ? 'var(--color-text-on-accent)' : 'color-mix(in srgb, var(--text-muted) 60%, transparent)',
                            border: isActive ? 'none' : '1px solid color-mix(in srgb, var(--text-primary) 12%, transparent)',
                            borderRadius: 'var(--radius-xs)',
                            fontSize: 'var(--font-size-micro)',
                            fontWeight: 'var(--font-weight-bold)',
                            fontFamily: 'var(--font-role-data)',
                            cursor: 'pointer',
                            padding: 0,
                            transition: `background var(--transition-micro)`,
                        }}
                    >
                        {displayNum ?? '●'}
                    </button>
                    <button
                        onClick={(e) => { e.stopPropagation(); onToggleSolo(); }}
                        title="Solo"
                        style={{
                            width: layout.muteSoloColWidth,
                            height: compactControlHeight,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: track.isSoloed
                                ? 'var(--color-status-solo)'
                                : 'color-mix(in srgb, var(--color-status-solo) 8%, var(--surface-elevated))',
                            color: track.isSoloed ? 'var(--color-text-on-color)' : 'var(--color-text-secondary)',
                            border: track.isSoloed ? 'none' : '1px solid color-mix(in srgb, var(--text-primary) 12%, transparent)',
                            borderRadius: 'var(--radius-xs)',
                            fontSize: 'var(--font-size-micro)',
                            fontWeight: 'var(--font-weight-bold)',
                            cursor: 'pointer',
                            padding: 0,
                            transition: 'background 0.1s ease',
                        }}
                        onMouseEnter={(e) => {
                            if (track.isSoloed) return;
                            e.currentTarget.style.background = 'color-mix(in srgb, var(--color-status-solo) 12%, var(--surface-elevated))';
                        }}
                        onMouseLeave={(e) => {
                            if (track.isSoloed) return;
                            e.currentTarget.style.background = 'color-mix(in srgb, var(--color-status-solo) 8%, var(--surface-elevated))';
                        }}
                    >
                        S
                    </button>
                </div>
            ) : (
                <div aria-hidden style={{ display: 'flex', flexDirection: 'column', gap: 4, width: layout.muteSoloColWidth, minWidth: layout.muteSoloColWidth }}>
                    <div style={{ width: layout.muteSoloColWidth, height: compactControlHeight }} />
                    <div style={{ width: layout.muteSoloColWidth, height: compactControlHeight }} />
                </div>
            )}

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
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: layout.faderColWidth, minWidth: layout.faderColWidth, maxWidth: layout.faderColWidth, minHeight: compactControlHeight * 2 + 4, justifyContent: 'center' }}>
                    {onVolumeChange && (
                        <VolumeFader volumeLinear={track.volume} onVolumeChange={onVolumeChange} onContextMenu={onVolumeContextMenu} compact showZeroTick controlHeight={compactControlHeight} />
                    )}
                    {!isMaster && onPanChange && (
                        <PanFader pan={track.pan} onPanChange={onPanChange} onContextMenu={onPanContextMenu} compact controlHeight={compactControlHeight} />
                    )}
                </div>
            )}

            {!isMaster && !isGroup ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: layout.armColWidth, minWidth: layout.armColWidth }}>
                    <button
                        onClick={(e) => { e.stopPropagation(); onToggleArm(); }}
                        title="Arm for recording"
                        style={{
                            width: layout.armColWidth,
                            height: layout.armColWidth,
                            borderRadius: 'var(--radius-xs)',
                            border: 'var(--space-px) solid color-mix(in srgb, var(--text-primary) 12%, transparent)',
                            background: track.isArmed ? 'color-mix(in srgb, var(--color-status-record) 55%, transparent)' : 'var(--surface-elevated)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: 0,
                            cursor: 'pointer',
                        }}
                    >
                        <span
                            style={{
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                background: track.isArmed
                                    ? 'var(--color-status-record)'
                                    : 'color-mix(in srgb, var(--color-control-tint) 38%, transparent)',
                                boxShadow: track.isArmed
                                    ? '0 0 var(--space-1-5) color-mix(in srgb, var(--color-status-record) 80%, transparent)'
                                    : 'none',
                            }}
                        />
                    </button>
                    <div aria-hidden style={{ width: layout.armColWidth, height: layout.armColWidth, borderRadius: 'var(--radius-xs)', border: 'var(--space-px) solid color-mix(in srgb, var(--text-primary) 10%, transparent)', background: 'var(--surface-elevated)' }} />
                </div>
            ) : (
                <div aria-hidden style={{ display: 'flex', flexDirection: 'column', gap: 4, width: layout.armColWidth, minWidth: layout.armColWidth }}>
                    <div style={{ width: layout.armColWidth, height: layout.armColWidth, borderRadius: 'var(--radius-xs)', border: 'var(--space-px) solid color-mix(in srgb, var(--text-primary) 7%, transparent)', background: 'color-mix(in srgb, var(--surface-elevated) 85%, transparent)', opacity: 0.45 }} />
                    <div style={{ width: layout.armColWidth, height: layout.armColWidth, borderRadius: 'var(--radius-xs)', border: 'var(--space-px) solid color-mix(in srgb, var(--text-primary) 7%, transparent)', background: 'color-mix(in srgb, var(--surface-elevated) 85%, transparent)', opacity: 0.45 }} />
                </div>
            )}

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
    );
}
