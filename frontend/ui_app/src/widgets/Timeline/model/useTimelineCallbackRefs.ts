import { useEffect, useRef } from 'react';
import type { BrowserDragItem, TimelineClip } from '@/shared/lib/arrangementTypes';

type TimelinePropsRef = {
    bpm?: number;
    timeSignature?: [number, number];
    clips?: TimelineClip[];
    followPlayhead?: boolean;
};

type TimelineCallbacks = {
    onPlayheadChange?: (beat: number) => void;
    onEditCursorChange?: (beat: number, trackStart: number, trackEnd: number) => void;
    onClipSelect?: (clipId: string) => void;
    onClipSelectionChange?: (clipIds: string[]) => void;
    onClipMove?: (clipId: string, newStartBeat: number, newTrackIndex: number) => void;
    onClipResize?: (clipId: string, newStartBeat: number, newDuration: number, allowStretch: boolean) => void;
    onClipFades?: (clipId: string, fadeInFrames: number, fadeOutFrames: number) => void;
    onDropBrowserItem?: (item: BrowserDragItem, trackIndex: number, beat: number) => void;
    onClipFadeCurves?: (clipId: string, fadeInCurve: number, fadeOutCurve: number) => void;
    onDoubleClickTrack?: (trackIndex: number, beat: number) => void;
    onOpenMidiClip?: (clipId: string, trackIndex: number) => void;
    onTrackSelect?: (trackId: string, trackIndex: number) => void;
    onMarqueeSelectionStart?: () => void;
    onMarqueeSelectionChange?: (marquee: { startBeat: number; endBeat: number; startTrack: number; endTrack: number } | null) => void;
};

export function useTimelineCallbackRefs(
    props: TimelinePropsRef,
    callbacks: TimelineCallbacks,
    selectedClipIds: string[],
    trackIds: string[],
) {
    const propsRef = useRef(props);
    const callbacksRef = useRef(callbacks);
    const selectedClipIdsRef = useRef(selectedClipIds);
    const trackIdsRef = useRef(trackIds);

    useEffect(() => {
        propsRef.current = props;
    }, [props]);

    useEffect(() => {
        callbacksRef.current = callbacks;
    }, [callbacks]);

    useEffect(() => {
        selectedClipIdsRef.current = selectedClipIds;
    }, [selectedClipIds]);

    useEffect(() => {
        trackIdsRef.current = trackIds;
    }, [trackIds]);

    return {
        propsRef,
        callbacksRef,
        selectedClipIdsRef,
        trackIdsRef,
    };
}
