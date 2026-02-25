import type { TrackInspectorLogicState } from '@/widgets/TrackInspector/model/useTrackInspectorLogic';
import { TrackRow } from '@/widgets/TrackInspector/ui/TrackRow';

interface TrackInspectorMasterRowProps {
    logic: TrackInspectorLogicState;
    selectedTrackId: string;
    trackHeight: number;
    mixerFocusMode: boolean;
}

export function TrackInspectorMasterRow({
    logic,
    selectedTrackId,
    trackHeight,
    mixerFocusMode,
}: TrackInspectorMasterRowProps) {
    const masterRowHeight = logic.rowHeightsByTrackId.master ?? trackHeight;

    return (
        <TrackRow
            trackId="master"
            trackSnapshot={logic.masterTrack}
            routingTargets={[]}
            anySoloed={false}
            trackHeight={masterRowHeight}
            isSelected={selectedTrackId === 'master'}
            isPrimarySelected={selectedTrackId === 'master'}
            isHeaderSelected={logic.headerSelectedTrackIdSet.has('master')}
            isHeaderPrimarySelected={selectedTrackId === 'master' && logic.headerSelectedTrackIdSet.has('master')}
            isCollapsed={false}
            depth={0}
            isRenaming={false}
            renameValue=""
            onRenameChange={() => { }}
            onRenameCommit={() => { }}
            onRenameCancel={() => { }}
            onClick={() => {
                logic.clearHeaderSelection();
                logic.applySelection([], 'master');
            }}
            onHeaderClick={(e) => {
                e.stopPropagation();
                logic.applySelection([], 'master', { preserveCursor: true });
                logic.applyHeaderSelection(['master']);
            }}
            onToggleMute={() => { }}
            onToggleSolo={() => { }}
            onToggleArm={() => { }}
            onVolumeChange={(gain: number) => {
                void logic.engineSetMasterVolume(gain);
            }}
            onPanChange={() => { }}
            onOutputChange={() => { }}
            onInputChange={() => { }}
            onContextMenu={(e) => {
                e.preventDefault();
                logic.setContextMenu({ trackId: 'master', trackIndex: -1, x: e.clientX, y: e.clientY });
            }}
            layout={logic.rowLayout}
            isResizing={logic.resizingTrackId === 'master'}
            onResizeStart={(startY) => logic.beginRowResize('master', masterRowHeight, startY)}
            isMasterFixed
            mixerFocusMode={mixerFocusMode}
        />
    );
}
