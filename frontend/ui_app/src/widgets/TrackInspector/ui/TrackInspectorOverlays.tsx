import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import type { TrackInspectorLogicState } from '@/widgets/TrackInspector/model/useTrackInspectorLogic';
import { ColorPickerPopup } from '@/widgets/TrackInspector/ui/ColorPickerPopup';
import { ContextMenuPopup } from '@/widgets/TrackInspector/ui/ContextMenuPopup';

interface TrackInspectorOverlaysProps {
    logic: TrackInspectorLogicState;
}

export function TrackInspectorOverlays({ logic }: TrackInspectorOverlaysProps) {
    return (
        <>
            {logic.contextMenu && (
                <ContextMenuPopup
                    x={logic.contextMenu.x}
                    y={logic.contextMenu.y}
                    showTrackActions={Boolean(logic.contextMenu.trackId)}
                    onAddAudioTrack={() => logic.handleAddTrackFromContext('audio')}
                    onAddMidiTrack={() => logic.handleAddTrackFromContext('midi')}
                    onRename={() => {
                        if (!logic.contextMenu?.trackId) return;
                        logic.handleRenameStart(logic.contextMenu.trackId);
                    }}
                    onDuplicate={() => {
                        if (!logic.contextMenu?.trackId) return;
                        void engineApi
                            .duplicateTracksWithDeltas([logic.contextMenu.trackId])
                            .then(async (response) => {
                                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:duplicate-context');
                            })
                            .catch((err) => {
                                console.error('[TrackInspector] duplicate track (context menu) failed:', err);
                            });
                        logic.setContextMenu(null);
                    }}
                    onGroup={() => {
                        if (!logic.contextMenu?.trackId) return;
                        logic.handleGroupTrack(logic.contextMenu.trackId);
                    }}
                    onUngroup={() => {
                        if (!logic.contextMenu?.trackId) return;
                        logic.handleUngroupTrack(logic.contextMenu.trackId);
                    }}
                    canUngroup={(() => {
                        if (!logic.contextMenu?.trackId) return false;
                        const ctxTrack = logic.tracks.find((t) => t.id === logic.contextMenu?.trackId);
                        return !!ctxTrack && (ctxTrack.type === 'group' || !!ctxTrack.groupId);
                    })()}
                    canBounceGroup={(() => {
                        if (!logic.contextMenu?.trackId) return false;
                        const ctxTrack = logic.tracks.find((t) => t.id === logic.contextMenu?.trackId);
                        return !!ctxTrack && ctxTrack.type === 'group';
                    })()}
                    onDelete={() => {
                        if (!logic.contextMenu?.trackId) return;
                        logic.handleDeleteTrack(logic.contextMenu.trackId);
                    }}
                    onChangeColor={() => {
                        if (!logic.contextMenu?.trackId) return;
                        logic.handleOpenColorPicker(logic.contextMenu.trackId, logic.contextMenu.x, logic.contextMenu.y);
                    }}
                    onPaintClips={() => {
                        if (!logic.contextMenu?.trackId) return;
                        logic.handlePaintClipsWithTrackColor(logic.contextMenu.trackId);
                    }}
                    onBounceTrack={() => {
                        if (!logic.contextMenu?.trackId) return;
                        logic.handleBounceTrack(logic.contextMenu.trackId);
                    }}
                    onBounceGroup={() => {
                        if (!logic.contextMenu?.trackId) return;
                        logic.handleBounceGroup(logic.contextMenu.trackId);
                    }}
                    onPaintGroupColor={() => {
                        if (!logic.contextMenu?.trackId) return;
                        logic.handlePaintGroupColor(logic.contextMenu.trackId);
                    }}
                    onSplitToStems={() => {
                        if (!logic.contextMenu?.trackId) return;
                        logic.handleSplitTrackToStems(logic.contextMenu.trackId);
                    }}
                    onDismiss={() => logic.setContextMenu(null)}
                />
            )}

            {logic.colorPickerState && (
                <ColorPickerPopup
                    x={logic.colorPickerState.x}
                    y={logic.colorPickerState.y}
                    currentColor={
                        (logic.colorPickerState.trackId === 'master'
                            ? logic.masterTrack.color
                            : logic.tracks.find((t) => t.id === logic.colorPickerState?.trackId)?.color) || '#666'
                    }
                    onSelect={(color) => logic.handleColorSelect(logic.colorPickerState!.trackId, color)}
                    onDismiss={() => logic.setColorPickerState(null)}
                />
            )}
        </>
    );
}
