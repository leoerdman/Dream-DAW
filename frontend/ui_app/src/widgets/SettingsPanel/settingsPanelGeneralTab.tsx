import { useMemo, useState } from 'react';
import type { AppSettings } from '@/shared/api/engine';
import { Select, SettingRow, SettingsSection, Toggle } from './settingsPanelParts';
import { titleStyle } from './settingsPanelStyles';
import { ALL_DIVISIONS, type GridDivision } from '@/shared/lib/gridSnap';
import { useGridStore } from '@/shared/stores/useGridStore';

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
                <SettingRow label="On Startup">
                    <Select
                        value={settings.startupBehavior === 'new' ? 'Create New Project' : 'Open Last Project'}
                        options={['Create New Project', 'Open Last Project']}
                        onChange={(v) => updateSetting('startupBehavior', v.includes('New') ? 'new' : 'last')}
                    />
                </SettingRow>
            </SettingsSection>

            <SettingsSection title="Auto-Save" description="Automatically save your project at regular intervals to prevent data loss.">
                <SettingRow label="Enable Auto-Save">
                    <Toggle
                        value={settings.autoSaveEnabled ?? true}
                        onChange={(next) => updateSetting('autoSaveEnabled', next)}
                    />
                </SettingRow>
                {(settings.autoSaveEnabled ?? true) && (
                    <SettingRow label="Save Interval">
                        <Select
                            value={`${settings.autoSaveIntervalMinutes ?? 3} min`}
                            options={['1 min', '2 min', '3 min', '5 min', '10 min', '15 min']}
                            onChange={(v) => {
                                const minutes = parseInt(v, 10);
                                if (Number.isFinite(minutes) && minutes > 0) {
                                    updateSetting('autoSaveIntervalMinutes', minutes);
                                }
                            }}
                        />
                    </SettingRow>
                )}
            </SettingsSection>
        </div>
    );
}
