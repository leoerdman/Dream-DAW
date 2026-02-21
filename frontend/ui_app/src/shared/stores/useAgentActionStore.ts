/* ═══════════════════════════════════════════════════════════════════════════
 * Dream DAW — Agent Action Indicator Store
 *
 * Zustand store for managing visual feedback when AI agent performs actions.
 * Shows a floating blue pulse indicator with the action description,
 * auto-dismissing after 3 seconds.
 * ═══════════════════════════════════════════════════════════════════════════ */

import { create } from 'zustand';

export interface AgentActionToast {
    id: string;
    label: string;
    /** Timestamp (ms) when toast was created. */
    createdAt: number;
}

interface AgentActionStore {
    toasts: AgentActionToast[];
    /** Show a new action indicator. Auto-removes after TOAST_DURATION_MS. */
    showAction: (label: string) => void;
    /** Remove a toast by id (used internally for auto-dismiss). */
    dismiss: (id: string) => void;
}

const TOAST_DURATION_MS = 3000;
let toastSeq = 0;

export const useAgentActionStore = create<AgentActionStore>((set, get) => ({
    toasts: [],

    showAction: (label: string) => {
        const id = `agent-action-${++toastSeq}`;
        const toast: AgentActionToast = { id, label, createdAt: Date.now() };

        set((s) => ({ toasts: [...s.toasts, toast] }));

        // Auto-dismiss after duration
        setTimeout(() => {
            get().dismiss(id);
        }, TOAST_DURATION_MS);
    },

    dismiss: (id: string) => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },
}));

// ── Human-readable labels for tool actions ──────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
    get_project_overview: '📋 Scanning project…',
    get_track_clips: '🔍 Reading clips…',
    get_clip_details: '🔎 Inspecting clip…',
    get_transport_state: '▶️ Checking transport…',
    select_clips: '✨ Selecting clips',
    select_all_clips_on_track: '✨ Selecting track clips',
    transport_play: '▶️ Playing',
    transport_stop: '⏹ Stopped',
    set_bpm: '🎵 BPM changed',
    seek_to_beat: '⏩ Seeking…',
    set_track_volume: '🔊 Volume adjusted',
    set_track_pan: '🔄 Pan adjusted',
    set_track_mute: '🔇 Mute toggled',
    set_track_solo: '🎧 Solo toggled',
    add_track: '➕ Track added',
    rename_track: '✏️ Track renamed',
    delete_track: '🗑 Track deleted',
    delete_clip: '🗑 Clip deleted',
    set_clip_muted: '🔇 Clip mute toggled',
    undo: '↩️ Undo',
    redo: '↪️ Redo',
    set_master_volume: '🔊 Master volume set',
    add_midi_track: '🎹 MIDI track added',
    create_midi_clip: '🎼 MIDI clip created',
    set_clip_notes: '🎵 Notes written',
};

/** Get human-readable label for a tool action. */
export function getToolLabel(toolName: string): string {
    return TOOL_LABELS[toolName] || `⚙️ ${toolName}`;
}
