import type { BrowserDragItem, TimelineClip } from '@/shared/lib/arrangementTypes';

export interface TimelineProps {
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
    onClipResize?: (clipId: string, newStartBeat: number, newDuration: number, allowStretch: boolean) => void;
    onClipFades?: (clipId: string, fadeInFrames: number, fadeOutFrames: number) => void;
    onClipFadeCurves?: (clipId: string, fadeInCurve: number, fadeOutCurve: number) => void;
    onDropBrowserItem?: (item: BrowserDragItem, trackIndex: number, beat: number) => void;
    onDoubleClickTrack?: (trackIndex: number, beat: number) => void;
    onOpenMidiClip?: (clipId: string, trackIndex: number) => void;
    onTrackSelect?: (trackId: string, trackIndex: number) => void;
    onMarqueeSelectionStart?: () => void;
    onMarqueeSelectionChange?: (marquee: { startBeat: number; endBeat: number; startTrack: number; endTrack: number } | null) => void;
    marqueeSelection?: { startBeat: number; endBeat: number; startTrack: number; endTrack: number } | null;
    followPlayhead?: boolean;
    automationVisible?: boolean;
    fitHorizontalToken?: number;
}

