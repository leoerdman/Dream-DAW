import { Select, SettingRow } from './settingsPanelParts';

interface ThemeControlsSectionProps {
    selectedThemeOption: string;
    themePresetLabels: readonly string[];
    selectThemePreset: (label: string) => void;
}

export function ThemeControlsSection({
    selectedThemeOption,
    themePresetLabels,
    selectThemePreset,
}: ThemeControlsSectionProps) {
    return (
        <SettingRow label="Theme">
            <Select
                value={selectedThemeOption}
                options={themePresetLabels}
                onChange={(label: string) => selectThemePreset(label)}
            />
        </SettingRow>
    );
}
