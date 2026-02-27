type FlushPendingEditsFn = () => Promise<void>;
type OpenExportModalFn = () => void;
type SaveProjectFn = () => Promise<void>;

const win = (): Window => window;

export const dreamGlobals = {
    getSelectedTrackId(): string | undefined {
        return win().__dreamSelectedTrackId;
    },

    setSelectedTrackId(trackId: string): void {
        win().__dreamSelectedTrackId = trackId;
    },

    clearSelectedTrackId(trackId?: string): void {
        if (!trackId || win().__dreamSelectedTrackId === trackId) {
            delete win().__dreamSelectedTrackId;
        }
    },

    isInAppDrag(): boolean {
        return win().__dreamInAppDrag === true;
    },

    setInAppDrag(value: boolean): void {
        win().__dreamInAppDrag = value;
    },

    getFlushPendingEdits(): FlushPendingEditsFn | undefined {
        return win().__dreamFlushPendingEdits;
    },

    setFlushPendingEdits(fn: FlushPendingEditsFn): void {
        win().__dreamFlushPendingEdits = fn;
    },

    clearFlushPendingEdits(fn?: FlushPendingEditsFn): void {
        if (!fn || win().__dreamFlushPendingEdits === fn) {
            delete win().__dreamFlushPendingEdits;
        }
    },

    getOpenExportModal(): OpenExportModalFn | undefined {
        return win().__dreamOpenExportModal;
    },

    setOpenExportModal(fn: OpenExportModalFn): void {
        win().__dreamOpenExportModal = fn;
    },

    clearOpenExportModal(fn?: OpenExportModalFn): void {
        if (!fn || win().__dreamOpenExportModal === fn) {
            delete win().__dreamOpenExportModal;
        }
    },

    // ── Save Project Bridge ─────────────────────────────────────────
    // SSOT bridge: useProjectManager registers these, native menu calls them.
    // This ensures Cmd+S works regardless of whether Tauri's native menu
    // intercepted the keystroke at OS level or the web-side handler caught it.

    getSaveProject(): SaveProjectFn | undefined {
        return win().__dreamSaveProject;
    },

    setSaveProject(fn: SaveProjectFn): void {
        win().__dreamSaveProject = fn;
    },

    clearSaveProject(fn?: SaveProjectFn): void {
        if (!fn || win().__dreamSaveProject === fn) {
            delete win().__dreamSaveProject;
        }
    },

    getSaveAsProject(): SaveProjectFn | undefined {
        return win().__dreamSaveAsProject;
    },

    setSaveAsProject(fn: SaveProjectFn): void {
        win().__dreamSaveAsProject = fn;
    },

    clearSaveAsProject(fn?: SaveProjectFn): void {
        if (!fn || win().__dreamSaveAsProject === fn) {
            delete win().__dreamSaveAsProject;
        }
    },
};
