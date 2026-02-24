import type { AppSettings } from '@/shared/api/engine';

const cssRgb = (r: number, g: number, b: number): string => `rgb(${r}, ${g}, ${b})`;
const cssGradient = (top: [number, number, number], bottom: [number, number, number]): string =>
    `linear-gradient(180deg, ${cssRgb(...top)} 0%, ${cssRgb(...bottom)} 100%)`;

export const THEME_PRESETS = [
    { label: 'Dark Clean', theme: 'dark', darkThemeShade: 0, darkThemeTintPercent: 0, forestThemeCanopyPercent: 100, forestThemeFogPercent: 100, lightThemeTexturePercent: 72, themeDetailPercent: 90, themeMotionEnabled: true, themeMotionPercent: 85 },
    { label: 'Dark Graphite', theme: 'dark', darkThemeShade: 96, darkThemeTintPercent: 16, forestThemeCanopyPercent: 100, forestThemeFogPercent: 100, lightThemeTexturePercent: 72, themeDetailPercent: 100, themeMotionEnabled: true, themeMotionPercent: 100 },
    { label: 'Forest Moss', theme: 'forest', darkThemeShade: 0, darkThemeTintPercent: 0, forestThemeCanopyPercent: 92, forestThemeFogPercent: 82, lightThemeTexturePercent: 72, themeDetailPercent: 100, themeMotionEnabled: true, themeMotionPercent: 84 },
    { label: 'Forest Pine', theme: 'forest', darkThemeShade: 0, darkThemeTintPercent: 0, forestThemeCanopyPercent: 100, forestThemeFogPercent: 100, lightThemeTexturePercent: 72, themeDetailPercent: 100, themeMotionEnabled: true, themeMotionPercent: 100 },
    { label: 'Light Studio', theme: 'light', darkThemeShade: 0, darkThemeTintPercent: 0, forestThemeCanopyPercent: 100, forestThemeFogPercent: 100, lightThemeTexturePercent: 72, themeDetailPercent: 92, themeMotionEnabled: true, themeMotionPercent: 68 },
] as const;

export const THEME_PRESET_LABELS = THEME_PRESETS.map((preset) => preset.label);

export const ATMOSPHERE_PROFILES = [
    {
        label: 'Balanced',
        themeDetailPercent: 90,
        themePanelsDetailPercent: 90,
        themeTimelineDetailPercent: 82,
        themeOverlayEnabled: true,
        themePanelsOrnamentsEnabled: true,
        themeTimelineOrnamentsEnabled: true,
        themeMotionEnabled: true,
        themeMotionPercent: 82,
    },
    {
        label: 'Cinematic',
        themeDetailPercent: 100,
        themePanelsDetailPercent: 100,
        themeTimelineDetailPercent: 100,
        themeOverlayEnabled: true,
        themePanelsOrnamentsEnabled: true,
        themeTimelineOrnamentsEnabled: true,
        themeMotionEnabled: true,
        themeMotionPercent: 100,
    },
    {
        label: 'Studio',
        themeDetailPercent: 78,
        themePanelsDetailPercent: 86,
        themeTimelineDetailPercent: 58,
        themeOverlayEnabled: false,
        themePanelsOrnamentsEnabled: true,
        themeTimelineOrnamentsEnabled: false,
        themeMotionEnabled: false,
        themeMotionPercent: 0,
    },
    {
        label: 'Minimal',
        themeDetailPercent: 52,
        themePanelsDetailPercent: 38,
        themeTimelineDetailPercent: 22,
        themeOverlayEnabled: false,
        themePanelsOrnamentsEnabled: false,
        themeTimelineOrnamentsEnabled: false,
        themeMotionEnabled: false,
        themeMotionPercent: 0,
    },
] as const;

export const ATMOSPHERE_PROFILE_LABELS = ATMOSPHERE_PROFILES.map((profile) => profile.label);

export function findThemePreset(label: string) {
    return THEME_PRESETS.find((preset) => preset.label === label) ?? null;
}

export function applyThemePreset(settings: AppSettings, preset: (typeof THEME_PRESETS)[number]): AppSettings {
    return {
        ...settings,
        theme: preset.theme,
        darkThemeShade: preset.darkThemeShade,
        darkThemeTintPercent: preset.darkThemeTintPercent,
        forestThemeCanopyPercent: preset.forestThemeCanopyPercent,
        forestThemeFogPercent: preset.forestThemeFogPercent,
        lightThemeTexturePercent: preset.lightThemeTexturePercent,
        themeDetailPercent: preset.themeDetailPercent,
        themeMotionEnabled: preset.themeMotionEnabled,
        themeMotionPercent: preset.themeMotionPercent,
    };
}

export function findAtmosphereProfile(label: string) {
    return ATMOSPHERE_PROFILES.find((profile) => profile.label === label) ?? null;
}

export function applyAtmosphereProfile(settings: AppSettings, profile: (typeof ATMOSPHERE_PROFILES)[number]): AppSettings {
    return {
        ...settings,
        themeAtmosphereProfile: profile.label,
        themeDetailPercent: profile.themeDetailPercent,
        themePanelsDetailPercent: profile.themePanelsDetailPercent,
        themeTimelineDetailPercent: profile.themeTimelineDetailPercent,
        themeOverlayEnabled: profile.themeOverlayEnabled,
        themePanelsOrnamentsEnabled: profile.themePanelsOrnamentsEnabled,
        themeTimelineOrnamentsEnabled: profile.themeTimelineOrnamentsEnabled,
        themeMotionEnabled: profile.themeMotionEnabled,
        themeMotionPercent: profile.themeMotionPercent,
    };
}

export function resolveThemePresetLabel(settings: AppSettings): string {
    const isDarkGraphite = settings.theme === 'dark' && settings.darkThemeShade === 96 && settings.darkThemeTintPercent === 16;
    const isForestMoss = settings.theme === 'forest' && settings.forestThemeCanopyPercent === 92 && settings.forestThemeFogPercent === 82;
    if (settings.theme === 'dark') return isDarkGraphite ? 'Dark Graphite' : 'Dark Clean';
    if (settings.theme === 'forest') return isForestMoss ? 'Forest Moss' : 'Forest Pine';
    return 'Light Studio';
}

export const THEME_STUDIO_PREVIEWS: Record<(typeof THEME_PRESETS)[number]['label'], { bg: string; accent: string; motif?: string; note: string }> = {
    'Dark Clean': {
        bg: cssGradient([28, 31, 36], [18, 20, 25]),
        accent: cssRgb(119, 166, 255),
        note: 'Neutral dark',
    },
    'Dark Graphite': {
        bg: cssGradient([36, 40, 47], [23, 27, 34]),
        accent: cssRgb(143, 176, 255),
        note: 'Graphite contrast',
    },
    'Forest Moss': {
        bg: cssGradient([21, 49, 36], [13, 32, 24]),
        accent: cssRgb(125, 243, 173),
        motif: "url('/themes/forest-leaf-strip.svg')",
        note: 'Organic soft',
    },
    'Forest Pine': {
        bg: cssGradient([23, 56, 39], [11, 29, 20]),
        accent: cssRgb(150, 255, 209),
        motif: "url('/themes/forest-fireflies.svg')",
        note: 'Deep forest',
    },
    'Light Studio': {
        bg: cssGradient([212, 218, 225], [194, 201, 209]),
        accent: cssRgb(79, 121, 191),
        note: 'Clean gray',
    },
};
