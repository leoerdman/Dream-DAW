// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — useNativeMenu
// ═══════════════════════════════════════════════════════════════════════════
//
// Creates the native macOS menu bar (File, Edit) via Tauri v2 JS API.
// Must be called once from the root layout (DawShell) on mount.
//
// On macOS, the first submenu automatically becomes the application menu
// (shown under "Dream DAW" in the menu bar). We place an About + Quit there.
//
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useRef } from 'react';
import { Menu, Submenu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';

/**
 * Creates the native macOS application menu bar.
 *
 * @param onProjectChange - Callback fired after project state changes (new/open/save).
 */
export function useNativeMenu(onProjectChange?: () => void) {
    const initialized = useRef(false);

    useEffect(() => {
        if (initialized.current) return;
        initialized.current = true;

        buildNativeMenu(onProjectChange).catch((err) => {
            console.error('[useNativeMenu] Failed to build native menu:', err);
        });
    }, [onProjectChange]);
}

// ── Menu Construction ────────────────────────────────────────────────────

async function buildNativeMenu(onProjectChange?: () => void) {
    const fetchProject = useEngineStore.getState().fetchProject;

    // ── 1. App Submenu (becomes "Dream DAW" on macOS) ────────────────
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

    // ── 2. File Submenu ──────────────────────────────────────────────
    const newProjectItem = await MenuItem.new({
        id: 'file_new',
        text: 'New Project',
        accelerator: 'CmdOrCtrl+N',
        action: async () => {
            try {
                await engineApi.newProject();
                await fetchProject('native-menu:new');
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
                    await engineApi.importAbletonProject(path);
                    engineApi.eagerActivateExternalPlugins().catch((e) =>
                        console.warn('[NativeMenu] Eager plugin activation:', e),
                    );
                    console.warn('[NativeMenu:Open] ALS import done, calling fetchProject...');
                } else {
                    console.warn('[NativeMenu:Open] opening project...');
                    await engineApi.openProject(path);
                    console.warn('[NativeMenu:Open] open done, calling fetchProject...');
                }
                await fetchProject('native-menu:open');
                console.warn('[NativeMenu:Open] fetchProject completed');
                onProjectChange?.();
                console.log('[NativeMenu] Opened project:', path);
            } catch (err) {
                console.error('[NativeMenu] Open failed:', err);
            }
        },
    });

    // Build Open Recent submenu dynamically
    const recentSubmenu = await buildRecentSubmenu(fetchProject, onProjectChange);

    const saveItem = await MenuItem.new({
        id: 'file_save',
        text: 'Save',
        accelerator: 'CmdOrCtrl+S',
        action: async () => {
            try {
                const flush = window.__dreamFlushPendingEdits;
                if (typeof flush === 'function') await flush();
                await engineApi.saveProject();
                console.log('[NativeMenu] Project saved');
            } catch (err) {
                // Fallback to Save As
                console.log('[NativeMenu] Save failed, trying Save As...', err);
                await handleSaveAs();
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

    // ── 3. Edit Submenu ──────────────────────────────────────────────
    const undoItem = await MenuItem.new({
        id: 'edit_undo',
        text: 'Undo',
        accelerator: 'CmdOrCtrl+Z',
        action: async () => {
            try {
                await engineApi.undo();
                await fetchProject('native-menu:undo');
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
                await engineApi.redo();
                await fetchProject('native-menu:redo');
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

    // ── 4. Window Submenu ────────────────────────────────────────────
    const windowSubmenu = await Submenu.new({
        text: 'Window',
        items: [
            await PredefinedMenuItem.new({ item: 'Minimize' }),
            await PredefinedMenuItem.new({ item: 'Maximize' }),
            await PredefinedMenuItem.new({ item: 'Separator' }),
            await PredefinedMenuItem.new({ item: 'CloseWindow' }),
        ],
    });

    // ── Assemble & Set ───────────────────────────────────────────────
    const menu = await Menu.new({
        items: [appSubmenu, fileSubmenu, editSubmenu, windowSubmenu],
    });

    await menu.setAsAppMenu();
    console.log('[NativeMenu] macOS menu bar initialized');
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function handleSaveAs() {
    try {
        const flush = window.__dreamFlushPendingEdits;
        if (typeof flush === 'function') await flush();
        const path = await engineApi.saveProjectDialog();
        if (!path) return;
        await engineApi.saveProjectAs(path);
        console.log('[NativeMenu] Project saved as:', path);
    } catch (err) {
        console.error('[NativeMenu] Save As failed:', err);
    }
}

async function buildRecentSubmenu(
    fetchProject: (reason?: string) => Promise<void>,
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
                                    await engineApi.importAbletonProject(rp.path);
                                    engineApi.eagerActivateExternalPlugins().catch((e) =>
                                        console.warn('[NativeMenu] Eager plugin activation:', e),
                                    );
                                    console.warn('[NativeMenu:OpenRecent] ALS import done');
                                } else {
                                    console.warn('[NativeMenu:OpenRecent] opening...');
                                    await engineApi.openProject(rp.path);
                                    console.warn('[NativeMenu:OpenRecent] open done');
                                }
                                await fetchProject('native-menu:open-recent');
                                console.warn('[NativeMenu:OpenRecent] fetchProject completed');
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
