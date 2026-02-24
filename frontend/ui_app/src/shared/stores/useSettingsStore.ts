// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Settings Zustand Store
// ═══════════════════════════════════════════════════════════════════════════
//
// Persistent application settings synced with the Rust backend.
// Mirrors Swift `AppSettings` → Rust `AppSettings` → this store.
//
// Usage:
//   const { settings, updateSetting, pickAndSetFolder } = useSettingsStore();
//
// ═══════════════════════════════════════════════════════════════════════════

import { create } from 'zustand';
import * as engineApi from '@/shared/api/engine';
import type { AppSettings } from '@/shared/api/engine';

interface SettingsStore {
    /** Current application settings. */
    settings: AppSettings;

    /** Whether settings have been loaded from backend at least once. */
    loaded: boolean;

    /** Load settings from the Rust backend. Called once on app startup. */
    loadSettings: () => Promise<void>;

    /** Update a single setting key → persists to disk immediately. */
    updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;

    /** Replace all settings at once (bulk update). */
    updateAllSettings: (newSettings: AppSettings) => Promise<void>;

    /**
     * Open native folder picker dialog and update a folder setting.
     * Returns the selected path, or null if cancelled.
     */
    pickAndSetFolder: (settingKey: keyof AppSettings) => Promise<string | null>;
}

/** Default settings — used before backend loads. Must match Rust defaults. */
const DEFAULT_SETTINGS: AppSettings = {
    language: 'English',
    startupBehavior: 'new',
    theme: 'dark',
    darkThemeShade: 0,
    darkThemeTintPercent: 0,
    waveformStyle: 'colored',
    driverType: 'CoreAudio',
    outputDevice: 'Default Output',
    fallbackOutputDevice: 'Default Output',
    inputDevice: 'Default Input',
    sampleRate: 44100,
    bufferSize: 512,
    driverErrorCompensation: 0.0,
    testToneEnabled: false,
    testToneVolume: -20.0,
    testToneFrequency: 440.0,
    cpuUsageSimulator: false,
    srPitchConversion: true,
    userFolderPath: '~/Music/Dream DAW',
    samplesPath: '~/Music/Dream DAW/Samples',
    vst2Path: '/Library/Audio/Plug-Ins/VST',
    vst3Path: '/Library/Audio/Plug-Ins/VST3',
    openRouterApiKey: '',
    openRouterModel: 'anthropic/claude-sonnet-4-5',
    browserShowSizeColumn: true,
    browserShowTypeColumn: false,
    browserLeftPaneWidth: 92,
    transportFollowPlayhead: true,
    transportAutomationVisible: false,
    transportPianoPencilMode: true,
    arrangementGridDivision: 'ADAPTIVE',
    arrangementGridTriplet: false,
    arrangementGridSnapEnabled: true,
};

export const useSettingsStore = create<SettingsStore>((set, get) => ({
    settings: DEFAULT_SETTINGS,
    loaded: false,

    loadSettings: async () => {
        try {
            const settings = await engineApi.getSettings();
            set({ settings, loaded: true });
        } catch (err) {
            console.error('[SettingsStore] Failed to load settings:', err);
            // Keep defaults
            set({ loaded: true });
        }
    },

    updateSetting: async (key, value) => {
        const current = get().settings;
        const updated = { ...current, [key]: value };
        set({ settings: updated });

        try {
            await engineApi.updateSettings(updated);
        } catch (err) {
            console.error('[SettingsStore] Failed to persist setting:', key, err);
            // Revert optimistic update
            set({ settings: current });
        }
    },

    updateAllSettings: async (newSettings) => {
        const current = get().settings;
        set({ settings: newSettings });

        try {
            await engineApi.updateSettings(newSettings);
        } catch (err) {
            console.error('[SettingsStore] Failed to persist settings:', err);
            set({ settings: current });
        }
    },

    pickAndSetFolder: async (settingKey) => {
        try {
            const selected = await engineApi.pickFolder();
            if (selected) {
                await get().updateSetting(settingKey, selected as AppSettings[typeof settingKey]);
            }
            return selected;
        } catch (err) {
            console.error('[SettingsStore] Folder pick failed:', err);
            return null;
        }
    },
}));
