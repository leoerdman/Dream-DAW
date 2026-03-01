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

type FolderSettingKey = 'userFolderPath' | 'samplesPath' | 'vst2Path' | 'vst3Path';

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

    /** Open native folder picker dialog and update one of the folder path settings. */
    pickAndSetFolder: (settingKey: FolderSettingKey) => Promise<string | null>;
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
    browserExcludedFormats: [],
    browserAutoPreview: true,
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
            // Keep defaults
            set({ loaded: true });
        }
    },

    updateSetting: async (key, value) => {
        const current = get().settings;
        const updated = { ...current, [key]: value };

        // BUG-020 FIX: Await backend persistence BEFORE updating local state
        // to prevent data loss if the backend rejects or the app crashes.
        try {
            await engineApi.updateSettings(updated);
            set({ settings: updated });
        } catch (err) {
            console.error('[SettingsStore] Failed to persist setting:', key, err);
            throw err;
        }
    },

    updateAllSettings: async (newSettings) => {
        const merged = { ...DEFAULT_SETTINGS, ...newSettings };
        // BUG-020 FIX: Await backend persistence BEFORE updating local state
        try {
            await engineApi.updateSettings(merged);
            set({ settings: merged });
        } catch (err) {
            console.error('[SettingsStore] Failed to persist settings:', err);
            throw err;
        }
    },

    pickAndSetFolder: async (settingKey) => {
        try {
            const selected = await engineApi.pickFolder();
            if (selected) {
                await get().updateSetting(settingKey, selected);
            }
            return selected;
        } catch (err) {
            console.error('[SettingsStore] Folder pick failed:', err);
            return null;
        }
    },
}));
