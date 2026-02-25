import { useTrackInspectorLogic } from '@/widgets/TrackInspector/model/useTrackInspectorLogic';
import { TrackInspectorHeader } from '@/widgets/TrackInspector/ui/TrackInspectorHeader';
import { TrackInspectorMasterRow } from '@/widgets/TrackInspector/ui/TrackInspectorMasterRow';
import { TrackInspectorOverlays } from '@/widgets/TrackInspector/ui/TrackInspectorOverlays';
import { TrackInspectorTrackList } from '@/widgets/TrackInspector/ui/TrackInspectorTrackList';

interface TrackInspectorProps {
    selectedTrackId: string;
    selectedTrackIds?: string[];
    onSelectTrack: (id: string, options?: { preserveCursor?: boolean }) => void;
    onSelectTracks?: (ids: string[], primaryId: string, options?: { preserveCursor?: boolean }) => void;
    trackHeight?: number;
    rulerHeight?: number;
    mixerFocusMode?: boolean;
    collapsedGroups?: Set<string>;
    onToggleGroupCollapse?: (groupId: string) => void;
}

export const TrackInspector = ({
    selectedTrackId,
    selectedTrackIds: selectedTrackIdsProp,
    onSelectTrack,
    onSelectTracks,
    trackHeight = 48,
    rulerHeight = 24,
    mixerFocusMode = false,
    collapsedGroups: collapsedGroupsProp,
    onToggleGroupCollapse: onToggleGroupCollapseProp,
}: TrackInspectorProps) => {
    const logic = useTrackInspectorLogic({
        selectedTrackId,
        selectedTrackIds: selectedTrackIdsProp,
        onSelectTrack,
        onSelectTracks,
        trackHeight,
        rulerHeight,
        mixerFocusMode,
        collapsedGroups: collapsedGroupsProp,
        onToggleGroupCollapse: onToggleGroupCollapseProp,
    });

    return (
        <div
            data-testid="track-inspector"
            data-keyboard-scope="track-inspector"
            style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                background: 'var(--color-bg-panel)',
                fontSize: 'var(--font-size-xs)',
            }}
        >
            <TrackInspectorHeader rulerHeight={rulerHeight} mixerFocusMode={mixerFocusMode} />
            <TrackInspectorTrackList
                logic={logic}
                selectedTrackId={selectedTrackId}
                trackHeight={trackHeight}
                mixerFocusMode={mixerFocusMode}
            />
            <TrackInspectorMasterRow
                logic={logic}
                selectedTrackId={selectedTrackId}
                trackHeight={trackHeight}
                mixerFocusMode={mixerFocusMode}
            />
            <TrackInspectorOverlays logic={logic} />
        </div>
    );
};
