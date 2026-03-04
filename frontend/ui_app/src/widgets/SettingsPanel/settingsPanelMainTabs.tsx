import { useState } from 'react';
import type { AppSettings } from '@/shared/api/engine';
import { Select, SettingRow, SettingsSection } from './settingsPanelParts';
import { chipStyle, titleStyle } from './settingsPanelStyles';
import {
    THEME_PRESETS,
    THEME_PRESET_LABELS,
    applyThemePreset,
    findThemePreset,
    resolveThemePresetLabel,
} from './settingsPanelThemeStudio';
import { AppearanceAdvancedControls } from './settingsPanelAppearanceAdvanced';
import { ThemeControlsSection } from './ThemeControlsSection';
import {
    APP_SCALE_OPTIONS,
    getAppScalePercent,
    getTimelineGridIntensityPercent,
    setAppScalePercent,
    setTimelineGridIntensityPercent,
} from '@/shared/lib/uiDisplayPrefs';

interface AppearanceTabProps {
    settings: AppSettings;
    updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
    updateAllSettings: (newSettings: AppSettings) => void;
}

export function AppearanceTab({ settings, updateSetting, updateAllSettings }: AppearanceTabProps) {
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

    // Theme tuning states
    const [draftShade, setDraftShade] = useState(settings.darkThemeShade);
    const [draftTintPercent, setDraftTintPercent] = useState(settings.darkThemeTintPercent);
    const [draftForestCanopyPercent, setDraftForestCanopyPercent] = useState(settings.forestThemeCanopyPercent);
    const [draftForestFogPercent, setDraftForestFogPercent] = useState(settings.forestThemeFogPercent);
    const [draftLightTexturePercent, setDraftLightTexturePercent] = useState(settings.lightThemeTexturePercent);

    // Scaling and grid intensity states
    const [appScale, setAppScale] = useState<number>(() => getAppScalePercent());
    const [gridIntensity, setGridIntensity] = useState<number>(() => getTimelineGridIntensityPercent());

    const applyPreset = (preset: (typeof THEME_PRESETS)[number]) => {
        const next = applyThemePreset(settings, preset);
        updateAllSettings(next);
        setDraftShade(next.darkThemeShade);
        setDraftTintPercent(next.darkThemeTintPercent);
        setDraftForestCanopyPercent(next.forestThemeCanopyPercent);
        setDraftForestFogPercent(next.forestThemeFogPercent);
        setDraftLightTexturePercent(next.lightThemeTexturePercent);
    };
    const resetDarkTuning = () => {
        const next = {
            ...settings,
            darkThemeShade: 0,
            darkThemeTintPercent: 0,
        };
        updateAllSettings(next);
        setDraftShade(next.darkThemeShade);
        setDraftTintPercent(next.darkThemeTintPercent);
    };
    const selectedThemeOption = resolveThemePresetLabel(settings);

    return (
        <div>
            <h2 style={titleStyle}>Appearance</h2>
            <SettingsSection title="Theme Studio" description="Theme family and basic preset selection.">
                <ThemeControlsSection
                    selectedThemeOption={selectedThemeOption}
                    themePresetLabels={THEME_PRESET_LABELS}
                    selectThemePreset={(label) => {
                        const preset = findThemePreset(label);
                        if (preset) applyPreset(preset);
                    }}
                />
            </SettingsSection>

            <SettingsSection title="Appearance Tuning" description="Fine-tune theme overlays and brightness.">
                <AppearanceAdvancedControls
                    settings={settings}
                    draftShade={draftShade}
                    setDraftShade={setDraftShade}
                    draftTintPercent={draftTintPercent}
                    setDraftTintPercent={setDraftTintPercent}
                    draftForestCanopyPercent={draftForestCanopyPercent}
                    setDraftForestCanopyPercent={setDraftForestCanopyPercent}
                    draftForestFogPercent={draftForestFogPercent}
                    setDraftForestFogPercent={setDraftForestFogPercent}
                    draftLightTexturePercent={draftLightTexturePercent}
                    setDraftLightTexturePercent={setDraftLightTexturePercent}
                    clamp={clamp}
                    updateSetting={updateSetting}
                    resetDarkTuning={resetDarkTuning}
                />
            </SettingsSection>

            <SettingsSection title="Timeline" description="Grid and waveform display settings.">
                <SettingRow label="Grid Intensity">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                            type="range"
                            min={50}
                            max={150}
                            step={5}
                            value={gridIntensity}
                            onChange={(e) => {
                                const next = Number.parseInt(e.target.value, 10);
                                const applied = setTimelineGridIntensityPercent(next);
                                setGridIntensity(applied);
                            }}
                            style={{ width: 120 }}
                        />
                        <span style={{ minWidth: 42, textAlign: 'right', fontFamily: 'var(--font-role-data)', color: 'var(--color-text-secondary)' }}>
                            {gridIntensity}%
                        </span>
                    </div>
                </SettingRow>
                <SettingRow label="Waveform Style">
                    <div style={{ display: 'flex', gap: 8 }}>
                        {(['colored', 'classic'] as const).map((styleKey) => (
                            <button
                                key={styleKey}
                                onClick={() => updateSetting('waveformStyle', styleKey)}
                                style={{
                                    ...chipStyle,
                                    background: settings.waveformStyle === styleKey ? 'var(--color-accent-primary)' : 'var(--color-bg-elevated)',
                                    color: settings.waveformStyle === styleKey ? 'var(--color-text-on-accent)' : 'var(--color-text-secondary)',
                                }}
                            >
                                {styleKey === 'colored' ? 'Colored' : 'Classic Black'}
                            </button>
                        ))}
                    </div>
                </SettingRow>
            </SettingsSection>

            <SettingsSection title="Display" description="Application scaling.">
                <SettingRow label="Application Scale">
                    <Select
                        value={`${appScale}%`}
                        options={APP_SCALE_OPTIONS.map((v) => `${v}%`)}
                        onChange={(v) => {
                            const parsed = Number.parseInt(v.replace('%', ''), 10);
                            const applied = setAppScalePercent(parsed);
                            setAppScale(applied);
                        }}
                    />
                </SettingRow>
            </SettingsSection>
        </div>
    );
}
