/**
 * Timeline — Canvas-based arrangement timeline.
 *
 * Thin React shell around the TimelineEngine canvas.
 */

import { useRef, useEffect, useCallback } from 'react';
import throttle from 'lodash.throttle';
import { useTimelineEngine, type UseTimelineEngineConfig } from '@/shared/lib/useTimelineEngine';
import { beatToFrame, secondsToBeat } from '@/shared/lib/audioMath';
import type { TimelineClipData } from '@/shared/lib/CanvasClipRenderer';
import { useDragStore } from '@/shared/stores/useDragStore';
import { scrollSync } from '@/shared/lib/useScrollSync';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useTimelineStore } from '@/shared/stores/useTimelineStore';
import { useGridStore } from '@/shared/stores/useGridStore';
import type { BrowserDragItem, TimelineClip } from '@/shared/lib/arrangementTypes';
import { canDropInZone } from '@/shared/lib/dndMatrix';
import { TimelineCommandBus } from '@/shared/lib/TimelineCommandBus';
import { AutomationOverlay } from './AutomationOverlay';

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

// ── Constants ──────────────────────────────────────────────────────────────

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
        playheadBeat = 0,
        editCursorBeat = 0,
        editCursorTrackIndex = 0,
        editCursorTrackIndexEnd = 0,
        selectedTrackIndex = -1,
        selectedTrackIndices,
        isPlaying = false,
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
        followPlayhead = false,
        fitHorizontalToken = 0,
    } = props;

    const beatsPerBar = timeSignature[0];
    const totalBeats = totalBars * beatsPerBar;
    // Read live sample rate from engine (could be 44100, 48000, 96000+)
    const engineSampleRate = useEngineStore((s) => s.transport.sample_rate);

    // ── Grid store for dynamic snap ───────────────────────────────────
    const gridInterval = useGridStore((s) => s.gridInterval);
    const snapEnabled = useGridStore((s) => s.snapEnabled);
    const snapBeatsValue = gridInterval(beatsPerBar);

    // ── Engine config ─────────────────────────────────────────────────
    const engineConfig: UseTimelineEngineConfig = {
        beatsPerBar,
        bpm,
        sampleRate: engineSampleRate || 44100,
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
                    if (command.additive) {
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
        engine.onClipClick = (clipId, addToSelection) => {
            commandBusRef.current.emit({ type: 'clip-select', clipId, additive: addToSelection });
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
            const currentSampleRate = useEngineStore.getState().transport.sample_rate || 44100;
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
            midiNotes: c.midiNotes,
        }));

        engine.setClips(clipData);
        // BUG-A FIX: Immediately re-apply clip selection AFTER setClips to prevent
        // deselection on fetchProject. setClips resets all clip.selected flags to false,
        // so we must re-apply the selection atomically within the same effect.
        engine.setClipSelection(selectedClipIdsRef.current);
    }, [clips, engineRef]);

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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fitHorizontalToken, engineRef, beatsPerBar]);

    // Selection is now applied atomically inside the clips effect above.
    // This separate effect handles only explicit selection changes (e.g. click, Shift+click)
    // that happen WITHOUT a clips array change.
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        engine.setClipSelection(selectedClipIds);
    }, [selectedClipIds, engineRef]);

    // ── Feed playhead ─────────────────────────────────────────────────
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        engine.setPlayheadBeat(playheadBeat);
    }, [playheadBeat, engineRef]);

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

    // ── Playhead follow ───────────────────────────────────────────────
    useEffect(() => {
        if (!isPlaying || !followPlayhead) return;
        const engine = engineRef.current;
        if (!engine) return;
        engine.ensureBeatVisible(playheadBeat);
    }, [playheadBeat, isPlaying, followPlayhead, engineRef]);

    // ── Scroll sync cleanup ──────────────────────────────────────────
    useEffect(() => {
        return () => {
            const engine = engineRef.current;
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

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';

        const engine = engineRef.current;
        const canvas = canvasRef.current;
        if (!engine || !canvas) return;

        const rect = canvas.getBoundingClientRect();
        if (e.clientY < rect.top || e.clientY > rect.bottom) {
            engine.setDropTarget(null);
            return;
        }
        const beat = engine.viewport.screenToBeats(e.clientX, rect);
        const track = engine.viewport.screenToTrack(e.clientY, rect);

        engine.setDropTarget({ track, beat: Math.max(0, Math.round(beat)) });
    }, [engineRef, canvasRef]);

    const handleDragLeave = useCallback(() => {
        engineRef.current?.setDropTarget(null);
    }, [engineRef]);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        engineRef.current?.setDropTarget(null);

        // Try store-based drag first
        const storeDrag = useDragStore.getState().draggingItem;
        const engine = engineRef.current;
        const canvas = canvasRef.current;
        if (!engine || !canvas) return;

        const rect = canvas.getBoundingClientRect();
        if (e.clientY < rect.top || e.clientY > rect.bottom) {
            return;
        }
        const beat = Math.max(0, Math.round(engine.viewport.screenToBeats(e.clientX, rect)));
        const track = engine.viewport.screenToTrack(e.clientY, rect);

        if (storeDrag) {
            const acceptance = canDropInZone(storeDrag, 'timeline-track');
            if (!acceptance.allowed) {
                useDragStore.getState().endDrag();
                return;
            }
            const browserItem: BrowserDragItem = {
                id: storeDrag.id,
                name: storeDrag.name,
                type: storeDrag.type ?? 'audio',
                path: storeDrag.path ?? '',
                slotHint: storeDrag.slotHint,
            };
            commandBusRef.current.emit({ type: 'drop', item: browserItem, trackIndex: track, beat });
            useDragStore.getState().endDrag();
            return;
        }

        // Try HTML5 DataTransfer
        try {
            const raw = e.dataTransfer.getData('application/json');
            if (raw) {
                const item = JSON.parse(raw) as BrowserDragItem;
                commandBusRef.current.emit({ type: 'drop', item, trackIndex: track, beat });
            }
        } catch {
            // Not a valid drop
        }
    }, [engineRef, canvasRef]);

    // Store-based DnD (mouse-driven, non-HTML5):
    // update drop target while dragging and commit on global mouseup.
    useEffect(() => {
        const engine = engineRef.current;
        const canvas = canvasRef.current;
        if (!engine || !canvas || !draggingItem) return;

        const rect = canvas.getBoundingClientRect();
        const inside =
            dragCursorX >= rect.left &&
            dragCursorX <= rect.right &&
            dragCursorY >= rect.top &&
            dragCursorY <= rect.bottom;

        const acceptance = canDropInZone(draggingItem, 'timeline-track');
        if (inside && acceptance.allowed && (draggingItem.type === 'audio' || draggingItem.type === 'midi')) {
            const beat = Math.max(0, Math.round(engine.viewport.screenToBeats(dragCursorX, rect)));
            const track = engine.viewport.screenToTrack(dragCursorY, rect);
            engine.setDropTarget(null);
            const widthBeats = draggingItem.durationSeconds
                ? Math.max(0.25, secondsToBeat(draggingItem.durationSeconds, bpm))
                : 4;
            engine.setGhostClip({
                trackIndex: track,
                beat,
                widthBeats,
                name: draggingItem.name,
                type: draggingItem.type === 'midi' ? 'midi' : 'audio',
            });
        } else {
            engine.setDropTarget(null);
            engine.setGhostClip(null);
        }
    }, [draggingItem, dragCursorX, dragCursorY, engineRef, canvasRef, bpm]);

    useEffect(() => {
        if (!draggingItem) return;
        if (draggingItem.type !== 'audio' && draggingItem.type !== 'midi') return;

        const onMouseUp = (e: MouseEvent) => {
            const engine = engineRef.current;
            const canvas = canvasRef.current;
            if (!engine || !canvas) {
                // BUG-1 FIX: Only end drag if no other zone will handle it.
                // Use rAF so bubble-phase handlers run first.
                requestAnimationFrame(() => {
                    if (useDragStore.getState().draggingItem) {
                        useDragStore.getState().endDrag();
                    }
                });
                return;
            }

            const rect = canvas.getBoundingClientRect();
            const inside =
                e.clientX >= rect.left &&
                e.clientX <= rect.right &&
                e.clientY >= rect.top &&
                e.clientY <= rect.bottom;

            if (inside) {
                // Drop happened inside the timeline canvas — handle it here.
                const acceptance = canDropInZone(draggingItem, 'timeline-track');
                if (acceptance.allowed) {
                    const beat = Math.max(0, Math.round(engine.viewport.screenToBeats(e.clientX, rect)));
                    const track = engine.viewport.screenToTrack(e.clientY, rect);
                    commandBusRef.current.emit({
                        type: 'drop',
                        item: {
                            id: draggingItem.id,
                            name: draggingItem.name,
                            type: draggingItem.type,
                            path: draggingItem.path,
                            durationSeconds: draggingItem.durationSeconds,
                            slotHint: draggingItem.slotHint,
                        },
                        trackIndex: track,
                        beat,
                    });
                }
                engine.setDropTarget(null);
                engine.setGhostClip(null);
                useDragStore.getState().endDrag();
            } else {
                // BUG-1 FIX: Mouse is OUTSIDE the canvas — do NOT endDrag() here.
                // Let other drop zones (sampler surface, device rack, track inspector)
                // handle the drag in the bubble phase. Clean up the ghost clip only.
                engine.setDropTarget(null);
                engine.setGhostClip(null);
                // Fallback: if no other zone consumed the drag after bubble phase,
                // clean up the zombie drag state via rAF.
                requestAnimationFrame(() => {
                    if (useDragStore.getState().draggingItem) {
                        useDragStore.getState().endDrag();
                    }
                });
            }
        };

        window.addEventListener('mouseup', onMouseUp, { capture: true });
        return () => {
            window.removeEventListener('mouseup', onMouseUp, { capture: true });
        };
    }, [draggingItem, engineRef, canvasRef]);

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
