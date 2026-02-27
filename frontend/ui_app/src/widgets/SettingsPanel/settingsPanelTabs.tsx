import { useState } from 'react';
import * as engine from '@/shared/api/engine';
import type { AppSettings } from '@/shared/api/engine';
import { FolderRow, SettingRow, SettingsSection } from './settingsPanelParts';
import {
    actionBtnSmStyle,
    actionBtnStyle,
    chipStyle,
    inputStyle,
    titleStyle,
    valueStyle,
} from './settingsPanelStyles';
import {
    SHORTCUT_DEFINITIONS,
    type ShortcutActionId,
    comboFromKeyboardEvent,
} from '@/shared/lib/shortcutBindings';
import { useShortcutStore } from '@/shared/stores/useShortcutStore';

interface FoldersTabProps {
    settings: AppSettings;
    pickAndSetFolder: (key: 'userFolderPath' | 'samplesPath' | 'vst2Path' | 'vst3Path') => Promise<string | null>;
    handleRescan: () => void;
    rescanningPlugins: boolean;
    rescanResult: string | null;
}

export function FoldersTab({
    settings,
    pickAndSetFolder,
    handleRescan,
    rescanningPlugins,
    rescanResult,
}: FoldersTabProps) {
    return (
        <div>
            <h2 style={titleStyle}>Folders</h2>
            <SettingsSection title="Paths" description="Filesystem locations used by the browser and plugin scanner.">
                <FolderRow label="User Folder" path={settings.userFolderPath} onBrowse={() => pickAndSetFolder('userFolderPath')} />
                <FolderRow label="Samples Library" path={settings.samplesPath} onBrowse={() => pickAndSetFolder('samplesPath')} />
                <FolderRow label="VST2 Plugins" path={settings.vst2Path} onBrowse={() => pickAndSetFolder('vst2Path')} />
                <FolderRow label="VST3 Plugins" path={settings.vst3Path} onBrowse={() => pickAndSetFolder('vst3Path')} />
            </SettingsSection>
            <SettingsSection title="Plugin Discovery" description="Re-index plugin folders and update availability.">
                <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                    <button onClick={handleRescan} style={actionBtnStyle} disabled={rescanningPlugins}>
                        {rescanningPlugins ? '⏳ Scanning…' : '🔄 Rescan Plugins'}
                    </button>
                </div>
                {rescanResult && (
                    <div style={{ marginTop: 8, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                        {rescanResult}
                    </div>
                )}
            </SettingsSection>
        </div>
    );
}

interface MidiTabProps {
    midiLoading: boolean;
    midiInputs: engine.MidiInputPort[];
    midiConnecting: string | null;
    connectMidiInput: (name: string) => Promise<void>;
}

export function MidiTab({
    midiLoading,
    midiInputs,
    midiConnecting,
    connectMidiInput,
}: MidiTabProps) {
    return (
        <div>
            <h2 style={titleStyle}>Midi</h2>
            <SettingsSection title="Midi inputs" description="Connected keyboards and midi controllers.">
                <SettingRow label="Ports">
                    {midiLoading ? (
                        <span style={valueStyle}>Scanning…</span>
                    ) : midiInputs.length === 0 ? (
                        <span style={valueStyle}>No midi devices found</span>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
                            {midiInputs.map((port) => (
                                <div key={port.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                    <span style={{ ...valueStyle, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{port.name}</span>
                                    <button
                                        onClick={() => void connectMidiInput(port.name)}
                                        style={{
                                            ...chipStyle,
                                            minWidth: 88,
                                            background: port.connected ? 'var(--color-accent-primary)' : 'var(--color-bg-elevated)',
                                            color: port.connected ? 'var(--color-text-on-accent)' : 'var(--color-text-secondary)',
                                        }}
                                        disabled={midiConnecting === port.name}
                                    >
                                        {midiConnecting === port.name ? 'Connecting…' : port.connected ? 'Connected' : 'Connect'}
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </SettingRow>
            </SettingsSection>
        </div>
    );
}

interface AITabProps {
    settings: AppSettings;
    updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export function AITab({ settings, updateSetting }: AITabProps) {
    return (
        <div>
            <h2 style={titleStyle}>Ai</h2>
            <SettingsSection title="Provider" description="Model endpoint settings used by assistant features.">
                <SettingRow label="OpenRouter api key">
                    <input
                        type="password"
                        placeholder="sk-or-..."
                        value={settings.openRouterApiKey}
                        onChange={(e) => updateSetting('openRouterApiKey', e.target.value)}
                        style={{ ...inputStyle, width: 300 }}
                        autoComplete="off"
                        spellCheck={false}
                    />
                </SettingRow>
                <SettingRow label="OpenRouter Model">
                    <input
                        type="text"
                        placeholder="openai/gpt-4o-mini"
                        value={settings.openRouterModel}
                        onChange={(e) => updateSetting('openRouterModel', e.target.value)}
                        style={{ ...inputStyle, width: 300 }}
                        autoComplete="off"
                        spellCheck={false}
                    />
                </SettingRow>
                <div style={{ ...valueStyle, marginTop: 6 }}>Used by ai features, including midi clip editor variation.</div>
            </SettingsSection>
        </div>
    );
}

const VERSION_HISTORY = [
    {
        version: 'v1.2.0', date: 'Feb 2026', changes: [
            'Full Sampler UI Overhaul with Gain/Volume control',
            'Real-time parameter synchronization for Instruments',
            'Global Search (Command+F) with focus/clear logic',
            'High-precision audio engine synchronization (Mach timing)',
            'Optimized UI rendering for large arrangements',
        ],
    },
    {
        version: 'v1.1.0', date: 'Jan 2026', changes: [
            'Added VU meters to track headers',
            'Implemented Piano Roll editing and MIDI playback',
            'Added Sampler instrument with basic ADSR',
            'Multi-track playback support',
        ],
    },
    {
        version: 'v1.0.0', date: 'Dec 2025', changes: [
            'Initial release of Dream DAW',
            'Basic arrangement timeline with clip dragging',
            'Simple Synth instrument implementation',
            'Project save/load functionality',
        ],
    },
] as const;

export function AboutTab() {
    return (
        <div>
            <h2 style={titleStyle}>About Dream DAW</h2>
            <SettingsSection title="Build" description="Version and product identity.">
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    <div style={{ width: 64, height: 64, borderRadius: 'var(--radius-xl)', background: 'var(--gradient-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--font-size-3xl)', color: 'var(--color-text-on-accent)', fontWeight: 'var(--font-weight-extrabold)' }}>
                        D
                    </div>
                    <div>
                        <div style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 'var(--font-weight-bold)' }}>Dream DAW</div>
                        <div style={{ fontSize: 'var(--font-size-base)', color: 'var(--color-text-tertiary)' }}>Version {__APP_VERSION__}</div>
                        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-tertiary)' }}>© 2025-2026 Dream DAW Team</div>
                    </div>
                </div>
            </SettingsSection>

            <SettingsSection title="Version History">
                {VERSION_HISTORY.map((entry) => (
                    <div key={entry.version} style={{ marginBottom: 16 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                            <span style={{ fontSize: 'var(--font-size-base)', fontWeight: 'var(--font-weight-bold)', color: 'var(--color-accent-primary)' }}>{entry.version}</span>
                            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>— {entry.date}</span>
                        </div>
                        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 'var(--font-size-sm)', lineHeight: 1.7, color: 'var(--color-text-secondary)' }}>
                            {entry.changes.map((c, i) => <li key={i}>{c}</li>)}
                        </ul>
                    </div>
                ))}
            </SettingsSection>
        </div>
    );
}

export function ShortcutsTab() {
    const bindings = useShortcutStore((s) => s.bindings);
    const setBinding = useShortcutStore((s) => s.setBinding);
    const resetBinding = useShortcutStore((s) => s.resetBinding);
    const resetAll = useShortcutStore((s) => s.resetAll);
    const [recordingAction, setRecordingAction] = useState<ShortcutActionId | null>(null);

    return (
        <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <h2 style={{ ...titleStyle, marginBottom: 8 }}>Shortcuts</h2>
                <button style={actionBtnSmStyle} onClick={() => resetAll()}>
                    Reset All to Default
                </button>
            </div>
            <SettingsSection title="Keyboard Mappings" description="Click a shortcut cell, press a key combo, then Enter.">
                {SHORTCUT_DEFINITIONS.map((def) => {
                    const isRecording = recordingAction === def.id;
                    const value = bindings[def.id] ?? def.defaultCombo;
                    return (
                        <div
                            key={def.id}
                            style={{
                                display: 'grid',
                                gridTemplateColumns: '1fr auto auto',
                                gap: 8,
                                alignItems: 'center',
                                padding: 'var(--space-2) 0',
                                borderBottom: 'var(--space-px) solid var(--color-divider-light)',
                            }}
                        >
                            <div>
                                <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-text-primary)' }}>{def.label}</div>
                                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>{def.description}</div>
                            </div>
                            <button
                                style={{
                                    ...chipStyle,
                                    minWidth: 170,
                                    textAlign: 'center',
                                    background: isRecording ? 'var(--color-accent-primary)' : 'var(--color-bg-elevated)',
                                    color: isRecording ? 'var(--color-text-on-accent)' : 'var(--color-text-primary)',
                                    fontFamily: 'var(--font-role-data)',
                                    padding: 'var(--space-1) var(--space-2)',
                                }}
                                onClick={() => setRecordingAction(def.id)}
                                onKeyDown={(e) => {
                                    if (!isRecording) return;
                                    if (e.key === 'Escape') {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        setRecordingAction(null);
                                        return;
                                    }
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        setRecordingAction(null);
                                        return;
                                    }
                                    const combo = comboFromKeyboardEvent(e.nativeEvent);
                                    if (!combo || combo === 'Shift' || combo === 'Alt' || combo === 'Cmd' || combo === 'Ctrl') {
                                        return;
                                    }
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setBinding(def.id, combo);
                                }}
                            >
                                {isRecording ? 'Press keys...' : value}
                            </button>
                            <button style={actionBtnSmStyle} onClick={() => resetBinding(def.id)}>
                                Default
                            </button>
                        </div>
                    );
                })}
            </SettingsSection>
        </div>
    );
}
