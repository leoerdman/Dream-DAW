import type { AppSettings } from '@/shared/api/engine';
import { SettingRow, Toggle } from './settingsPanelParts';
import { chipStyle, inputStyle, valueStyle, sliderStyle } from './settingsPanelStyles';

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
        draftTintPercent,
        setDraftTintPercent,
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
                    <SettingRow label="Dark Shade (0-255, 0 = black, 255 = white)">
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
                    <SettingRow label="Dark Tint Strength (%)">
                        <input
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            value={draftTintPercent}
                            onChange={(e) => setDraftTintPercent(clamp(parseInt(e.target.value, 10) || 0, 0, 100))}
                            onMouseUp={() => updateSetting('darkThemeTintPercent', draftTintPercent)}
                            onTouchEnd={() => updateSetting('darkThemeTintPercent', draftTintPercent)}
                            style={sliderStyle}
                        />
                        <span style={valueStyle}>{draftTintPercent}%</span>
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
                        <span style={valueStyle}>{draftForestCanopyPercent}%</span>
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
                        <span style={valueStyle}>{draftForestFogPercent}%</span>
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
                    <span style={valueStyle}>{draftLightTexturePercent}%</span>
                </SettingRow>
            )}
            <SettingRow label="Theme Motion">
                <Toggle value={settings.themeMotionEnabled} onChange={(v) => updateSetting('themeMotionEnabled', v)} />
            </SettingRow>
        </>
    );
}
