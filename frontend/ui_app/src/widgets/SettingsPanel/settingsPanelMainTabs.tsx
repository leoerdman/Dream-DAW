import type { AppSettings, AudioDevices, PluginSandboxSnapshot } from '@/shared/api/engine';
import { Select, SettingRow, Toggle } from './settingsPanelParts';
import { actionBtnSmStyle, chipStyle, dividerStyle, inputStyle, titleStyle, valueStyle } from './settingsPanelStyles';
import * as engine from '@/shared/api/engine';

interface GeneralTabProps {
    settings: AppSettings;
    updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export function GeneralTab({ settings, updateSetting }: GeneralTabProps) {
    return (
        <div>
            <h2 style={titleStyle}>General</h2>
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
        </div>
    );
}

interface AppearanceTabProps {
    settings: AppSettings;
    updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export function AppearanceTab({ settings, updateSetting }: AppearanceTabProps) {
    return (
        <div>
            <h2 style={titleStyle}>Appearance</h2>
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
        </div>
    );
}

interface AudioTabProps {
    settings: AppSettings;
    updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
    refreshAudioDevices: (opts?: { force?: boolean; silent?: boolean }) => Promise<void>;
    audioDevices: AudioDevices;
    outputOptions: string[];
    inputOptions: string[];
    devicesLoading: boolean;
    restartingEngine: boolean;
    setRestartingEngine: (value: boolean) => void;
    latencyMs: number;
    sandboxSnapshot: PluginSandboxSnapshot | null;
    setSandboxSnapshot: (snapshot: PluginSandboxSnapshot | null) => void;
    sandboxLoading: boolean;
    setSandboxLoading: (value: boolean) => void;
}

export function AudioTab({
    settings,
    updateSetting,
    refreshAudioDevices,
    audioDevices,
    outputOptions,
    inputOptions,
    devicesLoading,
    restartingEngine,
    setRestartingEngine,
    latencyMs,
    sandboxSnapshot,
    setSandboxSnapshot,
    sandboxLoading,
    setSandboxLoading,
}: AudioTabProps) {
    return (
        <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <h2 style={{ ...titleStyle, margin: 0 }}>Audio</h2>
                <button
                    onClick={() => void refreshAudioDevices({ force: true })}
                    style={{ ...chipStyle, background: 'var(--color-bg-elevated)', color: 'var(--color-text-secondary)', fontWeight: 'var(--font-weight-semibold)' as unknown as number }}
                >
                    Refresh Devices
                </button>
            </div>
            <SettingRow label="Driver Type">
                <Select value={settings.driverType} options={['CoreAudio']} onChange={(v) => updateSetting('driverType', v)} />
            </SettingRow>
            <SettingRow label="Output Device">
                <Select
                    value={settings.outputDevice}
                    options={outputOptions}
                    onMouseDown={() => void refreshAudioDevices({ force: true, silent: true })}
                    onChange={async (v) => {
                        setRestartingEngine(true);
                        try {
                            const resolvedDevice = await engine.restartAudioEngine(v);
                            updateSetting('outputDevice', resolvedDevice);
                        } catch (err) {
                            console.error('[SettingsPanel] restartAudioEngine failed:', err);
                        } finally {
                            setRestartingEngine(false);
                            void refreshAudioDevices({ force: true });
                        }
                    }}
                />
                {devicesLoading && audioDevices.outputs.length === 0 && <span style={{ ...valueStyle, marginLeft: 4 }}>⏳</span>}
                {restartingEngine && <span style={{ ...valueStyle, marginLeft: 6 }}>Restarting Engine...</span>}
            </SettingRow>
            <SettingRow label="Pinned Fallback">
                <Select
                    value={settings.fallbackOutputDevice || 'Default Output'}
                    options={outputOptions}
                    onMouseDown={() => void refreshAudioDevices({ force: true, silent: true })}
                    onChange={(v) => updateSetting('fallbackOutputDevice', v)}
                />
                <button
                    onClick={() => updateSetting('fallbackOutputDevice', settings.outputDevice || 'Default Output')}
                    style={actionBtnSmStyle}
                    title="Pin current output as fallback"
                >
                    📌 Pin Current
                </button>
            </SettingRow>
            <SettingRow label="Input Device">
                <Select
                    value={settings.inputDevice}
                    options={inputOptions}
                    onMouseDown={() => void refreshAudioDevices({ force: true, silent: true })}
                    onChange={(v) => updateSetting('inputDevice', v)}
                />
                {devicesLoading && audioDevices.inputs.length === 0 && <span style={{ ...valueStyle, marginLeft: 4 }}>⏳</span>}
            </SettingRow>
            <SettingRow label="Sample Rate">
                <Select value={`${settings.sampleRate} Hz`} options={['44100 Hz', '48000 Hz', '88200 Hz', '96000 Hz']} onChange={(v) => updateSetting('sampleRate', parseInt(v, 10))} />
            </SettingRow>
            <SettingRow label="Buffer Size">
                <Select value={`${settings.bufferSize} samples`} options={['64 samples', '128 samples', '256 samples', '512 samples', '1024 samples', '2048 samples']} onChange={(v) => updateSetting('bufferSize', parseInt(v, 10))} />
            </SettingRow>

            <div style={dividerStyle} />
            <SettingRow label="Input Latency"><span style={valueStyle}>{latencyMs.toFixed(1)} ms</span></SettingRow>
            <SettingRow label="Output Latency"><span style={valueStyle}>{latencyMs.toFixed(1)} ms</span></SettingRow>
            <SettingRow label="Overall Latency"><span style={valueStyle}>{(latencyMs * 2).toFixed(1)} ms</span></SettingRow>
            <SettingRow label="Driver Error Compensation">
                <input
                    type="number"
                    value={settings.driverErrorCompensation}
                    onChange={(e) => updateSetting('driverErrorCompensation', parseFloat(e.target.value) || 0)}
                    style={inputStyle}
                    step={0.1}
                />
                <span style={{ ...valueStyle, marginLeft: 4 }}>ms</span>
            </SettingRow>

            <div style={dividerStyle} />
            <SettingRow label="Test Tone">
                <Toggle value={settings.testToneEnabled} onChange={(v) => updateSetting('testToneEnabled', v)} />
            </SettingRow>
            {settings.testToneEnabled && (
                <>
                    <SettingRow label="Tone Volume">
                        <input type="range" min={-60} max={0} value={settings.testToneVolume} onChange={(e) => updateSetting('testToneVolume', parseInt(e.target.value, 10))} style={{ width: 120 }} />
                        <span style={valueStyle}>{settings.testToneVolume} dB</span>
                    </SettingRow>
                    <SettingRow label="Frequency">
                        <input type="number" value={settings.testToneFrequency} onChange={(e) => updateSetting('testToneFrequency', parseInt(e.target.value, 10) || 440)} style={inputStyle} />
                        <span style={{ ...valueStyle, marginLeft: 4 }}>Hz</span>
                    </SettingRow>
                </>
            )}

            <div style={dividerStyle} />
            <SettingRow label="CPU Usage Simulator"><Toggle value={settings.cpuUsageSimulator} onChange={(v) => updateSetting('cpuUsageSimulator', v)} /></SettingRow>
            <SettingRow label="High Quality SR/Pitch Conversion"><Toggle value={settings.srPitchConversion} onChange={(v) => updateSetting('srPitchConversion', v)} /></SettingRow>

            <div style={dividerStyle} />
            <SettingRow label="Plugin Sandbox (Out-of-Process)">
                <Toggle
                    value={sandboxSnapshot?.enabled ?? false}
                    onChange={async (v) => {
                        setSandboxLoading(true);
                        try {
                            const snap = await engine.setPluginSandboxEnabled(v);
                            setSandboxSnapshot(snap);
                        } catch (err) {
                            console.error('[SettingsPanel] setPluginSandboxEnabled failed:', err);
                        } finally {
                            setSandboxLoading(false);
                        }
                    }}
                />
                {sandboxLoading && <span style={{ ...valueStyle, marginLeft: 6 }}>⏳</span>}
            </SettingRow>
            <SettingRow label="Sandbox Instances"><span style={valueStyle}>{sandboxSnapshot?.instances.length ?? 0}</span></SettingRow>
            {!!sandboxSnapshot?.instances.length && (
                <div style={{ marginTop: 8, border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-lg)', padding: 8, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 140, overflowY: 'auto' }}>
                    {sandboxSnapshot.instances.map((inst) => (
                        <div key={inst.plugin_instance_id} style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inst.plugin_name}</span>
                            <span>{inst.status}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
