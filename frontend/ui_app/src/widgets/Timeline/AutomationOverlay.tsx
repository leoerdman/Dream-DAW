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

import { useMemo, memo, useEffect, useRef } from 'react';
import { resolveSampleRate } from '@/shared/lib/audioMath';
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
    /** Optional per-track heights from timeline viewport SSOT. */
    trackHeights?: number[];
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
    trackHeights,
    scrollTop,
    width,
    bpm,
}: AutomationOverlayProps) {
    const lanes = useAutomationStore((s) => s.lanes);
    const tracksById = useEngineStore((s) => s.tracks.byId);
    const trackIds = useEngineStore((s) => s.tracks.allIds);
    const sampleRate = resolveSampleRate(useEngineStore((s) => s.transport.sample_rate));
    const samplesPerPixel = useViewportStore((s) => s.samplesPerPixel);
    const viewportScrollX = useViewportStore((s) => s.scrollX);

    // Derive pixelsPerBeat and scrollOffsetBeats from viewport store
    const samplesPerBeat = (sampleRate * 60) / bpm;
    const pixelsPerBeat = samplesPerBeat / samplesPerPixel;
    const scrollOffsetBeats = (viewportScrollX * samplesPerPixel) / samplesPerBeat;

    const addLane = useAutomationStore((s) => s.addLane);

    // BUG-039 FIX: Track initialization to prevent re-running on every toggle.
    // The duplicate prevention in addLane (BUG-038) makes re-runs safe but wasteful.
    const hasInitializedRef = useRef(false);
    const previousTrackCountRef = useRef(0);

    // Auto-initialize Volume lanes for every track when Automation is first opened.
    // NOTE: We read tracksById lazily inside the effect to avoid re-triggering
    // on every track state mutation (volume, pan, solo, etc.).
    useEffect(() => {
        if (!visible) return;
        // Only reinitialize if track count changed (e.g., track added/removed)
        if (hasInitializedRef.current && trackCount === previousTrackCountRef.current) return;
        hasInitializedRef.current = true;
        previousTrackCountRef.current = trackCount;

        const state = useAutomationStore.getState();
        const currentLanes = Object.values(state.lanes);
        const currentTracksById = useEngineStore.getState().tracks.byId;

        for (let i = 0; i < trackCount; i++) {
            const trackId = trackIds[i];
            if (!trackId) continue;
            const hasVolume = currentLanes.some((l) => l.trackId === trackId && l.paramKey === 'volume');
            if (!hasVolume) {
                const track = currentTracksById[trackId];
                if (track) {
                    addLane(trackId, 'Volume', 'volume', track.color);
                }
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, trackCount]);

    // Build per-track lane groups
    const trackLanes = useMemo(() => {
        const allLanes = Object.values(lanes);
        const result: Array<{
            trackIndex: number;
            trackId: string;
            lanes: typeof allLanes;
        }> = [];

        for (let i = 0; i < trackCount; i++) {
            const trackIdAtIndex = trackIds[i];
            const track = trackIdAtIndex ? tracksById[trackIdAtIndex] : undefined;
            if (!track) continue;
            const trackId = track.id;

            const trackAutoLanes = allLanes.filter(
                (l) => l.trackId === trackId && l.visible,
            );

            result.push({
                trackIndex: i,
                trackId,
                lanes: trackAutoLanes,
            });
        }
        return result;
    }, [lanes, trackCount, trackIds, tracksById]);

    const trackOffsets = useMemo(() => {
        const offsets: number[] = new Array(trackCount + 1);
        offsets[0] = 0;
        for (let i = 0; i < trackCount; i += 1) {
            const h = Math.max(0, Math.round(trackHeights?.[i] ?? trackHeight));
            offsets[i + 1] = offsets[i] + h;
        }
        return offsets;
    }, [trackCount, trackHeight, trackHeights]);

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
                zIndex: 'var(--z-timeline-overlays)',
            }}
        >
            {trackLanes.map(({ trackIndex, lanes: tLanes }) => {
                // Determine track bounds for the main baseline line
                const trackTop = RULER_HEIGHT + (trackOffsets[trackIndex] ?? 0) - scrollTop;
                const trackH = (trackOffsets[trackIndex + 1] ?? 0) - (trackOffsets[trackIndex] ?? 0);
                const trackBottom = trackTop + trackH;

                return (
                    <div key={`track-${trackIndex}`} style={{ display: 'contents' }}>
                        {tLanes.map((lane, laneIdx) => {
                            // The very first lane for a track (e.g., Volume) lays directly over the track.
                            const isFirstLane = laneIdx === 0;
                            const laneTop = isFirstLane ? trackTop : trackBottom + (laneIdx - 1) * LANE_HEIGHT;
                            const laneH = isFirstLane ? trackH : LANE_HEIGHT;

                            if (laneH < 10) return null;

                            return (
                                <div
                                    key={lane.id}
                                    style={{
                                        position: 'absolute',
                                        top: laneTop,
                                        left: 0,
                                        width,
                                        height: laneH,
                                        pointerEvents: 'all',
                                        background: isFirstLane
                                            ? 'transparent'
                                            : 'color-mix(in srgb, var(--color-bg-panel) 85%, var(--token-color-hex-000000) 15%)',
                                        borderBottom: isFirstLane
                                            ? 'none'
                                            : 'var(--space-px) solid var(--color-divider)',
                                        zIndex: 'var(--z-timeline-overlays)',
                                    }}
                                >
                                    {!isFirstLane && (
                                        <span
                                            style={{
                                                position: 'absolute',
                                                top: 2,
                                                left: 8,
                                                fontSize: 'var(--font-size-2xs)',
                                                fontWeight: 'var(--font-weight-semibold)',
                                                color: lane.color,
                                                opacity: 0.8,
                                                zIndex: 'var(--z-local)',
                                                pointerEvents: 'none',
                                                textShadow: 'var(--text-shadow-dark)',
                                            }}
                                        >
                                            {lane.paramName}
                                        </span>
                                    )}

                                    <AutomationLane
                                        lane={lane}
                                        width={width}
                                        height={laneH}
                                        pixelsPerBeat={pixelsPerBeat}
                                        scrollOffsetBeats={scrollOffsetBeats}
                                    />
                                </div>
                            );
                        })}
                    </div>
                );
            })}
        </div>
    );
});

export default AutomationOverlay;
