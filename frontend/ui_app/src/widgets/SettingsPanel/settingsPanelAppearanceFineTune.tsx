import type { AppSettings } from '@/shared/api/engine';
import { SettingRow } from './settingsPanelParts';
import { chipStyle, inputStyle, valueStyle, sliderStyle } from './settingsPanelStyles';

interface AppearanceFineTuneProps {
    settings: AppSettings;
    draftShade: number;
    draftForestCanopyPercent: number;
    draftForestFogPercent: number;
    draftLightTexturePercent: number;
    draftThemeDetailPercent: number;
    draftThemePanelsDetailPercent: number;
    draftThemeTimelineDetailPercent: number;
    clamp: (value: number, min: number, max: number) => number;
    setDraftShade: (value: number) => void;
    setDraftForestCanopyPercent: (value: number) => void;
    setDraftForestFogPercent: (value: number) => void;
    setDraftLightTexturePercent: (value: number) => void;
    setDraftThemeDetailPercent: (value: number) => void;
    setDraftThemePanelsDetailPercent: (value: number) => void;
    setDraftThemeTimelineDetailPercent: (value: number) => void;
    resetDarkTuning: () => void;
    updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export function AppearanceFineTune({
    settings,
    draftShade,
    draftForestCanopyPercent,
    draftForestFogPercent,
    draftLightTexturePercent,
    draftThemeDetailPercent,
    draftThemePanelsDetailPercent,
    draftThemeTimelineDetailPercent,
    clamp,
    setDraftShade,
    setDraftForestCanopyPercent,
    setDraftForestFogPercent,
    setDraftLightTexturePercent,
    setDraftThemeDetailPercent,
    setDraftThemePanelsDetailPercent,
    setDraftThemeTimelineDetailPercent,
    resetDarkTuning,
    updateSetting,
}: AppearanceFineTuneProps) {
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
            <SettingRow label="Theme Detail Intensity (%)">
                <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={draftThemeDetailPercent}
                    onChange={(e) => setDraftThemeDetailPercent(clamp(parseInt(e.target.value, 10) || 0, 0, 100))}
                    onMouseUp={() => updateSetting('themeDetailPercent', draftThemeDetailPercent)}
                    onTouchEnd={() => updateSetting('themeDetailPercent', draftThemeDetailPercent)}
                    style={{ width: 180 }}
                />
                <span style={valueStyle}>{draftThemeDetailPercent}%</span>
            </SettingRow>
            <SettingRow label="Panels Detail (%)">
                <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={draftThemePanelsDetailPercent}
                    onChange={(e) => setDraftThemePanelsDetailPercent(clamp(parseInt(e.target.value, 10) || 0, 0, 100))}
                    onMouseUp={() => updateSetting('themePanelsDetailPercent', draftThemePanelsDetailPercent)}
                    onTouchEnd={() => updateSetting('themePanelsDetailPercent', draftThemePanelsDetailPercent)}
                    style={{ width: 180 }}
                />
                <span style={valueStyle}>{draftThemePanelsDetailPercent}%</span>
            </SettingRow>
            <SettingRow label="Timeline Detail (%)">
                <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={draftThemeTimelineDetailPercent}
                    onChange={(e) => setDraftThemeTimelineDetailPercent(clamp(parseInt(e.target.value, 10) || 0, 0, 100))}
                    onMouseUp={() => updateSetting('themeTimelineDetailPercent', draftThemeTimelineDetailPercent)}
                    onTouchEnd={() => updateSetting('themeTimelineDetailPercent', draftThemeTimelineDetailPercent)}
                    style={{ width: 180 }}
                />
                <span style={valueStyle}>{draftThemeTimelineDetailPercent}%</span>
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
        </>
    );
}
