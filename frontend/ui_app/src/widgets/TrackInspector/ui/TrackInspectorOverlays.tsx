import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import type { TrackInspectorLogicState } from '@/widgets/TrackInspector/model/useTrackInspectorLogic';
import { ColorPickerPopup } from '@/widgets/TrackInspector/ui/ColorPickerPopup';
import { ContextMenuPopup } from '@/widgets/TrackInspector/ui/ContextMenuPopup';

interface TrackInspectorOverlaysProps {
    logic: TrackInspectorLogicState;
}

export function TrackInspectorOverlays({ logic }: TrackInspectorOverlaysProps) {
    // Dismiss both context menu and color picker together
    const dismissAll = () => {
        logic.setContextMenu(null);
        logic.setColorPickerState(null);
    };

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
                        dismissAll();
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
                    onDelete={() => {
                        if (!logic.contextMenu?.trackId) return;
                        logic.handleDeleteTrack(logic.contextMenu.trackId);
                    }}
                    onChangeColor={() => {
                        if (!logic.contextMenu?.trackId) return;
                        // Position the color picker to the right of the context menu
                        const pickerX = logic.contextMenu.x + 192;
                        const pickerY = logic.contextMenu.y;
                        logic.handleOpenColorPicker(logic.contextMenu.trackId, pickerX, pickerY);
                    }}
                    onPaintClips={() => {
                        if (!logic.contextMenu?.trackId) return;
                        logic.handlePaintClipsWithTrackColor(logic.contextMenu.trackId);
                    }}
                    onDismiss={dismissAll}
                />
            )}

            {logic.colorPickerState && (
                <ColorPickerPopup
                    x={logic.colorPickerState.x}
                    y={logic.colorPickerState.y}
                    currentColor={
                        (logic.colorPickerState.trackId === 'master'
                            ? logic.masterTrack.color
                            : logic.tracks.find((t) => t.id === logic.colorPickerState?.trackId)?.color) || 'var(--color-divider-heavy)'
                    }
                    onSelect={(color) => {
                        const trackId = logic.colorPickerState?.trackId;
                        if (!trackId) return;
                        logic.handleColorSelect(trackId, color);
                        dismissAll();
                    }}
                    onDismiss={dismissAll}
                />
            )}
        </>
    );
}
