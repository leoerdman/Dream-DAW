type FlushPendingEditsFn = () => Promise<void>;
type OpenExportModalFn = () => void;

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
};

