import type { AppSettings } from '@/shared/api/engine';
import { SettingRow } from './settingsPanelParts';
import { chipStyle, inputStyle, sliderStyle } from './settingsPanelStyles';

interface AppearanceAdvancedProps {
    settings: AppSettings;
    draftShade: number;
    setDraftShade: (value: number) => void;
    draftTintPercent: number;
    setDraftTintPercent: (value: number) => void;
    draftForestCanopyPercent: number;
    setDraftForestCanopyPercent: (value: number) => void;
    draftForestFogPercent: number;
    setDraftForestFogPercent: (value: number) => void;
    draftLightTexturePercent: number;
    setDraftLightTexturePercent: (value: number) => void;
    clamp: (value: number, min: number, max: number) => number;
    updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
    resetDarkTuning: () => void;
}

export function AppearanceAdvancedControls(props: AppearanceAdvancedProps) {
    const {
        settings,
        draftShade,
        setDraftShade,
        draftForestCanopyPercent,
        setDraftForestCanopyPercent,
        draftForestFogPercent,
        setDraftForestFogPercent,
        draftLightTexturePercent,
        setDraftLightTexturePercent,
        clamp,
        updateSetting,
        resetDarkTuning,
    } = props;

    return (
        <>
            {settings.theme === 'dark' && (
                <>
                    <SettingRow label="Brightness">
                        <input
                            type="range"
                            min={0}
                            max={255}
                            step={1}
                            value={draftShade}
                            onChange={(e) => setDraftShade(clamp(parseInt(e.target.value, 10) || 0, 0, 255))}
                            onMouseUp={() => updateSetting('darkThemeShade', draftShade)}
                            onTouchEnd={() => updateSetting('darkThemeShade', draftShade)}
                            style={sliderStyle}
                        />
                        <input
                            type="number"
                            min={0}
                            max={255}
                            step={1}
                            value={draftShade}
                            onChange={(e) => setDraftShade(clamp(parseInt(e.target.value, 10) || 0, 0, 255))}
                            onBlur={() => updateSetting('darkThemeShade', draftShade)}
                            style={inputStyle}
                        />
                    </SettingRow>
                    <SettingRow label="Dark Tuning">
                        <button
                            onClick={resetDarkTuning}
                            style={{
                                ...chipStyle,
                                background: 'var(--color-bg-elevated)',
                                color: 'var(--color-text-secondary)',
                            }}
                        >
                            Reset
                        </button>
                    </SettingRow>
                </>
            )}
            {settings.theme === 'forest' && (
                <>
                    <SettingRow label="Forest Canopy Intensity (%)">
                        <input
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            value={draftForestCanopyPercent}
                            onChange={(e) => setDraftForestCanopyPercent(clamp(parseInt(e.target.value, 10) || 0, 0, 100))}
                            onMouseUp={() => updateSetting('forestThemeCanopyPercent', draftForestCanopyPercent)}
                            onTouchEnd={() => updateSetting('forestThemeCanopyPercent', draftForestCanopyPercent)}
                            style={sliderStyle}
                        />
                        <span style={{ minWidth: 42, textAlign: 'right', fontFamily: 'var(--font-role-data)', color: 'var(--color-text-secondary)' }}>{draftForestCanopyPercent}%</span>
                    </SettingRow>
                    <SettingRow label="Forest Fog Intensity (%)">
                        <input
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            value={draftForestFogPercent}
                            onChange={(e) => setDraftForestFogPercent(clamp(parseInt(e.target.value, 10) || 0, 0, 100))}
                            onMouseUp={() => updateSetting('forestThemeFogPercent', draftForestFogPercent)}
                            onTouchEnd={() => updateSetting('forestThemeFogPercent', draftForestFogPercent)}
                            style={sliderStyle}
                        />
                        <span style={{ minWidth: 42, textAlign: 'right', fontFamily: 'var(--font-role-data)', color: 'var(--color-text-secondary)' }}>{draftForestFogPercent}%</span>
                    </SettingRow>
                </>
            )}
            {settings.theme === 'light' && (
                <SettingRow label="Light Texture Intensity (%)">
                    <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={draftLightTexturePercent}
                        onChange={(e) => setDraftLightTexturePercent(clamp(parseInt(e.target.value, 10) || 0, 0, 100))}
                        onMouseUp={() => updateSetting('lightThemeTexturePercent', draftLightTexturePercent)}
                        onTouchEnd={() => updateSetting('lightThemeTexturePercent', draftLightTexturePercent)}
                        style={{ width: 180 }}
                    />
                    <span style={{ minWidth: 42, textAlign: 'right', fontFamily: 'var(--font-role-data)', color: 'var(--color-text-secondary)' }}>{draftLightTexturePercent}%</span>
                </SettingRow>
            )}
        </>
    );
}
