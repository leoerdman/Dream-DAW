import { useMemo, useState } from 'react';
import type { AppSettings } from '@/shared/api/engine';
import { Select, SettingRow, SettingsSection, Toggle } from './settingsPanelParts';
import { titleStyle } from './settingsPanelStyles';
import { ALL_DIVISIONS, type GridDivision } from '@/shared/lib/gridSnap';
import { useGridStore } from '@/shared/stores/useGridStore';
import {
    APP_SCALE_OPTIONS,
    getAppScalePercent,
    getTimelineGridIntensityPercent,
    setAppScalePercent,
    setTimelineGridIntensityPercent,
} from '@/shared/lib/uiDisplayPrefs';

interface GeneralTabProps {
    settings: AppSettings;
    updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export function GeneralTab({ settings, updateSetting }: GeneralTabProps) {
    const gridDivision = useGridStore((s) => s.division);
    const gridTriplet = useGridStore((s) => s.triplet);
    const snapEnabled = useGridStore((s) => s.snapEnabled);
    const setGridDivision = useGridStore((s) => s.setDivision);
    const setTriplet = useGridStore((s) => s.setTriplet);
    const setSnapEnabled = useGridStore((s) => s.setSnapEnabled);

    const [appScale, setAppScale] = useState<number>(() => getAppScalePercent());
    const [gridIntensity, setGridIntensity] = useState<number>(() => getTimelineGridIntensityPercent());
    const [showAdvancedGrid, setShowAdvancedGrid] = useState<boolean>(true);
    const gridOptions = useMemo(() => ALL_DIVISIONS.map((d) => (d === 'ADAPTIVE' ? 'Adaptive' : d)), []);
    const gridDivisionLabel = gridDivision === 'ADAPTIVE' ? 'Adaptive' : gridDivision;

    return (
        <div>
            <h2 style={titleStyle}>General</h2>
            <SettingsSection title="Arrangement Grid" description="Default grid behavior for arrangement and edit actions.">
                <SettingRow label="Division">
                    <Select
                        value={gridDivisionLabel}
                        options={gridOptions}
                        onChange={(v) => {
                            const normalized = v === 'Adaptive' ? 'ADAPTIVE' : v;
                            setGridDivision(normalized as GridDivision);
                            updateSetting('arrangementGridDivision', normalized);
                        }}
                    />
                </SettingRow>
                <SettingRow label="Advanced Grid Settings">
                    <Toggle value={showAdvancedGrid} onChange={setShowAdvancedGrid} />
                </SettingRow>
                {showAdvancedGrid && (
                    <>
                    <SettingRow label="Triplet Grid">
                        <Toggle
                            value={gridTriplet}
                            onChange={(next) => {
                                setTriplet(next);
                                updateSetting('arrangementGridTriplet', next);
                            }}
                        />
                    </SettingRow>
                    <SettingRow label="Snap To Grid">
                        <Toggle
                            value={snapEnabled}
                            onChange={(next) => {
                                setSnapEnabled(next);
                                updateSetting('arrangementGridSnapEnabled', next);
                            }}
                        />
                    </SettingRow>
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
                    </>
                )}
            </SettingsSection>

            <SettingsSection title="Workspace" description="Language, startup behavior and overall app scaling.">
                <SettingRow label="Language">
                    <Select
                        value={settings.language}
                        options={['English', 'Русский', '日本語', '中文', 'Deutsch', 'Français', 'Español']}
                        onChange={(v) => updateSetting('language', v)}
                    />
                </SettingRow>
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
                <SettingRow label="On Startup">
                    <Select
                        value={settings.startupBehavior === 'new' ? 'Create New Project' : 'Open Last Project'}
                        options={['Create New Project', 'Open Last Project']}
                        onChange={(v) => updateSetting('startupBehavior', v.includes('New') ? 'new' : 'last')}
                    />
                </SettingRow>
            </SettingsSection>
        </div>
    );
}
