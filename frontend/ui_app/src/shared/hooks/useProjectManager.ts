import { useCallback, useEffect, useRef, useState } from 'react';
import * as engineApi from '../../shared/api/engine';
import type { ProjectStatus } from '../../shared/api/engine';
import { useEngineStore } from '../../shared/stores/useEngineStore';
import { useTimelineStore } from '../../shared/stores/useTimelineStore';
import { applyDeltasWithSnapshotSync } from '../../shared/stores/engine/snapshotSync';
import { dreamGlobals } from '../../shared/lib/dreamGlobals';
import { withProjectLoad } from '../../shared/lib/projectLoadGuard';
/** Auto-backup interval in milliseconds (5 minutes). */
const AUTO_BACKUP_INTERVAL_MS = 5 * 60 * 1000;
export interface ProjectManagerState {
    isDirty: boolean;
    filePath: string | null;
    projectFolder: string | null;
    isSaving: boolean;
}
/**
 * Enterprise project management hook.
 *
 * Provides save/open/new operations, keyboard shortcuts (Cmd+S, Cmd+Shift+S,
 * Cmd+N, Cmd+O), auto-backup, and dirty state tracking.
 *
 * @param onProjectLoaded - callback when a project is loaded/created (to refresh UI state)
 */
export function useProjectManager(onProjectLoaded?: () => void) {
    const [state, setState] = useState<ProjectManagerState>({
        isDirty: false,
        filePath: null,
        projectFolder: null,
        isSaving: false,
    });
    const syncProjectHistory = useEngineStore((s) => s.syncProjectHistory);
    const applyProjectDeltas = useEngineStore((s) => s.applyProjectDeltas);
    const syncArrangementViewport = useCallback(async () => {
        const timeline = useTimelineStore.getState();
        try {
            await engineApi.setArrangementViewport(timeline.pixelsPerBeat, timeline.scrollLeft, timeline.scrollTop);
        } catch (err) {
            // Save must not fail just because viewport persistence failed.
            console.warn('[ProjectManager] setArrangementViewport failed (non-fatal):', err);
        }
    }, []);
    const pickSavePath = useCallback(async (): Promise<string | null> => {
        try {
            const path = await engineApi.saveProjectDialog();
            if (path && path.trim().length > 0) return path;
        } catch (err) {
            console.warn('[ProjectManager] saveProjectDialog failed, trying plugin-dialog fallback:', err);
        }
        try {
            const { save } = await import('@tauri-apps/plugin-dialog');
            const path = await save({
                title: 'Save Dream DAW Project',
                filters: [{ name: 'Dream DAW Project', extensions: ['ddpj'] }],
                defaultPath: 'Untitled Project.ddpj',
            });
            return typeof path === 'string' && path.trim().length > 0 ? path : null;
        } catch (err) {
            console.error('[ProjectManager] plugin-dialog save fallback failed:', err);
            return null;
        }
    }, []);
    const filePathRef = useRef<string | null>(null);
    filePathRef.current = state.filePath;
    /** Fetches and syncs the project status from the backend. */
    const refreshStatus = useCallback(async () => {
        try {
            const status: ProjectStatus = await engineApi.getProjectStatus();
            setState((prev) => ({
                ...prev,
                isDirty: status.isDirty,
                filePath: status.filePath,
                projectFolder: status.projectFolder,
            }));
            // Sync window title with dirty state (adds/removes *)
            await engineApi.syncTitle();
        } catch (err) {
            console.error('[ProjectManager] Failed to refresh status:', err);
        }
    }, []);
    /** Save to existing path, or trigger Save As if unsaved. */
    const handleSave = useCallback(async () => {
        try {
            setState((prev) => ({ ...prev, isSaving: true }));
            // BUG-052 FIX: Wrap flush in try/catch so save doesn't fail if flush errors.
            try {
                const flush = dreamGlobals.getFlushPendingEdits();
                if (typeof flush === 'function') {
                    await flush();
                }
            } catch (flushErr) {
                console.warn('[ProjectManager] flushPendingEdits failed (non-fatal):', flushErr);
            }
            await syncArrangementViewport();
            // Re-read backend status at save time because project may have been
            // opened via native menu / recent projects outside this hook.
            const liveStatus: ProjectStatus = await engineApi.getProjectStatus();
            const livePath = liveStatus.filePath && liveStatus.filePath.trim().length > 0
                ? liveStatus.filePath
                : null;
            setState((prev) => ({
                ...prev,
                isDirty: liveStatus.isDirty,
                filePath: liveStatus.filePath,
                projectFolder: liveStatus.projectFolder,
            }));
            // Use ref to always get the latest filePath, avoiding stale closure
            const currentPath = livePath ?? filePathRef.current;
            if (currentPath) {
                // Project has been saved before — overwrite in place
                await engineApi.saveProject();
                await syncProjectHistory();
            } else {
                // Brand new project — show Save As dialog
                const path = await pickSavePath();
                if (path) {
                    await engineApi.saveProjectAs(path);
                    await syncProjectHistory();
                }
            }
            await refreshStatus();
        } catch (err) {
            console.error('[ProjectManager] Save failed:', err);
        } finally {
            setState((prev) => ({ ...prev, isSaving: false }));
        }
    }, [refreshStatus, syncProjectHistory, syncArrangementViewport, pickSavePath]);
    /** Save As — always shows the dialog. */
    const handleSaveAs = useCallback(async () => {
        try {
            setState((prev) => ({ ...prev, isSaving: true }));
            // BUG-052 FIX: Wrap flush in try/catch so Save As doesn't fail if flush errors.
            try {
                const flush = dreamGlobals.getFlushPendingEdits();
                if (typeof flush === 'function') {
                    await flush();
                }
            } catch (flushErr) {
                console.warn('[ProjectManager] flushPendingEdits failed (non-fatal):', flushErr);
            }
            await syncArrangementViewport();
            const path = await pickSavePath();
            if (path) {
                await engineApi.saveProjectAs(path);
                await syncProjectHistory();
                await refreshStatus();
            }
        } catch (err) {
            console.error('[ProjectManager] Save As failed:', err);
        } finally {
            setState((prev) => ({ ...prev, isSaving: false }));
        }
    }, [refreshStatus, syncProjectHistory, syncArrangementViewport, pickSavePath]);
    /** New project — confirms if dirty. */
    const handleNew = useCallback(async () => {
        // BUG-018 FIX: Use ref for latest isDirty to avoid stale closure.
        if (isDirtyRef.current) {
            const confirmed = window.confirm(
                'You have unsaved changes. Create a new project anyway?'
            );
            if (!confirmed) return;
        }
        try {
            await withProjectLoad('project-manager:new', async () => {
                const response = await engineApi.newProject();
                await applyDeltasWithSnapshotSync(applyProjectDeltas, response.deltas, 'project-manager:new');
            });
            await syncProjectHistory();
            await refreshStatus();
            onProjectLoaded?.();
        } catch (err) {
            console.error('[ProjectManager] New project failed:', err);
        }
    }, [refreshStatus, onProjectLoaded, syncProjectHistory, applyProjectDeltas]);
    /** Open project — picks file, confirms if dirty. */
    const handleOpen = useCallback(async () => {
        // BUG-019 FIX: Use ref for latest isDirty to avoid stale closure.
        if (isDirtyRef.current) {
            const confirmed = window.confirm(
                'You have unsaved changes. Open a different project?'
            );
            if (!confirmed) return;
        }
        try {
            const path = await engineApi.pickProjectFile();
            if (path) {
                await withProjectLoad('project-manager:open', async () => {
                    const isAbleton = path.toLowerCase().endsWith('.als');
                    if (isAbleton) {
                        const response = await engineApi.importAbletonProject(path);
                        await applyDeltasWithSnapshotSync(applyProjectDeltas, response.deltas, 'project-manager:open');
                    } else {
                        const response = await engineApi.openProject(path);
                        await applyDeltasWithSnapshotSync(applyProjectDeltas, response.deltas, 'project-manager:open');
                    }
                });
                await syncProjectHistory();
                await refreshStatus();
                onProjectLoaded?.();
            }
        } catch (err) {
            console.error('[ProjectManager] Open failed:', err);
        }
    }, [refreshStatus, onProjectLoaded, syncProjectHistory, applyProjectDeltas]);
    /** Manually create a backup. */
    const handleBackup = useCallback(async () => {
        try {
            const path = await engineApi.createBackup();
            console.log('[ProjectManager] Backup created:', path);
        } catch (err) {
            // Silently ignore backup failures (no folder set yet)
            console.debug('[ProjectManager] Backup skipped:', err);
        }
    }, []);
    // NOTE: Cmd+N and Cmd+O are handled exclusively by the native macOS
    // menu (useNativeMenu) via Tauri accelerators. Registering them here
    // too would cause duplicate handlers: both would call pickProjectFile/openProject
    // and apply overlapping snapshot deltas concurrently, creating a race where
    // stale updates can win and leave UI state behind.
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.isComposing) return;
            const mod = e.metaKey || e.ctrlKey;
            if (!mod || e.altKey) return;
            if (e.repeat) return;
            const key = (e.key || '').toLowerCase();
            const isSaveKey = e.code === 'KeyS' || key === 's' || key === 'ы';
            // Cmd+S — Save
            if (isSaveKey && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                handleSave();
                return;
            }
            // Cmd+Shift+S — Save As
            if (isSaveKey && e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                handleSaveAs();
                return;
            }
        };
        // Single capture listener avoids duplicate command execution when both
        // window and document handlers receive the same keydown event.
        window.addEventListener('keydown', onKeyDown, { capture: true });
        return () => {
            window.removeEventListener('keydown', onKeyDown, { capture: true } as EventListenerOptions);
        };
    }, [handleSave, handleSaveAs]);
    // Use refs for volatile state so the interval doesn't have to be
    // torn down and recreated every time isDirty or projectFolder changes.
    const isDirtyRef = useRef(state.isDirty);
    isDirtyRef.current = state.isDirty;
    const projectFolderRef = useRef(state.projectFolder);
    projectFolderRef.current = state.projectFolder;
    useEffect(() => {
        let cancelled = false;
        let timerId: ReturnType<typeof setTimeout> | null = null;
        const runCycle = async () => {
            if (cancelled) return;
            if (projectFolderRef.current && isDirtyRef.current) {
                await handleBackup();
            }
            if (cancelled) return;
            timerId = setTimeout(() => {
                void runCycle();
            }, AUTO_BACKUP_INTERVAL_MS);
        };
        timerId = setTimeout(() => {
            void runCycle();
        }, AUTO_BACKUP_INTERVAL_MS);
        return () => {
            cancelled = true;
            if (timerId) clearTimeout(timerId);
        };
    }, [handleBackup]);
    // ── Initial Status Sync ───────────────────────────────────────────
    useEffect(() => {
        refreshStatus();
    }, [refreshStatus]);
    return {
        /** Current project manager state. */
        ...state,
        /** Save to current path (or Save As if new). */
        save: handleSave,
        /** Always show Save As dialog. */
        saveAs: handleSaveAs,
        /** Create new empty project. */
        newProject: handleNew,
        /** Open project from disk. */
        openProject: handleOpen,
        /** Manually trigger a backup. */
        backup: handleBackup,
        /** Re-fetch project status from backend. */
        refreshStatus,
    };
}
