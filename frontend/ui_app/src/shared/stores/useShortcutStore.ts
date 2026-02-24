import { create } from 'zustand';
import {
    type ShortcutActionId,
    DEFAULT_SHORTCUT_BINDINGS,
    normalizeShortcutCombo,
} from '@/shared/lib/shortcutBindings';
import { safeStorage } from '@/shared/lib/safeStorage';

const STORAGE_KEY = 'dream-daw:shortcut-bindings:v1';

interface ShortcutStore {
    bindings: Record<ShortcutActionId, string>;
    setBinding: (actionId: ShortcutActionId, combo: string) => void;
    resetBinding: (actionId: ShortcutActionId) => void;
    resetAll: () => void;
    getBinding: (actionId: ShortcutActionId) => string;
}

function loadStoredBindings(): Record<ShortcutActionId, string> {
    try {
        const raw = safeStorage.getItem(STORAGE_KEY);
        if (!raw) return { ...DEFAULT_SHORTCUT_BINDINGS };
        const parsed = JSON.parse(raw) as Partial<Record<ShortcutActionId, string>>;
        const merged: Record<ShortcutActionId, string> = { ...DEFAULT_SHORTCUT_BINDINGS };
        for (const key of Object.keys(DEFAULT_SHORTCUT_BINDINGS) as ShortcutActionId[]) {
            const next = parsed[key];
            if (typeof next === 'string' && next.trim().length > 0) {
                merged[key] = normalizeShortcutCombo(next);
            }
        }
        return merged;
    } catch {
        return { ...DEFAULT_SHORTCUT_BINDINGS };
    }
}

function persistBindings(bindings: Record<ShortcutActionId, string>): void {
    safeStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
}

export const useShortcutStore = create<ShortcutStore>((set, get) => ({
    bindings: loadStoredBindings(),
    setBinding: (actionId, combo) => {
        const normalized = normalizeShortcutCombo(combo);
        const next = {
            ...get().bindings,
            [actionId]: normalized || DEFAULT_SHORTCUT_BINDINGS[actionId],
        };
        set({ bindings: next });
        persistBindings(next);
    },
    resetBinding: (actionId) => {
        const next = {
            ...get().bindings,
            [actionId]: DEFAULT_SHORTCUT_BINDINGS[actionId],
        };
        set({ bindings: next });
        persistBindings(next);
    },
    resetAll: () => {
        const next = { ...DEFAULT_SHORTCUT_BINDINGS };
        set({ bindings: next });
        persistBindings(next);
    },
    getBinding: (actionId) => get().bindings[actionId] ?? DEFAULT_SHORTCUT_BINDINGS[actionId],
}));
