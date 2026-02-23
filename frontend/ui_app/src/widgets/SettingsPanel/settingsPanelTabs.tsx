import * as engine from '@/shared/api/engine';
import type { AppSettings } from '@/shared/api/engine';
import {
    actionBtnStyle,
    chipStyle,
    dividerStyle,
    FolderRow,
    inputStyle,
    SettingRow,
    titleStyle,
    valueStyle,
} from './settingsPanelParts';

interface FoldersTabProps {
    settings: AppSettings;
    pickAndSetFolder: (key: keyof AppSettings) => void;
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
            <FolderRow label="User Folder" path={settings.userFolderPath} onBrowse={() => pickAndSetFolder('userFolderPath')} />
            <FolderRow label="Samples Library" path={settings.samplesPath} onBrowse={() => pickAndSetFolder('samplesPath')} />
            <FolderRow label="VST2 Plugins" path={settings.vst2Path} onBrowse={() => pickAndSetFolder('vst2Path')} />
            <FolderRow label="VST3 Plugins" path={settings.vst3Path} onBrowse={() => pickAndSetFolder('vst3Path')} />
            <div style={dividerStyle} />
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button onClick={handleRescan} style={actionBtnStyle} disabled={rescanningPlugins}>
                    {rescanningPlugins ? '⏳ Scanning…' : '🔄 Rescan Plugins'}
                </button>
            </div>
            {rescanResult && (
                <div style={{ marginTop: 8, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                    {rescanResult}
                </div>
            )}
        </div>
    );
}

interface MidiTabProps {
    midiLoading: boolean;
    midiInputs: engine.MidiInputPort[];
    midiConnecting: string | null;
    connectMidiInput: (name: string) => Promise<void>;
    settings: AppSettings;
    updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export function MidiTab({
    midiLoading,
    midiInputs,
    midiConnecting,
    connectMidiInput,
    settings,
    updateSetting,
}: MidiTabProps) {
    return (
        <div>
            <h2 style={titleStyle}>MIDI</h2>
            <SettingRow label="MIDI Inputs">
                {midiLoading ? (
                    <span style={valueStyle}>Scanning…</span>
                ) : midiInputs.length === 0 ? (
                    <span style={valueStyle}>No MIDI devices found</span>
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
            <div style={dividerStyle} />
            <SettingRow label="OpenRouter API Key">
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
            <div style={{ ...valueStyle, marginTop: 6 }}>Used by MIDI Clip Editor AI variation.</div>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
                <div style={{ width: 64, height: 64, borderRadius: 'var(--radius-xl)', background: 'var(--gradient-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--font-size-3xl)', color: 'var(--color-text-on-accent)', fontWeight: 'var(--font-weight-extrabold)' as unknown as number }}>
                    D
                </div>
                <div>
                    <div style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 'var(--font-weight-bold)' as unknown as number }}>Dream DAW</div>
                    <div style={{ fontSize: 'var(--font-size-base)', color: 'var(--color-text-tertiary)' }}>Version {__APP_VERSION__}</div>
                    <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-tertiary)' }}>© 2025-2026 Dream DAW Team</div>
                </div>
            </div>
            <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-bold)' as unknown as number, color: 'var(--color-text-tertiary)', marginBottom: 8, letterSpacing: '0.04em' }}>
                VERSION HISTORY
            </div>
            {VERSION_HISTORY.map((entry) => (
                <div key={entry.version} style={{ marginBottom: 16 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                        <span style={{ fontSize: 'var(--font-size-base)', fontWeight: 'var(--font-weight-bold)' as unknown as number, color: 'var(--color-accent-primary)' }}>{entry.version}</span>
                        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>— {entry.date}</span>
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 16, fontSize: 'var(--font-size-sm)', lineHeight: 1.7, color: 'var(--color-text-secondary)' }}>
                        {entry.changes.map((c, i) => <li key={i}>{c}</li>)}
                    </ul>
                </div>
            ))}
        </div>
    );
}
