/* ═══════════════════════════════════════════════════════════════════════════
 * Dream DAW — AI Chat History Service
 *
 * Local persistence of AI assistant chat history per project.
 * Uses localStorage to store up to MAX_CONTEXT_MESSAGES exchanges.
 *
 * Storage key: `dream-ai-chat:<sha256-of-project-path>`
 * Each entry stores the full conversation including tool calls and
 * agent reasoning, enabling proper context for follow-up interactions.
 * ═══════════════════════════════════════════════════════════════════════════ */

import type { ChatMessage } from './assistantService';
import * as engineApi from './engine';

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum number of stored messages (user + assistant + tool).
 *  20 user messages ≈ 40-60 total entries (user, assistant, tool responses).
 *  We cap at 100 total entries to keep things manageable while preserving
 *  the full 20 exchange context the user requested. */
const MAX_STORED_ENTRIES = 100;

const STORAGE_PREFIX = 'dream-ai-chat:';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Simple hash for project path → stable localStorage key. */
function hashPath(path: string): string {
    // FNV-1a 32-bit hash — fast, deterministic, no crypto dependency.
    let h = 0x811c9dc5;
    for (let i = 0; i < path.length; i++) {
        h ^= path.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

// Generate a unique session ID for unsaved projects so they don't share history
const generateSafeId = () => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
};
const sessionUntitledId = `untitled-${generateSafeId()}`;

/** Get the current project file path from the engine (async). */
async function getCurrentProjectPath(): Promise<string> {
    try {
        const status = await engineApi.getProjectStatus();
        return status.filePath || sessionUntitledId;
    } catch {
        return sessionUntitledId;
    }
}

/** Build the localStorage key for a project path. */
function storageKey(projectPath: string): string {
    return `${STORAGE_PREFIX}${hashPath(projectPath)}`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Load chat history for the current project. Returns [] if none exists. */
export async function loadChatHistory(): Promise<ChatMessage[]> {
    const path = await getCurrentProjectPath();
    const key = storageKey(path);
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed as ChatMessage[];
    } catch (err) {
        console.warn('[ChatHistory] Failed to load:', err);
        return [];
    }
}

/** Save chat history for the current project.
 *  Automatically trims to MAX_STORED_ENTRIES, keeping latest messages. */
export async function saveChatHistory(messages: ChatMessage[]): Promise<void> {
    const path = await getCurrentProjectPath();
    const key = storageKey(path);

    // Trim: keep the most recent MAX_STORED_ENTRIES messages.
    // We trim from the beginning (oldest) to preserve recent context.
    const trimmed = messages.length > MAX_STORED_ENTRIES
        ? messages.slice(messages.length - MAX_STORED_ENTRIES)
        : messages;

    try {
        localStorage.setItem(key, JSON.stringify(trimmed));
    } catch (err) {
        console.warn('[ChatHistory] Failed to save:', err);
        // If localStorage is full, try clearing old project histories.
        try {
            clearOldHistories();
            localStorage.setItem(key, JSON.stringify(trimmed));
        } catch {
            console.error('[ChatHistory] Storage full, cannot save.');
        }
    }
}

/** Clear chat history for the current project. */
export async function clearChatHistory(): Promise<void> {
    const path = await getCurrentProjectPath();
    const key = storageKey(path);
    try {
        localStorage.removeItem(key);
    } catch (err) {
        console.warn('[ChatHistory] Failed to clear:', err);
    }
}

/** Remove the oldest project chat histories if storage is getting full.
 *  Keeps the 10 most recently modified project histories. */
function clearOldHistories(): void {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(STORAGE_PREFIX)) keys.push(k);
    }
    // Keep the 10 most recent (by key order, which is arbitrary but good enough)
    if (keys.length > 10) {
        // Remove excess oldest entries
        const toRemove = keys.slice(0, keys.length - 10);
        for (const k of toRemove) {
            localStorage.removeItem(k);
        }
    }
}
