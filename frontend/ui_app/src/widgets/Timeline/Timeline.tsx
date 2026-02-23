/**
 * Timeline — Canvas-based arrangement timeline.
 *
 * Thin React shell around the TimelineEngine canvas.
 */

import { useRef, useEffect, useMemo } from 'react';
import throttle from 'lodash.throttle';
import { useTimelineEngine, type UseTimelineEngineConfig } from '@/shared/lib/useTimelineEngine';
import { beatToFrame, resolveSampleRate } from '@/shared/lib/audioMath';
import type { TimelineClipData } from '@/shared/lib/CanvasClipRenderer';
import { useDragStore } from '@/shared/stores/useDragStore';
import { scrollSync } from '@/shared/lib/useScrollSync';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useTimelineStore } from '@/shared/stores/useTimelineStore';
import { useGridStore } from '@/shared/stores/useGridStore';
import type { BrowserDragItem, TimelineClip } from '@/shared/lib/arrangementTypes';
import { TimelineCommandBus } from '@/shared/lib/TimelineCommandBus';
import { isTrackActive } from '@/shared/utils/routing';
import { AutomationOverlay } from './AutomationOverlay';
import { useTimelineDnD } from './model/useTimelineDnD';

interface TimelineProps {
    bpm?: number;
    timeSignature?: [number, number];
    totalBars?: number;
    trackCount?: number;
    trackHeight?: number;
    trackHeights?: number[];
    clips?: TimelineClip[];
    playheadBeat?: number;
    editCursorBeat?: number;
    editCursorTrackIndex?: number;
    editCursorTrackIndexEnd?: number;
    selectedTrackIndex?: number;
    selectedTrackIndices?: number[];
    isPlaying?: boolean;
    recordingActive?: boolean;
    recordingTrackIndex?: number;
    trackIds?: string[];
    loopStart?: number;
    loopEnd?: number;
    loopEnabled?: boolean;
    onPlayheadChange?: (beat: number) => void;
    onEditCursorChange?: (beat: number, trackStart: number, trackEnd: number) => void;
    onClipSelect?: (clipId: string) => void;
    selectedClipIds?: string[];
    onClipSelectionChange?: (clipIds: string[]) => void;
    onClipMove?: (clipId: string, newStartBeat: number, newTrackIndex: number) => void;
    onClipResize?: (clipId: string, newStartBeat: number, newDuration: number) => void;
    onClipFades?: (clipId: string, fadeInFrames: number, fadeOutFrames: number) => void;
    onClipFadeCurves?: (clipId: string, fadeInCurve: number, fadeOutCurve: number) => void;
    onDropBrowserItem?: (item: BrowserDragItem, trackIndex: number, beat: number) => void;
    onDoubleClickTrack?: (trackIndex: number, beat: number) => void;
    onOpenMidiClip?: (clipId: string, trackIndex: number) => void;
    onTrackSelect?: (trackId: string, trackIndex: number) => void;
    onMarqueeSelectionStart?: () => void;
    onMarqueeSelectionChange?: (marquee: { startBeat: number; endBeat: number; startTrack: number; endTrack: number } | null) => void;
    // Scroll sync handled by scrollSync singleton — no props needed.
    followPlayhead?: boolean;
    automationVisible?: boolean;
    fitHorizontalToken?: number;
}

const RULER_HEIGHT = 28;
const DEFAULT_PPB = 20;
const DEFAULT_TRACK_HEIGHT = 48;

// ── Component ──────────────────────────────────────────────────────────────

export const Timeline = (props: TimelineProps) => {
    const {
        bpm = 120,
        timeSignature = [4, 4],
        totalBars = 128,
        trackCount = 8,
        trackHeight = DEFAULT_TRACK_HEIGHT,
        trackHeights,
        clips = [],
        // playheadBeat — now read from store directly (effectivePlayheadBeat)
        editCursorBeat = 0,
        editCursorTrackIndex = 0,
        editCursorTrackIndexEnd = 0,
        selectedTrackIndex = -1,
        selectedTrackIndices,
        // isPlaying — now read from store directly (effectiveIsPlaying)
        trackIds = [],
        loopStart = 0,
        loopEnd = 4,
        loopEnabled = false,
        selectedClipIds = [],
        onPlayheadChange,
        onEditCursorChange,
        onClipSelect,
        onClipSelectionChange,
        onClipMove,
        onClipFades,
        onDropBrowserItem,
        onClipFadeCurves,
        onDoubleClickTrack,
        onOpenMidiClip,
        onTrackSelect,
        onMarqueeSelectionStart,
        onMarqueeSelectionChange,
        onClipResize,
        fitHorizontalToken = 0,
    } = props;

    const beatsPerBar = timeSignature[0];
    const totalBeats = totalBars * beatsPerBar;
    // Read live sample rate from engine (could be 44100, 48000, 96000+)
    const engineSampleRate = useEngineStore((s) => s.transport.sample_rate);
    // PERF-FIX: Playhead position AND isPlaying are pumped to the engine via a
    // direct Zustand subscription (below) instead of React subscriptions. This
    // avoids ~30 React re-renders per second of the entire Timeline component.

    // ── Grid store for dynamic snap ───────────────────────────────────
    const gridInterval = useGridStore((s) => s.gridInterval);
    const snapEnabled = useGridStore((s) => s.snapEnabled);
    const snapBeatsValue = gridInterval(beatsPerBar);

    // ── Engine config ─────────────────────────────────────────────────
    const engineConfig: UseTimelineEngineConfig = {
        beatsPerBar,
        bpm,
        sampleRate: resolveSampleRate(engineSampleRate),
        totalBeats,
        trackCount,
        trackHeight,
        trackHeights,
        rulerHeight: RULER_HEIGHT,
        initialPpb: DEFAULT_PPB,
        snapBeats: snapBeatsValue,
        snapEnabled,
    };

    const { canvasRef, engineRef } = useTimelineEngine(engineConfig);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const arrangementRef = useRef<HTMLDivElement | null>(null);
    const propsRef = useRef(props);
    propsRef.current = props;
    const commandBusRef = useRef<TimelineCommandBus>(new TimelineCommandBus());

    // ── Store refs for callbacks (avoid stale closures) ───────────────
    const callbacksRef = useRef({
        onPlayheadChange,
        onEditCursorChange,
        onClipSelect,
        onClipSelectionChange,
        onClipMove,
        onClipResize,
        onClipFades,
        onDropBrowserItem,
        onClipFadeCurves,
        onDoubleClickTrack,
        onOpenMidiClip,
        onTrackSelect,
        onMarqueeSelectionStart,
        onMarqueeSelectionChange,
    });
    callbacksRef.current = {
        onPlayheadChange,
        onEditCursorChange,
        onClipSelect,
        onClipSelectionChange,
        onClipMove,
        onClipResize,
        onClipFades,
        onDropBrowserItem,
        onClipFadeCurves,
        onDoubleClickTrack,
        onOpenMidiClip,
        onTrackSelect,
        onMarqueeSelectionStart,
        onMarqueeSelectionChange,
    };

    useEffect(() => {
        const unsubscribe = commandBusRef.current.subscribe((command) => {
            switch (command.type) {
                case 'seek':
                    callbacksRef.current.onPlayheadChange?.(command.beat);
                    break;
                case 'edit-cursor':
                    callbacksRef.current.onEditCursorChange?.(command.beat, command.trackIndex, command.trackIndex);
                    break;
                case 'clip-select':
                    if (command.isShift) {
                        const prev = selectedClipIdsRef.current;
                        const currentClips = propsRef.current.clips ?? [];
                        const targetClip = currentClips.find((c) => c.id === command.clipId);
                        if (!targetClip) break;

                        if (prev.length === 0) {
                            callbacksRef.current.onClipSelect?.(command.clipId);
                        } else {
                            const anchorId = prev[0];
                            const anchorClip = currentClips.find((c) => c.id === anchorId);
                            if (!anchorClip) {
                                callbacksRef.current.onClipSelect?.(command.clipId);
                                break;
                            }

                            const minBeat = Math.min(anchorClip.startBeat, targetClip.startBeat);
                            const maxBeat = Math.max(
                                anchorClip.startBeat + anchorClip.durationBeats,
                                targetClip.startBeat + targetClip.durationBeats
                            );
                            const minTrack = Math.min(anchorClip.trackIndex, targetClip.trackIndex);
                            const maxTrack = Math.max(anchorClip.trackIndex, targetClip.trackIndex);

                            const next = currentClips
                                .filter((c) => {
                                    if (c.trackIndex < minTrack || c.trackIndex > maxTrack) return false;
                                    const cEnd = c.startBeat + c.durationBeats;
                                    return cEnd > minBeat && c.startBeat < maxBeat;
                                })
                                .map((c) => c.id);

                            callbacksRef.current.onClipSelectionChange?.(next);
                        }
                    } else if (command.isCtrl) {
                        const prev = selectedClipIdsRef.current;
                        const next = prev.includes(command.clipId)
                            ? prev.filter((id) => id !== command.clipId)
                            : [...prev, command.clipId];
                        callbacksRef.current.onClipSelectionChange?.(next);
                    } else {
                        callbacksRef.current.onClipSelect?.(command.clipId);
                    }
                    break;
                case 'clip-selection':
                    callbacksRef.current.onClipSelectionChange?.(command.clipIds);
                    break;
                case 'clip-move':
                    callbacksRef.current.onClipMove?.(command.clipId, command.beat, command.trackIndex);
                    break;
                case 'clip-resize':
                    callbacksRef.current.onClipResize?.(command.clipId, command.startBeat, command.duration);
                    break;
                case 'track-dblclick':
                    callbacksRef.current.onDoubleClickTrack?.(command.trackIndex, command.beat);
                    break;
                case 'clip-dblclick':
                    callbacksRef.current.onOpenMidiClip?.(command.clipId, command.trackIndex);
                    break;
                case 'track-select': {
                    const id = trackIdsRef.current[command.trackIndex] ?? `track-${command.trackIndex}`;
                    callbacksRef.current.onTrackSelect?.(id, command.trackIndex);
                    break;
                }
                case 'marquee-start':
                    callbacksRef.current.onMarqueeSelectionStart?.();
                    break;
                case 'marquee-change':
                    callbacksRef.current.onMarqueeSelectionChange?.(command.marquee);
                    break;
                case 'drop':
                    callbacksRef.current.onDropBrowserItem?.(command.item, command.trackIndex, command.beat);
                    break;
                case 'scroll-top':
                    scrollSync.setScrollY(command.value, 'timeline');
                    break;
                default:
                    break;
            }
        });
        return unsubscribe;
    }, []);

    // ── Wire engine callbacks ─────────────────────────────────────────
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;

        engine.onPlayheadSeek = (beat) => {
            callbacksRef.current.onPlayheadChange?.(beat);
        };
        engine.onEditCursorChange = (beat, trackStart, trackEnd) => {
            callbacksRef.current.onEditCursorChange?.(beat, trackStart, trackEnd);
        };
        engine.onClipClick = (clipId, isShift, isCtrl) => {
            commandBusRef.current.emit({ type: 'clip-select', clipId, isShift, isCtrl });
        };

        engine.onClipMove = (clipId, newBeat, newTrack) => {
            commandBusRef.current.emit({ type: 'clip-move', clipId, beat: newBeat, trackIndex: newTrack });
        };

        engine.onClipFades = (clipId, fadeInFrames, fadeOutFrames) => {
            callbacksRef.current.onClipFades?.(clipId, fadeInFrames, fadeOutFrames);
        };

        engine.onClipFadeCurves = (clipId, fadeInCurve, fadeOutCurve) => {
            callbacksRef.current.onClipFadeCurves?.(clipId, fadeInCurve, fadeOutCurve);
        };

        engine.onClipBoxSelection = (clipIds) => {
            commandBusRef.current.emit({ type: 'clip-selection', clipIds });
        };

        engine.onClipResize = (clipId, newStartBeat, newDuration) => {
            commandBusRef.current.emit({
                type: 'clip-resize',
                clipId,
                startBeat: newStartBeat,
                duration: newDuration,
            });
        };

        engine.onDoubleClickTrack = (trackIndex, beat) => {
            commandBusRef.current.emit({ type: 'track-dblclick', trackIndex, beat });
        };

        engine.onDoubleClickClip = (clipId, trackIndex) => {
            commandBusRef.current.emit({ type: 'clip-dblclick', clipId, trackIndex });
        };

        engine.onTrackSelect = (trackIndex) => {
            commandBusRef.current.emit({ type: 'track-select', trackIndex });
        };

        engine.onMarqueeSelectionStart = () => {
            commandBusRef.current.emit({ type: 'marquee-start' });
        };

        engine.onMarqueeSelectionChange = (marquee) => {
            commandBusRef.current.emit({ type: 'marquee-change', marquee });
        };

        engine.onScrollTop = (scrollTop) => {
            commandBusRef.current.emit({ type: 'scroll-top', value: scrollTop });
        };

        // ── Subscribe to scrollSync for inspector-originated scroll ──
        // This replaces the old externalScrollTop prop/useEffect.
        const unsubScroll = scrollSync.subscribe('timeline', (y) => {
            engine.setScrollY(y);
        });
        // Store cleanup for the subscription
        (engine as unknown as Record<string, () => void>)._scrollSyncUnsub = unsubScroll;

        engine.onLoopChange = (loop) => {
            pendingLoopRef.current = loop;
            throttledLoopCommitRef.current();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Refs for callback closure stability
    const selectedClipIdsRef = useRef(selectedClipIds);
    selectedClipIdsRef.current = selectedClipIds;
    const trackIdsRef = useRef(trackIds);
    trackIdsRef.current = trackIds;
    const pendingLoopRef = useRef<{ start: number; end: number; enabled: boolean } | null>(null);
    const commitLoopRef = useRef<(loop: { start: number; end: number; enabled: boolean }) => void>(() => { });

    useEffect(() => {
        commitLoopRef.current = (loop) => {
            const currentBpm = propsRef.current.bpm || 120;
            const currentSampleRate = resolveSampleRate(useEngineStore.getState().transport.sample_rate);
            const startFrames = beatToFrame(loop.start, currentBpm, currentSampleRate);
            const endFrames = beatToFrame(loop.end, currentBpm, currentSampleRate);
            useEngineStore.getState().setLoop(loop.enabled, startFrames, endFrames);
        };
    }, []);

    const throttledLoopCommitRef = useRef(
        throttle(() => {
            const pending = pendingLoopRef.current;
            if (!pending) return;
            commitLoopRef.current(pending);
        }, 33, { leading: true, trailing: true }),
    );

    useEffect(() => {
        const throttledLoopCommit = throttledLoopCommitRef.current;
        const flush = () => {
            throttledLoopCommit.flush();
            const pending = pendingLoopRef.current;
            if (!pending) return;
            commitLoopRef.current(pending);
            pendingLoopRef.current = null;
        };
        window.addEventListener('mouseup', flush, true);
        window.addEventListener('touchend', flush, true);
        return () => {
            window.removeEventListener('mouseup', flush, true);
            window.removeEventListener('touchend', flush, true);
            throttledLoopCommit.cancel();
        };
    }, []);

    // ── Track mute state (reactive — clips re-dim/un-dim on mute toggle) ──
    const projectTracks = useEngineStore((s) => s.projectTracks);
    const trackActiveStates = useMemo(() => projectTracks.map((_t, i, arr) => isTrackActive(i, arr)), [projectTracks]);

    // ── Feed clips to engine ──────────────────────────────────────────
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        const clipData: TimelineClipData[] = clips.map(c => ({
            // Stored fades are in sample-frames; canvas renderer expects 0..1 fraction of clip width.
            fadeIn: (c.durationSamples && c.durationSamples > 0)
                ? Math.max(0, Math.min(1, (c.fadeIn ?? 0) / c.durationSamples))
                : 0,
            fadeOut: (c.durationSamples && c.durationSamples > 0)
                ? Math.max(0, Math.min(1, (c.fadeOut ?? 0) / c.durationSamples))
                : 0,
            id: c.id,
            name: c.name,
            trackIndex: c.trackIndex,
            startBeat: c.startBeat,
            durationBeats: c.durationBeats,
            type: c.type,
            color: c.color,
            selected: false,
            filePath: c.filePath,
            durationSamples: c.durationSamples,
            sourceOffset: c.sourceOffset,
            fadeInCurve: c.fadeInCurve,
            fadeOutCurve: c.fadeOutCurve,
            isOffline: c.isOffline,
            muted: c.muted,
            // Clips on inactive tracks render darker (reactive via trackActiveStates dep)
            trackMuted: !trackActiveStates[c.trackIndex],
            midiNotes: c.midiNotes,
        }));

        engine.setClips(clipData);
        // BUG-A FIX: Immediately re-apply clip selection AFTER setClips to prevent
        // deselection after snapshot/delta project swaps. setClips resets all
        // clip.selected flags to false,
        // so we must re-apply the selection atomically within the same effect.
        engine.setClipSelection(selectedClipIdsRef.current);
    }, [clips, engineRef, trackActiveStates]);

    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        const viewport = engine.viewport;
        const viewportWidth = viewport.viewportWidth;
        if (viewportWidth <= 8) return;

        // Read clips from ref to avoid triggering this effect on every clip
        // mutation. The effect should ONLY run when fitHorizontalToken changes
        // (explicit user action, e.g. pressing W).
        const currentClips = propsRef.current.clips ?? [];

        let minBeat = 0;
        let maxBeat = Math.max(4, beatsPerBar * 4);

        if (currentClips.length > 0) {
            minBeat = Infinity;
            maxBeat = -Infinity;
            for (const clip of currentClips) {
                const start = clip.startBeat;
                const end = clip.startBeat + Math.max(0.01, clip.durationBeats);
                if (start < minBeat) minBeat = start;
                if (end > maxBeat) maxBeat = end;
            }
            if (!Number.isFinite(minBeat) || !Number.isFinite(maxBeat)) {
                minBeat = 0;
                maxBeat = Math.max(4, beatsPerBar * 4);
            }
        }

        const span = Math.max(1, maxBeat - minBeat);
        const pad = Math.max(0.5, span * 0.05);
        const paddedStart = Math.max(0, minBeat - pad);
        const paddedEnd = Math.max(paddedStart + 1, maxBeat + pad);
        const targetPpb = viewportWidth / (paddedEnd - paddedStart);

        viewport.setZoom(targetPpb);
        viewport.scrollTo(paddedStart * viewport.pixelsPerBeat, viewport.scrollY);
    }, [fitHorizontalToken, engineRef, beatsPerBar, clips]);

    // Selection is now applied atomically inside the clips effect above.
    // This separate effect handles only explicit selection changes (e.g. click, Shift+click)
    // that happen WITHOUT a clips array change.
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        engine.setClipSelection(selectedClipIds);
    }, [selectedClipIds, engineRef]);

    // ── Feed playhead (DIRECT ZUSTAND SUBSCRIPTION — bypasses React) ──
    // PERF-FIX: This replaces the old useEffect([effectivePlayheadBeat]) pattern
    // that caused 30fps React re-renders of the entire Timeline component.
    // Now the engine gets position updates synchronously from the store without
    // touching React at all.
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;

        const unsub = useEngineStore.subscribe((state, prevState) => {
            const beats = state.transport.position_beats ?? 0;
            const prevBeats = prevState?.transport.position_beats ?? 0;
            const playing = state.transport.is_playing;

            if (beats !== prevBeats) {
                engine.setPlayheadBeat(beats);
                // Follow playhead: keep playhead visible during playback
                if (playing && propsRef.current.followPlayhead) {
                    engine.ensureBeatVisible(beats);
                }
            }
        });

        return unsub;
    }, [engineRef]);

    // ── Feed edit cursor ──────────────────────────────────────────────
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        engine.setEditCursor(editCursorBeat, editCursorTrackIndex, editCursorTrackIndexEnd ?? editCursorTrackIndex);
    }, [editCursorBeat, editCursorTrackIndex, editCursorTrackIndexEnd, engineRef]);

    // ── Feed selected track highlight ─────────────────────────────────
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        const list = (selectedTrackIndices && selectedTrackIndices.length > 0)
            ? selectedTrackIndices
            : (selectedTrackIndex >= 0 ? [selectedTrackIndex] : []);
        engine.setSelectedTracks(selectedTrackIndex, list);
    }, [selectedTrackIndex, selectedTrackIndices, engineRef]);

    // ── Feed loop region ──────────────────────────────────────────────
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        // Always pass loop markers so handles stay visible/interactive.
        engine.setLoop({
            start: loopStart,
            end: loopEnd,
            enabled: loopEnabled,
        });
    }, [loopStart, loopEnd, loopEnabled, engineRef]);

    // ── Scroll sync cleanup ──────────────────────────────────────────
    useEffect(() => {
        const engine = engineRef.current;
        return () => {
            if (engine) {
                const unsub = (engine as unknown as Record<string, () => void>)._scrollSyncUnsub;
                unsub?.();
            }
        };
    }, [engineRef]);

    // ── Store-based drag overlay (DawShell → Timeline) ────────────────
    const draggingItem = useDragStore(s => s.draggingItem);
    const dragCursorX = useDragStore(s => s.cursorX);
    const dragCursorY = useDragStore(s => s.cursorY);

    const { handleDragOver, handleDragLeave, handleDrop } = useTimelineDnD({
        engineRef,
        canvasRef,
        commandBusRef,
        bpm,
        draggingItem,
        dragCursorX,
        dragCursorY,
    });

    // Ghost clip is handled together with cursor-tracked drop target effect above.

    // ═══════════════════════════════════════════════════════════════════
    // RENDER — A single <canvas> element. That's it.
    // ═══════════════════════════════════════════════════════════════════

    return (
        <div
            ref={rootRef}
            data-testid="timeline-view"
            data-track-count={trackCount}
            data-track-ids-count={trackIds.length}
            style={{
                width: '100%',
                height: '100%',
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                background: 'var(--surface-1)',
            }}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            <div
                ref={arrangementRef}
                style={{
                    position: 'relative',
                    flex: 1,
                    minHeight: 0,
                    overflow: 'visible',
                }}
            >
                <canvas
                    ref={canvasRef}
                    style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        width: '100%',
                        height: `calc(100% + ${trackHeight}px)`,
                        display: 'block',
                    }}
                />
                {props.automationVisible && (
                    <AutomationOverlay
                        visible
                        trackCount={trackCount}
                        trackHeight={trackHeight}
                        scrollTop={useTimelineStore.getState().scrollTop ?? 0}
                        width={arrangementRef.current?.clientWidth ?? 800}
                        bpm={bpm}
                    />
                )}
            </div>
            <div
                data-testid="timeline-master-lane"
                style={{
                    height: trackHeight,
                    flexShrink: 0,
                    borderTop: 'none',
                    boxShadow: 'inset 0 1px 0 var(--color-border-subtle)',
                    background: 'transparent',
                    pointerEvents: 'none',
                    position: 'relative',
                    zIndex: 'var(--z-local)' as unknown as number,
                }}
            />
        </div>
    );
};
