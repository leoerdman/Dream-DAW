import { useEffect, useRef } from 'react';
import { scrollSync } from '@/shared/lib/useScrollSync';
import { TimelineCommandBus } from '@/shared/lib/TimelineCommandBus';
import type { Timeline } from '@/widgets/Timeline/Timeline';

type TimelineProps = React.ComponentProps<typeof Timeline>;

type TimelineCallbacks = {
    onPlayheadChange?: TimelineProps['onPlayheadChange'];
    onEditCursorChange?: TimelineProps['onEditCursorChange'];
    onClipSelect?: TimelineProps['onClipSelect'];
    onClipSelectionChange?: TimelineProps['onClipSelectionChange'];
    onClipMove?: TimelineProps['onClipMove'];
    onClipDuplicate?: TimelineProps['onClipDuplicate'];
    onClipResize?: TimelineProps['onClipResize'];
    onClipFades?: TimelineProps['onClipFades'];
    onDropBrowserItem?: TimelineProps['onDropBrowserItem'];
    onClipFadeCurves?: TimelineProps['onClipFadeCurves'];
    onClipContextMenu?: TimelineProps['onClipContextMenu'];
    onDoubleClickTrack?: TimelineProps['onDoubleClickTrack'];
    onOpenMidiClip?: TimelineProps['onOpenMidiClip'];
    onTrackSelect?: TimelineProps['onTrackSelect'];
    onMarqueeSelectionStart?: TimelineProps['onMarqueeSelectionStart'];
    onMarqueeSelectionChange?: TimelineProps['onMarqueeSelectionChange'];
};

interface CommandBusBindingsParams {
    commandBusRef: React.MutableRefObject<TimelineCommandBus>;
    callbacksRef: React.MutableRefObject<TimelineCallbacks>;
    selectedClipIdsRef: React.MutableRefObject<string[]>;
    trackIdsRef: React.MutableRefObject<string[]>;
    propsRef: React.MutableRefObject<TimelineProps>;
}

export function useTimelineCommandBusBindings({
    commandBusRef,
    callbacksRef,
    selectedClipIdsRef,
    trackIdsRef,
    propsRef,
}: CommandBusBindingsParams) {
    const selectionAnchorClipIdRef = useRef<string | null>(null);

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
                        const currentClips = propsRef.current.clips ?? [];
                        const targetClip = currentClips.find((c) => c.id === command.clipId);
                        if (!targetClip) break;
                        const anchorId = selectionAnchorClipIdRef.current ?? selectedClipIdsRef.current[0] ?? null;
                        if (!anchorId) {
                            callbacksRef.current.onClipSelect?.(command.clipId);
                            selectionAnchorClipIdRef.current = command.clipId;
                            break;
                        }
                        const anchorClip = currentClips.find((c) => c.id === anchorId);
                        if (!anchorClip) {
                            callbacksRef.current.onClipSelect?.(command.clipId);
                            selectionAnchorClipIdRef.current = command.clipId;
                            break;
                        }

                        const minTrack = Math.min(anchorClip.trackIndex, targetClip.trackIndex);
                        const maxTrack = Math.max(anchorClip.trackIndex, targetClip.trackIndex);
                        const minBeat = Math.min(anchorClip.startBeat, targetClip.startBeat);
                        const maxBeat = Math.max(
                            anchorClip.startBeat + anchorClip.durationBeats,
                            targetClip.startBeat + targetClip.durationBeats
                        );

                        const next = currentClips.filter((c) => {
                            if (c.trackIndex < minTrack || c.trackIndex > maxTrack) return false;
                            const clipEnd = c.startBeat + c.durationBeats;
                            return c.startBeat < maxBeat - 1e-5 && clipEnd > minBeat + 1e-5;
                        }).map((c) => c.id);

                        callbacksRef.current.onClipSelectionChange?.(next);
                    } else if (command.isCtrl) {
                        const prev = selectedClipIdsRef.current;
                        const next = prev.includes(command.clipId)
                            ? prev.filter((id) => id !== command.clipId)
                            : [...prev, command.clipId];
                        callbacksRef.current.onClipSelectionChange?.(next);
                        if (next.length === 0) {
                            selectionAnchorClipIdRef.current = null;
                        } else if (!selectionAnchorClipIdRef.current || !next.includes(selectionAnchorClipIdRef.current)) {
                            selectionAnchorClipIdRef.current = next[0];
                        }
                    } else {
                        callbacksRef.current.onClipSelect?.(command.clipId);
                        selectionAnchorClipIdRef.current = command.clipId;
                    }
                    break;
                case 'clip-selection':
                    callbacksRef.current.onClipSelectionChange?.(command.clipIds);
                    selectionAnchorClipIdRef.current = command.clipIds.length > 0 ? command.clipIds[command.clipIds.length - 1] : null;
                    break;
                case 'clip-move':
                    callbacksRef.current.onClipMove?.(command.clipId, command.beat, command.trackIndex);
                    break;
                case 'clip-duplicate':
                    callbacksRef.current.onClipDuplicate?.(command.clipId, command.beat, command.trackIndex);
                    break;
                case 'clip-resize':
                    callbacksRef.current.onClipResize?.(command.clipId, command.startBeat, command.duration, command.allowStretch, command.sourceOffset);
                    break;
                case 'track-dblclick':
                    callbacksRef.current.onDoubleClickTrack?.(command.trackIndex, command.beat);
                    break;
                case 'clip-dblclick':
                    callbacksRef.current.onOpenMidiClip?.(command.clipId, command.trackIndex);
                    break;
                case 'track-select': {
                    const id = trackIdsRef.current[command.trackIndex];
                    if (!id) break;
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
                default:
                    break;
            }
        });
        return unsubscribe;
    }, [callbacksRef, commandBusRef, propsRef, selectedClipIdsRef, trackIdsRef]);
}

interface EngineBindingsParams {
    engineRef: React.MutableRefObject<ReturnType<typeof import('@/shared/lib/useTimelineEngine').useTimelineEngine>['engineRef']['current']>;
    commandBusRef: React.MutableRefObject<TimelineCommandBus>;
    callbacksRef: React.MutableRefObject<TimelineCallbacks>;
}

export function useTimelineEngineCommandBindings({
    engineRef,
    commandBusRef,
    callbacksRef,
}: EngineBindingsParams) {
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;

        engine.onPlayheadSeek = (beat) => callbacksRef.current.onPlayheadChange?.(beat);
        engine.onEditCursorChange = (beat, trackStart, trackEnd) => callbacksRef.current.onEditCursorChange?.(beat, trackStart, trackEnd);
        engine.onClipClick = (clipId, isShift, isCtrl) => commandBusRef.current.emit({ type: 'clip-select', clipId, isShift, isCtrl });
        engine.onClipMove = (clipId, newBeat, newTrack) => commandBusRef.current.emit({ type: 'clip-move', clipId, beat: newBeat, trackIndex: newTrack });
        engine.onClipDuplicate = (clipId, newBeat, newTrack) => commandBusRef.current.emit({ type: 'clip-duplicate', clipId, beat: newBeat, trackIndex: newTrack });
        engine.onClipFades = (clipId, fadeInFrames, fadeOutFrames) => callbacksRef.current.onClipFades?.(clipId, fadeInFrames, fadeOutFrames);
        engine.onClipFadeCurves = (clipId, fadeInCurve, fadeOutCurve) => callbacksRef.current.onClipFadeCurves?.(clipId, fadeInCurve, fadeOutCurve);
        engine.onClipContextMenu = (clipId, beat, trackIndex, clientX, clientY) => callbacksRef.current.onClipContextMenu?.(clipId, beat, trackIndex, clientX, clientY);
        engine.onClipBoxSelection = (clipIds) => commandBusRef.current.emit({ type: 'clip-selection', clipIds });
        engine.onClipResize = (clipId, newStartBeat, newDuration, allowStretch, optSourceOffset) => {
            commandBusRef.current.emit({ type: 'clip-resize', clipId, startBeat: newStartBeat, duration: newDuration, allowStretch, sourceOffset: optSourceOffset });
        };
        engine.onDoubleClickTrack = (trackIndex, beat) => commandBusRef.current.emit({ type: 'track-dblclick', trackIndex, beat });
        engine.onDoubleClickClip = (clipId, trackIndex) => commandBusRef.current.emit({ type: 'clip-dblclick', clipId, trackIndex });
        engine.onTrackSelect = (trackIndex) => commandBusRef.current.emit({ type: 'track-select', trackIndex });
        engine.onMarqueeSelectionStart = () => commandBusRef.current.emit({ type: 'marquee-start' });
        engine.onMarqueeSelectionChange = (marquee) => commandBusRef.current.emit({ type: 'marquee-change', marquee });
        // Hot path: avoid command-bus object churn on every scroll tick.
        engine.onScrollTop = (scrollTop) => {
            scrollSync.setScrollY(scrollTop, 'timeline');
        };

        // SSOT: Wire delta listener for external panels (Inspector, Mixer).
        // When Inspector scrolls, it pushes a delta. We apply it to the
        // ViewportMatrix which clamps and fires _onScrollYChange →
        // scrollSync.setScrollY('timeline') → ALL subscribers are notified.
        const unsubDelta = scrollSync.onDelta((delta) => {
            const viewport = engine.viewport;
            viewport.scrollBy(0, delta);
        });

        // Subscribe to absolute scroll-Y from scrollSync as 'timeline'
        // (for when non-delta external sources set absolute scroll positions).
        const unsubScroll = scrollSync.subscribe('timeline', (y) => {
            engine.setScrollY(y);
        });

        return () => {
            unsubDelta();
            unsubScroll();
        };
    }, [callbacksRef, commandBusRef, engineRef]);
}
