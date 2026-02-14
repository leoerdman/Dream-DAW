import { useState, useEffect, useCallback } from 'react';
import { useSettingsStore } from '@/shared/stores/useSettingsStore';
import * as engine from '@/shared/api/engine';

/**
 * SettingsPanel — 5-tab modal settings window.
 *
 * Ported 1:1 from SettingsWindowController.swift (692 lines) + AppSettings.swift (520 lines).
 *
 * Tabs: General | Appearance | Audio | Folders | About
 * Trigger: ⌘, or gear icon
 */

type SettingsTab = 'general' | 'appearance' | 'audio' | 'midi' | 'folders' | 'about';

interface SettingsPanelProps {
    isOpen: boolean;
    onClose: () => void;
}

export const SettingsPanel = ({ isOpen, onClose }: SettingsPanelProps) => {
    const [tab, setTab] = useState<SettingsTab>('general');
    const settings = useSettingsStore(s => s.settings);
    const updateSetting = useSettingsStore(s => s.updateSetting);
    const pickAndSetFolder = useSettingsStore(s => s.pickAndSetFolder);
    const [rescanningPlugins, setRescanningPlugins] = useState(false);

    // ── Audio Device Enumeration (real hardware from cpal) ──
    const [audioDevices, setAudioDevices] = useState<engine.AudioDevices>({ outputs: [], inputs: [] });
    const [devicesLoading, setDevicesLoading] = useState(false);
    const [restartingEngine, setRestartingEngine] = useState(false);
    const [midiInputs, setMidiInputs] = useState<engine.MidiInputPort[]>([]);
    const [midiLoading, setMidiLoading] = useState(false);
    const [midiConnecting, setMidiConnecting] = useState<string | null>(null);

    // Fetch real devices when Audio tab is opened
    useEffect(() => {
        if (tab !== 'audio') return;
        setDevicesLoading(true);
        engine.getAudioDevices()
            .then(devices => setAudioDevices(devices))
            .catch(err => console.error('[SettingsPanel] Failed to enumerate devices:', err))
            .finally(() => setDevicesLoading(false));
    }, [tab]);

    useEffect(() => {
        if (tab !== 'midi') return;
        setMidiLoading(true);
        engine.getMidiInputs()
            .then((ports) => setMidiInputs(ports))
            .catch((err) => console.error('[SettingsPanel] Failed to enumerate MIDI inputs:', err))
            .finally(() => setMidiLoading(false));
    }, [tab]);

    // ⌘, shortcut
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.metaKey && e.key === ',') {
                e.preventDefault();
                // toggle handled externally
            }
            if (e.key === 'Escape' && isOpen) {
                onClose();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [isOpen, onClose]);

    const handleRescan = useCallback(() => {
        setRescanningPlugins(true);
        setTimeout(() => setRescanningPlugins(false), 2500);
    }, []);

    if (!isOpen) return null;

    const TABS: { key: SettingsTab; label: string; icon: string }[] = [
        { key: 'general', label: 'General', icon: '⚙' },
        { key: 'appearance', label: 'Appearance', icon: '🎨' },
        { key: 'audio', label: 'Audio', icon: '🔊' },
        { key: 'midi', label: 'MIDI', icon: '🎹' },
        { key: 'folders', label: 'Folders', icon: '📁' },
        { key: 'about', label: 'About', icon: 'ℹ️' },
    ];

    const latencyMs = (settings.bufferSize / settings.sampleRate) * 1000;

    return (
        <div style={overlayStyle} onClick={onClose}>
            <div style={modalStyle} onClick={e => e.stopPropagation()}>
                {/* ── Sidebar ── */}
                <div style={sidebarStyle}>
                    <div style={{ padding: '16px 12px 8px', fontSize: 11, fontWeight: 700, opacity: 0.5, letterSpacing: '0.05em' }}>
                        SETTINGS
                    </div>
                    {TABS.map(t => (
                        <button
                            key={t.key}
                            onClick={() => setTab(t.key)}
                            style={{
                                ...tabBtnStyle,
                                background: tab === t.key ? 'var(--color-accent-primary)' : 'transparent',
                                color: tab === t.key ? '#fff' : 'var(--color-text-secondary)',
                            }}
                        >
                            <span style={{ fontSize: 14, width: 20, textAlign: 'center' }}>{t.icon}</span>
                            {t.label}
                        </button>
                    ))}
                </div>

                {/* ── Content ── */}
                <div style={contentStyle}>
                    {/* Close button */}
                    <button onClick={onClose} style={closeBtnStyle}>✕</button>

                    {tab === 'general' && (
                        <div>
                            <h2 style={titleStyle}>General</h2>
                            <SettingRow label="Language">
                                <Select
                                    value={settings.language}
                                    options={['English', 'Русский', '日本語', '中文', 'Deutsch', 'Français', 'Español']}
                                    onChange={v => updateSetting('language', v)}
                                />
                            </SettingRow>
                            <SettingRow label="On Startup">
                                <Select
                                    value={settings.startupBehavior === 'new' ? 'Create New Project' : 'Open Last Project'}
                                    options={['Create New Project', 'Open Last Project']}
                                    onChange={v => updateSetting('startupBehavior', v.includes('New') ? 'new' : 'last')}
                                />
                            </SettingRow>
                        </div>
                    )}

                    {tab === 'appearance' && (
                        <div>
                            <h2 style={titleStyle}>Appearance</h2>
                            <SettingRow label="Waveform Style">
                                <div style={{ display: 'flex', gap: 8 }}>
                                    {(['colored', 'classic'] as const).map(s => (
                                        <button
                                            key={s}
                                            onClick={() => updateSetting('waveformStyle', s)}
                                            style={{
                                                ...chipStyle,
                                                background: settings.waveformStyle === s ? 'var(--color-accent-primary)' : 'var(--color-bg-elevated)',
                                                color: settings.waveformStyle === s ? '#fff' : 'var(--color-text-secondary)',
                                            }}
                                        >
                                            {s === 'colored' ? 'Colored' : 'Classic Black'}
                                        </button>
                                    ))}
                                </div>
                            </SettingRow>
                        </div>
                    )}

                    {tab === 'audio' && (
                        <div>
                            <h2 style={titleStyle}>Audio</h2>
                            <SettingRow label="Driver Type">
                                <Select value={settings.driverType} options={['CoreAudio']} onChange={v => updateSetting('driverType', v)} />
                            </SettingRow>
                            <SettingRow label="Output Device">
                                <Select
                                    value={settings.outputDevice}
                                    options={audioDevices.outputs.length > 0 ? audioDevices.outputs : [settings.outputDevice]}
                                    onChange={async v => {
                                        updateSetting('outputDevice', v);
                                        setRestartingEngine(true);
                                        try {
                                            await engine.restartAudioEngine(v);
                                        } catch (err) {
                                            console.error('[SettingsPanel] restartAudioEngine failed:', err);
                                        } finally {
                                            setRestartingEngine(false);
                                        }
                                    }}
                                />
                                {devicesLoading && <span style={{ ...valueStyle, marginLeft: 4 }}>⏳</span>}
                                {restartingEngine && (
                                    <span style={{ ...valueStyle, marginLeft: 6 }}>Restarting Engine...</span>
                                )}
                            </SettingRow>
                            <SettingRow label="Input Device">
                                <Select
                                    value={settings.inputDevice}
                                    options={audioDevices.inputs.length > 0 ? audioDevices.inputs : [settings.inputDevice]}
                                    onChange={v => updateSetting('inputDevice', v)}
                                />
                                {devicesLoading && <span style={{ ...valueStyle, marginLeft: 4 }}>⏳</span>}
                            </SettingRow>
                            <SettingRow label="Sample Rate">
                                <Select
                                    value={`${settings.sampleRate} Hz`}
                                    options={['44100 Hz', '48000 Hz', '88200 Hz', '96000 Hz']}
                                    onChange={v => updateSetting('sampleRate', parseInt(v))}
                                />
                            </SettingRow>
                            <SettingRow label="Buffer Size">
                                <Select
                                    value={`${settings.bufferSize} samples`}
                                    options={['64 samples', '128 samples', '256 samples', '512 samples', '1024 samples', '2048 samples']}
                                    onChange={v => updateSetting('bufferSize', parseInt(v))}
                                />
                            </SettingRow>

                            <div style={dividerStyle} />

                            <SettingRow label="Input Latency">
                                <span style={valueStyle}>{latencyMs.toFixed(1)} ms</span>
                            </SettingRow>
                            <SettingRow label="Output Latency">
                                <span style={valueStyle}>{latencyMs.toFixed(1)} ms</span>
                            </SettingRow>
                            <SettingRow label="Overall Latency">
                                <span style={valueStyle}>{(latencyMs * 2).toFixed(1)} ms</span>
                            </SettingRow>
                            <SettingRow label="Driver Error Compensation">
                                <input
                                    type="number"
                                    value={settings.driverErrorCompensation}
                                    onChange={e => updateSetting('driverErrorCompensation', parseFloat(e.target.value) || 0)}
                                    style={inputStyle}
                                    step={0.1}
                                />
                                <span style={{ ...valueStyle, marginLeft: 4 }}>ms</span>
                            </SettingRow>

                            <div style={dividerStyle} />

                            <SettingRow label="Test Tone">
                                <Toggle value={settings.testToneEnabled} onChange={v => updateSetting('testToneEnabled', v)} />
                            </SettingRow>
                            {settings.testToneEnabled && (
                                <>
                                    <SettingRow label="Tone Volume">
                                        <input
                                            type="range"
                                            min={-60}
                                            max={0}
                                            value={settings.testToneVolume}
                                            onChange={e => updateSetting('testToneVolume', parseInt(e.target.value))}
                                            style={{ width: 120 }}
                                        />
                                        <span style={valueStyle}>{settings.testToneVolume} dB</span>
                                    </SettingRow>
                                    <SettingRow label="Frequency">
                                        <input
                                            type="number"
                                            value={settings.testToneFrequency}
                                            onChange={e => updateSetting('testToneFrequency', parseInt(e.target.value) || 440)}
                                            style={inputStyle}
                                        />
                                        <span style={{ ...valueStyle, marginLeft: 4 }}>Hz</span>
                                    </SettingRow>
                                </>
                            )}

                            <div style={dividerStyle} />

                            <SettingRow label="CPU Usage Simulator">
                                <Toggle value={settings.cpuUsageSimulator} onChange={v => updateSetting('cpuUsageSimulator', v)} />
                            </SettingRow>
                            <SettingRow label="High Quality SR/Pitch Conversion">
                                <Toggle value={settings.srPitchConversion} onChange={v => updateSetting('srPitchConversion', v)} />
                            </SettingRow>
                        </div>
                    )}

                    {tab === 'folders' && (
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
                        </div>
                    )}

                    {tab === 'midi' && (
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
                                            <div
                                                key={port.name}
                                                style={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'space-between',
                                                    gap: 8,
                                                }}
                                            >
                                                <span style={{ ...valueStyle, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                    {port.name}
                                                </span>
                                                <button
                                                    onClick={async () => {
                                                        setMidiConnecting(port.name);
                                                        try {
                                                            await engine.connectMidiInput(port.name);
                                                            const refreshed = await engine.getMidiInputs();
                                                            setMidiInputs(refreshed);
                                                        } catch (err) {
                                                            console.error('[SettingsPanel] connectMidiInput failed:', err);
                                                        } finally {
                                                            setMidiConnecting(null);
                                                        }
                                                    }}
                                                    style={{
                                                        ...chipStyle,
                                                        minWidth: 88,
                                                        background: port.connected ? 'var(--color-accent-primary)' : 'var(--color-bg-elevated)',
                                                        color: port.connected ? '#fff' : 'var(--color-text-secondary)',
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
                            <div style={{ ...valueStyle, marginTop: 6 }}>
                                Used by MIDI Clip Editor AI variation.
                            </div>
                        </div>
                    )}

                    {tab === 'about' && (
                        <div>
                            <h2 style={titleStyle}>About Dream DAW</h2>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
                                <div style={{
                                    width: 64, height: 64, borderRadius: 14,
                                    background: 'linear-gradient(135deg, #667eea, #764ba2)',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    fontSize: 28, color: '#fff', fontWeight: 800,
                                }}>
                                    D
                                </div>
                                <div>
                                    <div style={{ fontSize: 18, fontWeight: 700 }}>Dream DAW</div>
                                    <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Version {__APP_VERSION__}</div>
                                    <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>© 2025-2026 Dream DAW Team</div>
                                </div>
                            </div>

                            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-tertiary)', marginBottom: 8, letterSpacing: '0.04em' }}>
                                VERSION HISTORY
                            </div>

                            {[
                                {
                                    version: 'v1.2.0', date: 'Feb 2026', changes: [
                                        'Full Sampler UI Overhaul with Gain/Volume control',
                                        'Real-time parameter synchronization for Instruments',
                                        'Global Search (Command+F) with focus/clear logic',
                                        'High-precision audio engine synchronization (Mach timing)',
                                        'Optimized UI rendering for large arrangements',
                                    ]
                                },
                                {
                                    version: 'v1.1.0', date: 'Jan 2026', changes: [
                                        'Added VU meters to track headers',
                                        'Implemented Piano Roll editing and MIDI playback',
                                        'Added Sampler instrument with basic ADSR',
                                        'Multi-track playback support',
                                    ]
                                },
                                {
                                    version: 'v1.0.0', date: 'Dec 2025', changes: [
                                        'Initial release of Dream DAW',
                                        'Basic arrangement timeline with clip dragging',
                                        'Simple Synth instrument implementation',
                                        'Project save/load functionality',
                                    ]
                                },
                            ].map(entry => (
                                <div key={entry.version} style={{ marginBottom: 16 }}>
                                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                                        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-accent-primary)' }}>{entry.version}</span>
                                        <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>— {entry.date}</span>
                                    </div>
                                    <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, lineHeight: 1.7, color: 'var(--color-text-secondary)' }}>
                                        {entry.changes.map((c, i) => <li key={i}>{c}</li>)}
                                    </ul>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

// ── Reusable sub-components ──

const SettingRow = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 0', borderBottom: '1px solid var(--color-divider-light)',
    }}>
        <label style={{ fontSize: 12, color: 'var(--color-text-secondary)', fontWeight: 500 }}>{label}</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{children}</div>
    </div>
);

const FolderRow = ({ label, path, onBrowse }: { label: string; path: string; onBrowse?: () => void }) => (
    <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 0', borderBottom: '1px solid var(--color-divider-light)',
    }}>
        <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-primary)' }}>{label}</div>
            <div style={{
                fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 2,
                fontFamily: 'var(--font-mono)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{path}</div>
        </div>
        <button onClick={onBrowse} style={actionBtnSmStyle}>Browse…</button>
    </div>
);

const Select = ({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) => (
    <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={selectStyle}
    >
        {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
);

const Toggle = ({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) => (
    <button
        onClick={() => onChange(!value)}
        style={{
            width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer',
            background: value ? 'var(--color-accent-primary)' : 'var(--color-bg-elevated)',
            position: 'relative', transition: 'background 0.2s',
        }}
    >
        <div style={{
            width: 16, height: 16, borderRadius: '50%', background: '#fff',
            position: 'absolute', top: 2,
            left: value ? 18 : 2,
            transition: 'left 0.2s',
            boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
        }} />
    </button>
);

// ── Styles ──

const overlayStyle: React.CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: 'rgba(0,0,0,0.6)',
    backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
};

const modalStyle: React.CSSProperties = {
    width: 680, height: 720,
    background: 'var(--color-bg-surface)',
    borderRadius: 12, border: '1px solid var(--color-divider)',
    display: 'flex', overflow: 'hidden',
    boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
};

const sidebarStyle: React.CSSProperties = {
    width: 170, flexShrink: 0,
    background: 'var(--color-bg-sidebar)',
    borderRight: '1px solid var(--color-divider)',
    display: 'flex', flexDirection: 'column', gap: 2,
    padding: '0 0 16px',
};

const tabBtnStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 12px', margin: '0 8px',
    borderRadius: 6, border: 'none', cursor: 'pointer',
    fontSize: 12, fontWeight: 500, textAlign: 'left',
    transition: 'background 0.15s',
};

const contentStyle: React.CSSProperties = {
    flex: 1, padding: '20px 24px', overflow: 'auto',
    position: 'relative',
};

const closeBtnStyle: React.CSSProperties = {
    position: 'absolute', top: 12, right: 12,
    width: 24, height: 24, borderRadius: '50%',
    border: 'none', cursor: 'pointer',
    background: 'var(--color-bg-elevated)',
    color: 'var(--color-text-tertiary)',
    fontSize: 12, fontWeight: 600,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
};

const titleStyle: React.CSSProperties = {
    fontSize: 16, fontWeight: 700, marginBottom: 16,
    color: 'var(--color-text-primary)',
};

const selectStyle: React.CSSProperties = {
    padding: '4px 8px', borderRadius: 4,
    background: 'var(--color-bg-elevated)',
    border: '1px solid var(--color-divider)',
    color: 'var(--color-text-primary)',
    fontSize: 11, outline: 'none', cursor: 'pointer',
};

const inputStyle: React.CSSProperties = {
    width: 60, padding: '3px 6px', borderRadius: 4, textAlign: 'right',
    background: 'var(--color-bg-elevated)',
    border: '1px solid var(--color-divider)',
    color: 'var(--color-text-primary)',
    fontSize: 11, outline: 'none',
};

const valueStyle: React.CSSProperties = {
    fontSize: 11, color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)',
};

const chipStyle: React.CSSProperties = {
    padding: '5px 12px', borderRadius: 6,
    border: 'none', cursor: 'pointer',
    fontSize: 11, fontWeight: 600,
    transition: 'all 0.15s',
};

const actionBtnStyle: React.CSSProperties = {
    padding: '8px 16px', borderRadius: 6,
    background: 'var(--color-accent-primary)',
    color: '#fff', border: 'none', cursor: 'pointer',
    fontSize: 11, fontWeight: 600,
};

const actionBtnSmStyle: React.CSSProperties = {
    padding: '4px 10px', borderRadius: 4,
    background: 'var(--color-bg-elevated)',
    color: 'var(--color-text-secondary)',
    border: '1px solid var(--color-divider)',
    cursor: 'pointer', fontSize: 10, fontWeight: 500,
};

const dividerStyle: React.CSSProperties = {
    height: 1, background: 'var(--color-divider)',
    margin: '12px 0',
};
