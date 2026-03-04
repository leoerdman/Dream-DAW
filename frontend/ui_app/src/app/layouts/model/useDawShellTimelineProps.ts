import { useMemo } from 'react';
import type { Timeline } from '@/widgets/Timeline/Timeline';

type TimelineProps = React.ComponentProps<typeof Timeline>;

interface UseDawShellTimelinePropsParams {
    bpm: number;
    clips: TimelineProps['clips'];
    totalBars: number;
    editCursorBeat: number;
    editCursorTrackIndex: number;
    editCursorTrackIndexEnd: number;
    selectedTrackIndex: number;
    selectedTrackIndices: number[];
    isPlaying: boolean;
    recordingActive: boolean;
    recordingTrackIndex: number;
    trackIds: string[];
    loopStart: number;
    loopEnd: number;
    loopEnabled: boolean;
    trackCount: number;
    trackHeight: number;
    trackHeights: TimelineProps['trackHeights'];
    onPlayheadChange: TimelineProps['onPlayheadChange'];
    onEditCursorChange: TimelineProps['onEditCursorChange'];
    onMarqueeSelectionStart: TimelineProps['onMarqueeSelectionStart'];
    onMarqueeSelectionChange: TimelineProps['onMarqueeSelectionChange'];
    marqueeSelection: TimelineProps['marqueeSelection'];
    onClipSelect: TimelineProps['onClipSelect'];
    selectedClipIds: string[];
    onClipSelectionChange: TimelineProps['onClipSelectionChange'];
    onClipMove: TimelineProps['onClipMove'];
    onClipDuplicate: TimelineProps['onClipDuplicate'];
    onClipResize: TimelineProps['onClipResize'];
    onClipFades: TimelineProps['onClipFades'];
    onClipFadeCurves: TimelineProps['onClipFadeCurves'];
    onDropBrowserItem: TimelineProps['onDropBrowserItem'];
    onDoubleClickTrack: TimelineProps['onDoubleClickTrack'];
    onOpenMidiClip: TimelineProps['onOpenMidiClip'];
    onTrackSelect: TimelineProps['onTrackSelect'];
    followPlayhead: boolean;
    automationVisible: boolean;
    fitHorizontalToken: number;
}

export function useDawShellTimelineProps(params: UseDawShellTimelinePropsParams): TimelineProps {
    return useMemo(
        () => ({
            bpm: params.bpm,
            clips: params.clips,
            totalBars: params.totalBars,
            editCursorBeat: params.editCursorBeat,
            editCursorTrackIndex: params.editCursorTrackIndex,
            editCursorTrackIndexEnd: params.editCursorTrackIndexEnd,
            selectedTrackIndex: params.selectedTrackIndex,
            selectedTrackIndices: params.selectedTrackIndices,
            isPlaying: params.isPlaying,
            recordingActive: params.recordingActive,
            recordingTrackIndex: params.recordingTrackIndex,
            trackIds: params.trackIds,
            loopStart: params.loopStart,
            loopEnd: params.loopEnd,
            loopEnabled: params.loopEnabled,
            trackCount: params.trackCount,
            trackHeight: params.trackHeight,
            trackHeights: params.trackHeights,
            onPlayheadChange: params.onPlayheadChange,
            onEditCursorChange: params.onEditCursorChange,
            onMarqueeSelectionStart: params.onMarqueeSelectionStart,
            onMarqueeSelectionChange: params.onMarqueeSelectionChange,
            marqueeSelection: params.marqueeSelection,
            onClipSelect: params.onClipSelect,
            selectedClipIds: params.selectedClipIds,
            onClipSelectionChange: params.onClipSelectionChange,
            onClipMove: params.onClipMove,
            onClipDuplicate: params.onClipDuplicate,
            onClipResize: params.onClipResize,
            onClipFades: params.onClipFades,
            onClipFadeCurves: params.onClipFadeCurves,
            onDropBrowserItem: params.onDropBrowserItem,
            onDoubleClickTrack: params.onDoubleClickTrack,
            onOpenMidiClip: params.onOpenMidiClip,
            onTrackSelect: params.onTrackSelect,
            followPlayhead: params.followPlayhead,
            automationVisible: params.automationVisible,
            fitHorizontalToken: params.fitHorizontalToken,
        }),
        [
            params.automationVisible,
            params.bpm,
            params.clips,
            params.totalBars,
            params.editCursorBeat,
            params.editCursorTrackIndex,
            params.editCursorTrackIndexEnd,
            params.fitHorizontalToken,
            params.followPlayhead,
            params.isPlaying,
            params.loopEnabled,
            params.loopEnd,
            params.loopStart,
            params.onClipFadeCurves,
            params.onClipFades,
            params.onClipMove,
            params.onClipDuplicate,
            params.onClipResize,
            params.onClipSelect,
            params.onClipSelectionChange,
            params.onDoubleClickTrack,
            params.onDropBrowserItem,
            params.onEditCursorChange,
            params.onMarqueeSelectionChange,
            params.onMarqueeSelectionStart,
            params.marqueeSelection,
            params.onOpenMidiClip,
            params.onPlayheadChange,
            params.onTrackSelect,
            params.recordingActive,
            params.recordingTrackIndex,
            params.selectedClipIds,
            params.selectedTrackIndex,
            params.selectedTrackIndices,
            params.trackCount,
            params.trackHeight,
            params.trackHeights,
            params.trackIds,
        ],
    );
}
