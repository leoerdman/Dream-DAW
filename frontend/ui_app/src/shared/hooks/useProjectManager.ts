// ═══════════════════════════════════════════════════════════════════════════
// useProjectManager — Enterprise Project Management Hook
// ═══════════════════════════════════════════════════════════════════════════
//
// Encapsulates all project management operations:
//   - Save / Save As / New / Open with keyboard shortcuts
//   - Dirty state tracking with title bar indicator
//   - Auto-backup timer (every 5 minutes)
//   - Unsaved changes confirmation
//
// Mirrors the Swift ProjectFileManager workflow in React.
//
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react';
import * as engineApi from '../../shared/api/engine';
import type { ProjectStatus } from '../../shared/api/engine';

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

    const autoBackupRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // ── Ref for latest filePath (avoids stale closures in keyboard handlers) ──
    const filePathRef = useRef<string | null>(null);
    filePathRef.current = state.filePath;

    // ── Status Sync ───────────────────────────────────────────────────

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
        } catch (err) {
            console.error('[ProjectManager] Failed to refresh status:', err);
        }
    }, []);

    // ── Save ──────────────────────────────────────────────────────────

    /** Save to existing path, or trigger Save As if unsaved. */
    const handleSave = useCallback(async () => {
        try {
            setState((prev) => ({ ...prev, isSaving: true }));

            const flush = window.__dreamFlushPendingEdits;
            if (typeof flush === 'function') {
                await flush();
            }

            // Use ref to always get the latest filePath, avoiding stale closure
            const currentPath = filePathRef.current;
            if (currentPath) {
                // Project has been saved before — overwrite in place
                await engineApi.saveProject();
            } else {
                // Brand new project — show Save As dialog
                const path = await engineApi.saveProjectDialog();
                if (path) {
                    await engineApi.saveProjectAs(path);
                }
            }

            await refreshStatus();
        } catch (err) {
            console.error('[ProjectManager] Save failed:', err);
        } finally {
            setState((prev) => ({ ...prev, isSaving: false }));
        }
    }, [refreshStatus]);

    /** Save As — always shows the dialog. */
    const handleSaveAs = useCallback(async () => {
        try {
            setState((prev) => ({ ...prev, isSaving: true }));

            const flush = window.__dreamFlushPendingEdits;
            if (typeof flush === 'function') {
                await flush();
            }

            const path = await engineApi.saveProjectDialog();
            if (path) {
                await engineApi.saveProjectAs(path);
                await refreshStatus();
            }
        } catch (err) {
            console.error('[ProjectManager] Save As failed:', err);
        } finally {
            setState((prev) => ({ ...prev, isSaving: false }));
        }
    }, [refreshStatus]);

    // ── New Project ───────────────────────────────────────────────────

    /** New project — confirms if dirty. */
    const handleNew = useCallback(async () => {
        if (state.isDirty) {
            const confirmed = window.confirm(
                'You have unsaved changes. Create a new project anyway?'
            );
            if (!confirmed) return;
        }

        try {
            await engineApi.newProject();
            await refreshStatus();
            onProjectLoaded?.();
        } catch (err) {
            console.error('[ProjectManager] New project failed:', err);
        }
    }, [state.isDirty, refreshStatus, onProjectLoaded]);

    // ── Open Project ──────────────────────────────────────────────────

    /** Open project — picks file, confirms if dirty. */
    const handleOpen = useCallback(async () => {
        if (state.isDirty) {
            const confirmed = window.confirm(
                'You have unsaved changes. Open a different project?'
            );
            if (!confirmed) return;
        }

        try {
            const path = await engineApi.pickProjectFile();
            if (path) {
                await engineApi.openProject(path);
                await refreshStatus();
                onProjectLoaded?.();
            }
        } catch (err) {
            console.error('[ProjectManager] Open failed:', err);
        }
    }, [state.isDirty, refreshStatus, onProjectLoaded]);

    // ── Backup ────────────────────────────────────────────────────────

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

    // ── Keyboard Shortcuts ────────────────────────────────────────────

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            const mod = e.metaKey || e.ctrlKey;
            const key = e.key.toLowerCase();

            // Cmd+S — Save
            if (mod && key === 's' && !e.shiftKey) {
                e.preventDefault();
                handleSave();
                return;
            }

            // Cmd+Shift+S — Save As
            if (mod && key === 's' && e.shiftKey) {
                e.preventDefault();
                handleSaveAs();
                return;
            }

            // Cmd+N — New Project
            if (mod && key === 'n') {
                e.preventDefault();
                handleNew();
                return;
            }

            // Cmd+O — Open Project
            if (mod && key === 'o') {
                e.preventDefault();
                handleOpen();
                return;
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [handleSave, handleSaveAs, handleNew, handleOpen]);

    // ── Auto-Backup Timer ─────────────────────────────────────────────

    useEffect(() => {
        autoBackupRef.current = setInterval(() => {
            // Only auto-backup if the project has a folder (has been saved)
            if (state.projectFolder && state.isDirty) {
                handleBackup();
            }
        }, AUTO_BACKUP_INTERVAL_MS);

        return () => {
            if (autoBackupRef.current) {
                clearInterval(autoBackupRef.current);
            }
        };
    }, [state.projectFolder, state.isDirty, handleBackup]);

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
