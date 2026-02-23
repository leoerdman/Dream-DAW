import { useEffect, useRef } from 'react';
import { Menu, Submenu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import * as engineApi from '@/shared/api/engine';
import type { ProjectDelta } from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { useTimelineStore } from '@/shared/stores/useTimelineStore';

/**
 * Creates the native macOS application menu bar.
 *
 * @param onProjectChange - Callback fired after project state changes (new/open/save).
 */
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
            await engineApi.setArrangementViewport(timeline.pixelsPerBeat, timeline.scrollLeft);
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
                const response = await engineApi.newProject();
                await applyProjectDeltas(response.deltas, 'native-menu:new');
                onProjectChange?.();
                console.log('[NativeMenu] New project created');
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
                console.warn('[NativeMenu:Open] file picker opening...');
                const path = await engineApi.pickProjectFile();
                if (!path) { console.warn('[NativeMenu:Open] picker cancelled'); return; }
                console.warn('[NativeMenu:Open] path=', path);
                const isAbleton = path.toLowerCase().endsWith('.als');
                if (isAbleton) {
                    console.warn('[NativeMenu:Open] importing ALS...');
                    const response = await engineApi.importAbletonProject(path);
                    await applyProjectDeltas(response.deltas, 'native-menu:open');
                    console.warn('[NativeMenu:Open] ALS import done, snapshot applied');
                } else {
                    console.warn('[NativeMenu:Open] opening project...');
                    const response = await engineApi.openProject(path);
                    await applyProjectDeltas(response.deltas, 'native-menu:open');
                    console.warn('[NativeMenu:Open] open done, snapshot applied');
                }
                // Eagerly activate external VST3 plugins and restore their saved state
                engineApi.eagerActivateExternalPlugins().catch((err) =>
                    console.warn('[NativeMenu] Eager plugin activation (non-fatal):', err)
                );
                onProjectChange?.();
                console.log('[NativeMenu] Opened project:', path);
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
            try {
                const flush = window.__dreamFlushPendingEdits;
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
                console.log('[NativeMenu] Project saved');
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
        action: handleSaveAs,
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
                console.log('[NativeMenu] Undo');
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
                console.log('[NativeMenu] Redo');
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
    console.log('[NativeMenu] macOS menu bar initialized');
}

async function handleSaveAs() {
    try {
        const syncProjectHistory = useEngineStore.getState().syncProjectHistory;
        const flush = window.__dreamFlushPendingEdits;
        if (typeof flush === 'function') await flush();
        const timeline = useTimelineStore.getState();
        try {
            await engineApi.setArrangementViewport(timeline.pixelsPerBeat, timeline.scrollLeft);
        } catch (err) {
            console.warn('[NativeMenu] setArrangementViewport failed before Save As (non-fatal):', err);
        }
        const path = await engineApi.saveProjectDialog();
        if (!path) return;
        await engineApi.saveProjectAs(path);
        await syncProjectHistory();
        useStatusStore.getState().setInfo(`Project saved as: ${path.split('/').pop()}`);
        console.log('[NativeMenu] Project saved as:', path);
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
                                console.warn('[NativeMenu:OpenRecent] path=', rp.path);
                                const isAbleton = rp.path.toLowerCase().endsWith('.als');
                                if (isAbleton) {
                                    console.warn('[NativeMenu:OpenRecent] importing ALS...');
                                    const response = await engineApi.importAbletonProject(rp.path);
                                    await applyProjectDeltas(response.deltas, 'native-menu:open-recent');
                                    console.warn('[NativeMenu:OpenRecent] ALS import done, snapshot applied');
                                } else {
                                    console.warn('[NativeMenu:OpenRecent] opening...');
                                    const response = await engineApi.openProject(rp.path);
                                    await applyProjectDeltas(response.deltas, 'native-menu:open-recent');
                                    console.warn('[NativeMenu:OpenRecent] open done, snapshot applied');
                                }
                                // Eagerly activate external VST3 plugins and restore their saved state
                                engineApi.eagerActivateExternalPlugins().catch((err) =>
                                    console.warn('[NativeMenu] Eager plugin activation (non-fatal):', err)
                                );
                                onProjectChange?.();
                                console.log('[NativeMenu] Opened recent:', rp.path);
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
    } catch {
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
