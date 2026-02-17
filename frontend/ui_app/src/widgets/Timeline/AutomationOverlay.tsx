// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — AutomationOverlay
// ═══════════════════════════════════════════════════════════════════════════
//
// Renders automation lanes as SVG overlays on top of the canvas timeline.
// Each track that has automation lanes gets a sub-row (darker background)
// placed directly below the track row. The overlay syncs with the viewport
// store for scroll and zoom, and with the automation store for lane data.
//
// ═══════════════════════════════════════════════════════════════════════════

import { useMemo, memo } from 'react';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useViewportStore } from '@/shared/stores/useViewportStore';
import { AutomationLane } from './AutomationLane';

// ── Constants ────────────────────────────────────────────────────────────

/** Height of each automation lane sub-row in pixels. */
const LANE_HEIGHT = 48;

/** Ruler height must match Timeline.tsx constant. */
const RULER_HEIGHT = 28;

// ── Props ────────────────────────────────────────────────────────────────

interface AutomationOverlayProps {
    /** Whether the global automation toggle is on. */
    visible: boolean;
    /** Number of tracks in the arrangement. */
    trackCount: number;
    /** Height of each track row in pixels. */
    trackHeight: number;
    /** Current vertical scroll offset (from timeline). */
    scrollTop: number;
    /** Width of the overlay container. */
    width: number;
    /** BPM for viewport calculations. */
    bpm: number;
}

// ── Component ────────────────────────────────────────────────────────────

export const AutomationOverlay = memo(function AutomationOverlay({
    visible,
    trackCount,
    trackHeight,
    scrollTop,
    width,
    bpm,
}: AutomationOverlayProps) {
    const lanes = useAutomationStore((s) => s.lanes);
    const projectTracks = useEngineStore((s) => s.projectTracks);
    const sampleRate = useEngineStore((s) => s.transport.sample_rate) || 44100;
    const samplesPerPixel = useViewportStore((s) => s.samplesPerPixel);
    const viewportScrollX = useViewportStore((s) => s.scrollX);

    // Derive pixelsPerBeat and scrollOffsetBeats from viewport store
    const samplesPerBeat = (sampleRate * 60) / bpm;
    const pixelsPerBeat = samplesPerBeat / samplesPerPixel;
    const scrollOffsetBeats = (viewportScrollX * samplesPerPixel) / samplesPerBeat;

    // Build per-track lane groups
    const trackLanes = useMemo(() => {
        const allLanes = Object.values(lanes);
        const result: Array<{
            trackIndex: number;
            trackId: string;
            trackColor: string;
            lanes: typeof allLanes;
        }> = [];

        for (let i = 0; i < trackCount; i++) {
            const track = projectTracks[i];
            if (!track) continue;
            const trackId = track.id;
            const trackRgb = track.color;

            const trackAutoLanes = allLanes.filter(
                (l) => l.trackId === trackId && l.visible,
            );

            if (trackAutoLanes.length > 0) {
                result.push({
                    trackIndex: i,
                    trackId,
                    trackColor: trackRgb,
                    lanes: trackAutoLanes,
                });
            }
        }
        return result;
    }, [lanes, trackCount, projectTracks]);

    if (!visible || trackLanes.length === 0) return null;

    return (
        <div
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width,
                height: '100%',
                pointerEvents: 'none',
                overflow: 'hidden',
                zIndex: 'var(--z-local-raised)' as unknown as number,
            }}
        >
            {trackLanes.map(({ trackIndex, lanes: tLanes }) => {
                // Position the automation sub-rows starting BELOW the track row
                const trackBottom =
                    RULER_HEIGHT + (trackIndex + 1) * trackHeight - scrollTop;

                return tLanes.map((lane, laneIdx) => {
                    const laneTop = trackBottom + laneIdx * LANE_HEIGHT;

                    return (
                        <div
                            key={lane.id}
                            style={{
                                position: 'absolute',
                                top: laneTop,
                                left: 0,
                                width,
                                height: LANE_HEIGHT,
                                pointerEvents: 'all',
                                background:
                                    'color-mix(in srgb, var(--color-bg-panel) 85%, #000 15%)',
                                borderBottom:
                                    '1px solid var(--color-divider)',
                            }}
                        >
                            {/* Lane label */}
                            <span
                                style={{
                                    position: 'absolute',
                                    top: 2,
                                    left: 8,
                                    fontSize: 'var(--font-size-2xs)',
                                    fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                                    color: lane.color,
                                    opacity: 0.8,
                                    zIndex: 'var(--z-local-base)' as unknown as number,
                                    pointerEvents: 'none',
                                    textShadow: 'var(--text-shadow-dark)',
                                }}
                            >
                                {lane.paramName}
                            </span>

                            {/* SVG breakpoint editor */}
                            <AutomationLane
                                lane={lane}
                                width={width}
                                height={LANE_HEIGHT}
                                pixelsPerBeat={pixelsPerBeat}
                                scrollOffsetBeats={scrollOffsetBeats}
                            />
                        </div>
                    );
                });
            })}
        </div>
    );
});

export default AutomationOverlay;
