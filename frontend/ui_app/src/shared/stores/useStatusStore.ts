/**
 * useStatusStore — Global status bar state (errors, notices).
 *
 * Used by DeviceRack (and other components) to push errors/notices
 * that are displayed in the bottom StatusBar.
 */
import { create } from 'zustand';

interface StatusState {
    /** Current error/notice message, or null if clear. */
    message: string | null;
    /** Severity: 'error' for red, 'info' for neutral. */
    severity: 'error' | 'info';
    /** Timestamp of last message (for auto-dismiss). */
    timestamp: number;

    /** Push an error message to the status bar. Auto-clears after 8s. */
    setError: (msg: string) => void;
    /** Push an info notice. Auto-clears after 5s. */
    setInfo: (msg: string) => void;
    /** Clear the current message. */
    clear: () => void;
}

let dismissTimer: ReturnType<typeof setTimeout> | null = null;

export const useStatusStore = create<StatusState>((set) => ({
    message: null,
    severity: 'info',
    timestamp: 0,

    setError: (msg) => {
        if (dismissTimer) clearTimeout(dismissTimer);
        const ts = Date.now();
        set({ message: msg, severity: 'error', timestamp: ts });
        dismissTimer = setTimeout(() => {
            set((s) => (s.timestamp === ts ? { message: null } : s));
        }, 8000);
    },

    setInfo: (msg) => {
        if (dismissTimer) clearTimeout(dismissTimer);
        const ts = Date.now();
        set({ message: msg, severity: 'info', timestamp: ts });
        dismissTimer = setTimeout(() => {
            set((s) => (s.timestamp === ts ? { message: null } : s));
        }, 5000);
    },

    clear: () => {
        if (dismissTimer) clearTimeout(dismissTimer);
        set({ message: null });
    },
}));
