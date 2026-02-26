import { useCallback, type CSSProperties } from 'react';
import type { AppSettings } from '@/shared/api/engine';
import { SettingRow, SettingsSection } from './settingsPanelParts';
import { titleStyle } from './settingsPanelStyles';

// ────────────────────────────────────────────────────────────────────────
// Format Group Definitions
// ────────────────────────────────────────────────────────────────────────

/** Each format group maps a canonical name to its file extensions. */
interface FormatGroup {
    /** Canonical lowercased name stored in browserExcludedFormats. */
    id: string;
    /** Display label shown in the UI. */
    label: string;
    /** File extensions belonging to this group. */
    extensions: string[];
}

const FORMAT_GROUPS: FormatGroup[] = [
    { id: 'wav', label: 'WAV', extensions: ['wav', 'wave'] },
    { id: 'aiff', label: 'AIFF', extensions: ['aiff', 'aif', 'aifc'] },
    { id: 'mp3', label: 'MP3', extensions: ['mp3'] },
    { id: 'flac', label: 'FLAC', extensions: ['flac'] },
    { id: 'ogg', label: 'OGG', extensions: ['ogg', 'oga', 'opus'] },
    { id: 'm4a', label: 'AAC / M4A', extensions: ['m4a', 'mp4', 'aac'] },
    { id: 'caf', label: 'CAF', extensions: ['caf'] },
    { id: 'wma', label: 'WMA', extensions: ['wma'] },
    { id: 'webm', label: 'WebM', extensions: ['webm'] },
];

// ────────────────────────────────────────────────────────────────────────
// Toggle Component
// ────────────────────────────────────────────────────────────────────────

const toggleTrackStyle: CSSProperties = {
    width: 38,
    height: 22,
    borderRadius: 11,
    cursor: 'pointer',
    border: 'none',
    display: 'flex',
    alignItems: 'center',
    padding: '0 3px',
    transition: 'background var(--transition-fast)',
    flexShrink: 0,
};

const toggleKnobStyle: CSSProperties = {
    width: 16,
    height: 16,
    borderRadius: '50%',
    background: '#fff',
    transition: 'transform var(--transition-fast)',
    boxShadow: '0 1px 3px rgba(0,0,0,.25)',
};

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
    return (
        <button
            type="button"
            onClick={() => onChange(!checked)}
            style={{
                ...toggleTrackStyle,
                background: checked ? 'var(--color-accent-primary)' : 'var(--color-bg-elevated)',
            }}
        >
            <div
                style={{
                    ...toggleKnobStyle,
                    transform: checked ? 'translateX(16px)' : 'translateX(0)',
                }}
            />
        </button>
    );
}

// ────────────────────────────────────────────────────────────────────────
// BrowserTab Component
// ────────────────────────────────────────────────────────────────────────

interface BrowserTabProps {
    settings: AppSettings;
    updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export function BrowserTab({ settings, updateSetting }: BrowserTabProps) {
    const excluded = settings.browserExcludedFormats ?? [];

    const isFormatEnabled = useCallback(
        (groupId: string) => !excluded.includes(groupId),
        [excluded],
    );

    const toggleFormat = useCallback(
        (groupId: string) => {
            const next = excluded.includes(groupId)
                ? excluded.filter((id) => id !== groupId)
                : [...excluded, groupId];
            updateSetting('browserExcludedFormats', next);
        },
        [excluded, updateSetting],
    );

    const enabledCount = FORMAT_GROUPS.length - excluded.length;

    return (
        <div>
            <h2 style={titleStyle}>Browser</h2>

            <SettingsSection
                title="Format Indexing"
                description={`Choose which audio formats to show in the file browser. ${enabledCount} of ${FORMAT_GROUPS.length} enabled.`}
            >
                {FORMAT_GROUPS.map((group) => (
                    <SettingRow key={group.id} label={group.label}>
                        <span
                            style={{
                                fontSize: 'var(--font-size-xs)',
                                color: 'var(--color-text-tertiary)',
                                fontFamily: 'var(--font-role-data)',
                                marginRight: 8,
                            }}
                        >
                            .{group.extensions.join(', .')}
                        </span>
                        <Toggle
                            checked={isFormatEnabled(group.id)}
                            onChange={() => toggleFormat(group.id)}
                        />
                    </SettingRow>
                ))}
            </SettingsSection>

            <SettingsSection
                title="Preview"
                description="Control audio preview behavior when selecting files."
            >
                <SettingRow label="Auto-Preview on Select">
                    <Toggle
                        checked={settings.browserAutoPreview ?? true}
                        onChange={(v) => updateSetting('browserAutoPreview', v)}
                    />
                </SettingRow>
            </SettingsSection>

            <SettingsSection
                title="Columns"
                description="Toggle visibility of file list columns."
            >
                <SettingRow label="Show Size Column">
                    <Toggle
                        checked={settings.browserShowSizeColumn}
                        onChange={(v) => updateSetting('browserShowSizeColumn', v)}
                    />
                </SettingRow>
                <SettingRow label="Show Type Column">
                    <Toggle
                        checked={settings.browserShowTypeColumn}
                        onChange={(v) => updateSetting('browserShowTypeColumn', v)}
                    />
                </SettingRow>
            </SettingsSection>
        </div>
    );
}
