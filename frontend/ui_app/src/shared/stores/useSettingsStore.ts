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
import { useStatusStore } from '@/shared/stores/useStatusStore';

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
     * BUG-050: Narrowed to string-valued keys only — eliminates unsafe `as` cast.
     * Returns the selected path, or null if cancelled.
     */
    pickAndSetFolder: (settingKey: { [K in keyof AppSettings]: AppSettings[K] extends string ? K : never }[keyof AppSettings]) => Promise<string | null>;
}

/** Default settings — used before backend loads. Must match Rust defaults. */
const DEFAULT_SETTINGS: AppSettings = {
    language: 'English',
    startupBehavior: 'new',
    theme: 'dark',
    darkThemeShade: 0,
    darkThemeTintPercent: 0,
    forestThemeCanopyPercent: 100,
    forestThemeFogPercent: 100,
    lightThemeTexturePercent: 56,
    themeDetailPercent: 100,
    themePanelsDetailPercent: 100,
    themeTimelineDetailPercent: 100,
    themeMotionEnabled: true,
    themeMotionPercent: 100,
    themeOverlayEnabled: true,
    themePanelsOrnamentsEnabled: true,
    themeTimelineOrnamentsEnabled: true,
    themeAtmosphereProfile: 'Balanced',
    favoriteThemePreset: 'Dark Clean',
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
    browserExcludedFormats: ['asd'],
    browserAutoPreview: true,
    autoSaveEnabled: true,
    autoSaveIntervalMinutes: 3,
};

export const useSettingsStore = create<SettingsStore>((set, get) => ({
    settings: DEFAULT_SETTINGS,
    loaded: false,

    loadSettings: async () => {
        try {
            const settings = await engineApi.getSettings();
            // Merge with defaults so newly added settings keys never become undefined
            // when loading older persisted payloads.
            set({ settings: { ...DEFAULT_SETTINGS, ...settings }, loaded: true });
        } catch (err) {
            console.error('[SettingsStore] Failed to load settings:', err);
            useStatusStore.getState().setError('Failed to load application settings');
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
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[SettingsStore] Failed to persist setting:', key, err);
            useStatusStore.getState().setError(`Failed to save setting "${String(key)}": ${msg}`);
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
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[SettingsStore] Failed to persist settings:', err);
            useStatusStore.getState().setError(`Failed to save settings: ${msg}`);
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
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[SettingsStore] Folder pick failed:', err);
            useStatusStore.getState().setError(`Folder selection failed: ${msg}`);
            return null;
        }
    },
}));
