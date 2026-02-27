import { useEffect, useRef } from 'react';
import { Menu, Submenu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import * as engineApi from '@/shared/api/engine';
import type { ProjectDelta } from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { useTimelineStore } from '@/shared/stores/useTimelineStore';
import { applyDeltasWithSnapshotSync } from '@/shared/stores/engine/snapshotSync';
import { dreamGlobals } from '@/shared/lib/dreamGlobals';
import { withProjectLoad } from '@/shared/lib/projectLoadGuard';
export function useNativeMenu(onProjectChange?: () => void) {
    const initialized = useRef(false);
    const onProjectChangeRef = useRef(onProjectChange);
    // Always keep ref current so menu actions use the latest callback
    useEffect(() => {
        onProjectChangeRef.current = onProjectChange;
    }, [onProjectChange]);
    useEffect(() => {
        if (initialized.current) return;
        initialized.current = true;
        buildNativeMenu(() => onProjectChangeRef.current?.()).catch((err) => {
            console.error('[useNativeMenu] Failed to build native menu:', err);
        });
    }, []);
}
async function buildNativeMenu(onProjectChange?: () => void) {
    const applyProjectDeltas = useEngineStore.getState().applyProjectDeltas;
    const syncProjectHistory = useEngineStore.getState().syncProjectHistory;
    const syncArrangementViewport = async () => {
        const timeline = useTimelineStore.getState();
        try {
            await engineApi.setArrangementViewport(timeline.pixelsPerBeat, timeline.scrollLeft, timeline.scrollTop);
        } catch (err) {
            // Save hotkeys/menu must remain functional even if viewport sync fails.
            console.warn('[NativeMenu] setArrangementViewport failed (non-fatal):', err);
        }
    };
    const appSubmenu = await Submenu.new({
        text: 'Dream DAW',
        items: [
            await PredefinedMenuItem.new({ item: { About: { name: 'Dream DAW' } } }),
            await PredefinedMenuItem.new({ item: 'Separator' }),
            await PredefinedMenuItem.new({ item: 'Services' }),
            await PredefinedMenuItem.new({ item: 'Separator' }),
            await PredefinedMenuItem.new({ item: 'Hide' }),
            await PredefinedMenuItem.new({ item: 'HideOthers' }),
            await PredefinedMenuItem.new({ item: 'ShowAll' }),
            await PredefinedMenuItem.new({ item: 'Separator' }),
            await PredefinedMenuItem.new({ item: 'Quit' }),
        ],
    });
    const newProjectItem = await MenuItem.new({
        id: 'file_new',
        text: 'New Project',
        accelerator: 'CmdOrCtrl+N',
        action: async () => {
            try {
                await withProjectLoad('native-menu:new', async () => {
                    const response = await engineApi.newProject();
                    await applyDeltasWithSnapshotSync(applyProjectDeltas, response.deltas, 'native-menu:new');
                });
                onProjectChange?.();

            } catch (err) {
                console.error('[NativeMenu] New project failed:', err);
            }
        },
    });
    const openItem = await MenuItem.new({
        id: 'file_open',
        text: 'Open…',
        accelerator: 'CmdOrCtrl+O',
        action: async () => {
            try {
                const path = await engineApi.pickProjectFile();
                if (!path) { return; }
                await withProjectLoad('native-menu:open', async () => {
                    const isAbleton = path.toLowerCase().endsWith('.als');
                    if (isAbleton) {
                        const response = await engineApi.importAbletonProject(path);
                        await applyDeltasWithSnapshotSync(applyProjectDeltas, response.deltas, 'native-menu:open');
                    } else {
                        const response = await engineApi.openProject(path);
                        await applyDeltasWithSnapshotSync(applyProjectDeltas, response.deltas, 'native-menu:open');
                    }
                });
                onProjectChange?.();

            } catch (err) {
                console.error('[NativeMenu] Open failed:', err);
            }
        },
    });
    const recentSubmenu = await buildRecentSubmenu(applyProjectDeltas, onProjectChange);
    const saveItem = await MenuItem.new({
        id: 'file_save',
        text: 'Save',
        accelerator: 'CmdOrCtrl+S',
        action: async () => {
            // SSOT FIX: Delegate to the React-managed save function registered
            // by useProjectManager. This is critical because Tauri intercepts
            // Cmd+S at OS level — the DOM keydown event never fires, so this
            // native menu action is the ONLY code path for Cmd+S.
            const globalSave = dreamGlobals.getSaveProject();
            if (typeof globalSave === 'function') {
                try {
                    await globalSave();
                } catch (err) {
                    console.error('[NativeMenu] Save (via global bridge) failed:', err);
                    useStatusStore.getState().setError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
                }
                return;
            }
            // Fallback: inline save logic for early-boot scenario (before
            // useProjectManager mounts and registers the global).
            try {
                const flush = dreamGlobals.getFlushPendingEdits();
                if (typeof flush === 'function') await flush();
                await syncArrangementViewport();
                const status = await engineApi.getProjectStatus();
                const hasPath = !!status.filePath && status.filePath.trim().length > 0;
                if (!hasPath) {
                    await handleSaveAs();
                    return;
                }
                await engineApi.saveProject();
                await syncProjectHistory();
                useStatusStore.getState().setInfo('Project saved');

            } catch (err) {
                console.error('[NativeMenu] Save failed:', err);
                useStatusStore.getState().setError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        },
    });
    const saveAsItem = await MenuItem.new({
        id: 'file_save_as',
        text: 'Save As…',
        accelerator: 'CmdOrCtrl+Shift+S',
        action: async () => {
            // SSOT FIX: Delegate to React-managed Save As function.
            const globalSaveAs = dreamGlobals.getSaveAsProject();
            if (typeof globalSaveAs === 'function') {
                try {
                    await globalSaveAs();
                } catch (err) {
                    console.error('[NativeMenu] Save As (via global bridge) failed:', err);
                    useStatusStore.getState().setError(`Save As failed: ${err instanceof Error ? err.message : String(err)}`);
                }
                return;
            }
            // Fallback: inline Save As for early-boot scenario.
            await handleSaveAs();
        },
    });
    const exportAudioItem = await MenuItem.new({
        id: 'file_export_audio',
        text: 'Export Audio…',
        accelerator: 'CmdOrCtrl+Shift+R',
        action: openExportModal,
    });
    const fileSubmenu = await Submenu.new({
        text: 'File',
        items: [
            newProjectItem,
            await PredefinedMenuItem.new({ item: 'Separator' }),
            openItem,
            recentSubmenu,
            await PredefinedMenuItem.new({ item: 'Separator' }),
            saveItem,
            saveAsItem,
            await PredefinedMenuItem.new({ item: 'Separator' }),
            exportAudioItem,
        ],
    });
    const undoItem = await MenuItem.new({
        id: 'edit_undo',
        text: 'Undo',
        accelerator: 'CmdOrCtrl+Z',
        action: async () => {
            try {
                const response = await engineApi.undoWithDeltas();
                await applyProjectDeltas(response.deltas, 'native-menu-undo');
                await syncProjectHistory();
                onProjectChange?.();

            } catch (err) {
                console.error('[NativeMenu] Undo failed:', err);
            }
        },
    });
    const redoItem = await MenuItem.new({
        id: 'edit_redo',
        text: 'Redo',
        accelerator: 'CmdOrCtrl+Shift+Z',
        action: async () => {
            try {
                const response = await engineApi.redoWithDeltas();
                await applyProjectDeltas(response.deltas, 'native-menu-redo');
                await syncProjectHistory();
                onProjectChange?.();

            } catch (err) {
                console.error('[NativeMenu] Redo failed:', err);
            }
        },
    });
    const editSubmenu = await Submenu.new({
        text: 'Edit',
        items: [
            undoItem,
            redoItem,
            await PredefinedMenuItem.new({ item: 'Separator' }),
            await PredefinedMenuItem.new({ item: 'Cut' }),
            await PredefinedMenuItem.new({ item: 'Copy' }),
            await PredefinedMenuItem.new({ item: 'Paste' }),
            await PredefinedMenuItem.new({ item: 'SelectAll' }),
        ],
    });
    const windowSubmenu = await Submenu.new({
        text: 'Window',
        items: [
            await PredefinedMenuItem.new({ item: 'Minimize' }),
            await PredefinedMenuItem.new({ item: 'Maximize' }),
            await PredefinedMenuItem.new({ item: 'Separator' }),
            await PredefinedMenuItem.new({ item: 'CloseWindow' }),
        ],
    });
    const menu = await Menu.new({
        items: [appSubmenu, fileSubmenu, editSubmenu, windowSubmenu],
    });
    await menu.setAsAppMenu();

}
async function handleSaveAs() {
    try {
        const syncProjectHistory = useEngineStore.getState().syncProjectHistory;
        const flush = dreamGlobals.getFlushPendingEdits();
        if (typeof flush === 'function') await flush();
        const timeline = useTimelineStore.getState();
        try {
            await engineApi.setArrangementViewport(timeline.pixelsPerBeat, timeline.scrollLeft, timeline.scrollTop);
        } catch (err) {
            console.warn('[NativeMenu] setArrangementViewport failed before Save As (non-fatal):', err);
        }
        const path = await engineApi.saveProjectDialog();
        if (!path) return;
        await engineApi.saveProjectAs(path);
        await syncProjectHistory();
        useStatusStore.getState().setInfo(`Project saved as: ${path.split('/').pop()}`);

    } catch (err) {
        console.error('[NativeMenu] Save As failed:', err);
        useStatusStore.getState().setError(`Save As failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
async function buildRecentSubmenu(
    applyProjectDeltas: (deltas: ProjectDelta[], reason?: string) => Promise<void>,
    onProjectChange?: () => void,
): Promise<Submenu> {
    const recentItems: (MenuItem | PredefinedMenuItem)[] = [];
    try {
        const recents = await engineApi.getRecentProjects();
        if (recents.length > 0) {
            for (const rp of recents.slice(0, 10)) {
                const label = rp.name || rp.path.split('/').pop() || rp.path;
                recentItems.push(
                    await MenuItem.new({
                        id: `recent_${rp.path}`,
                        text: label,
                        action: async () => {
                            try {
                                // BUG-041 FIX: Debug console.warn removed from production.
                                await withProjectLoad('native-menu:open-recent', async () => {
                                    const isAbleton = rp.path.toLowerCase().endsWith('.als');
                                    if (isAbleton) {

                                        const response = await engineApi.importAbletonProject(rp.path);
                                        await applyDeltasWithSnapshotSync(applyProjectDeltas, response.deltas, 'native-menu:open-recent');

                                    } else {

                                        const response = await engineApi.openProject(rp.path);
                                        await applyDeltasWithSnapshotSync(applyProjectDeltas, response.deltas, 'native-menu:open-recent');

                                    }
                                });
                                onProjectChange?.();

                            } catch (err) {
                                console.error('[NativeMenu] Open recent failed:', err);
                            }
                        },
                    }),
                );
            }
        } else {
            recentItems.push(
                await MenuItem.new({
                    id: 'recent_empty',
                    text: 'No Recent Projects',
                    enabled: false,
                    action: () => { },
                }),
            );
        }
    } catch (err) {
        console.warn('[NativeMenu] Failed to load recent projects:', err);
        recentItems.push(
            await MenuItem.new({
                id: 'recent_error',
                text: 'No Recent Projects',
                enabled: false,
                action: () => { },
            }),
        );
    }
    return Submenu.new({
        text: 'Open Recent',
        items: recentItems,
    });
}
const openExportModal = () => {
    const openExport = dreamGlobals.getOpenExportModal();
    if (typeof openExport === 'function') return void openExport();
    window.dispatchEvent(new CustomEvent('dream:open-export'));
    document.dispatchEvent(new CustomEvent('dream:open-export'));
    requestAnimationFrame(() => { window.dispatchEvent(new CustomEvent('dream:open-export')); document.dispatchEvent(new CustomEvent('dream:open-export')); });
};
