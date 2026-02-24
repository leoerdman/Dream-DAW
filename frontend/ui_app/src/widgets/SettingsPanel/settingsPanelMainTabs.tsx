import { useState } from 'react';
import type { AppSettings } from '@/shared/api/engine';
import { SettingRow, SettingsSection, Toggle } from './settingsPanelParts';
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

interface AppearanceTabProps {
    settings: AppSettings;
    updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
    updateAllSettings: (newSettings: AppSettings) => void;
}

export function AppearanceTab({ settings, updateSetting, updateAllSettings }: AppearanceTabProps) {
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [draftShade, setDraftShade] = useState(settings.darkThemeShade);
    const [draftTintPercent, setDraftTintPercent] = useState(settings.darkThemeTintPercent);
    const [draftForestCanopyPercent, setDraftForestCanopyPercent] = useState(settings.forestThemeCanopyPercent);
    const [draftForestFogPercent, setDraftForestFogPercent] = useState(settings.forestThemeFogPercent);
    const [draftLightTexturePercent, setDraftLightTexturePercent] = useState(settings.lightThemeTexturePercent);

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
            <SettingsSection title="Theme Studio" description="Theme family, style tuning and visual mode controls.">
                <ThemeControlsSection
                    selectedThemeOption={selectedThemeOption}
                    themePresetLabels={THEME_PRESET_LABELS}
                    selectThemePreset={(label) => {
                        const preset = findThemePreset(label);
                        if (preset) applyPreset(preset);
                    }}
                />
                <SettingRow label="Advanced">
                    <Toggle value={showAdvanced} onChange={setShowAdvanced} />
                </SettingRow>
            </SettingsSection>
            {showAdvanced && (
                <SettingsSection title="Advanced Appearance" description="Fine-tune overlays, texture and waveform rendering style.">
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
            )}
        </div>
    );
}
