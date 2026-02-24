import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSettingsStore } from '@/shared/stores/useSettingsStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import * as engine from '@/shared/api/engine';
import {
    closeBtnStyle,
    contentStyle,
    modalStyle,
    overlayStyle,
    sidebarStyle,
    tabBtnStyle,
} from './settingsPanelStyles';
import { AboutTab, FoldersTab, MidiTab } from './settingsPanelTabs';
import { AudioTab, AppearanceTab, GeneralTab } from './settingsPanelMainTabs';

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
    const [rescanResult, setRescanResult] = useState<string | null>(null);
    const applyProjectDeltas = useEngineStore((s) => s.applyProjectDeltas);

    // ── Audio Device Enumeration (real hardware from cpal) ──
    const [audioDevices, setAudioDevices] = useState<engine.AudioDevices>({ outputs: [], inputs: [] });
    const [devicesLoading, setDevicesLoading] = useState(false);
    const [restartingEngine, setRestartingEngine] = useState(false);
    const [midiInputs, setMidiInputs] = useState<engine.MidiInputPort[]>([]);
    const [midiLoading, setMidiLoading] = useState(false);
    const [midiConnecting, setMidiConnecting] = useState<string | null>(null);
    const [sandboxLoading, setSandboxLoading] = useState(false);
    const [sandboxSnapshot, setSandboxSnapshot] = useState<engine.PluginSandboxSnapshot | null>(null);
    const audioRefreshInFlightRef = useRef(false);

    const refreshAudioDevices = useCallback(async (opts?: { force?: boolean; silent?: boolean }) => {
        const silent = !!opts?.silent;
        if (audioRefreshInFlightRef.current) return;

        audioRefreshInFlightRef.current = true;
        if (!silent) setDevicesLoading(true);
        try {
            const devices = await engine.getAudioDevices();
            setAudioDevices(devices);
        } catch (err) {
            console.error('[SettingsPanel] Failed to enumerate devices:', err);
        } finally {
            if (!silent) setDevicesLoading(false);
            audioRefreshInFlightRef.current = false;
        }
    }, []);

    // Fetch real devices when Audio tab is opened
    useEffect(() => {
        if (tab !== 'audio') return;
        void refreshAudioDevices({ force: true });
        setSandboxLoading(true);
        engine.getPluginSandboxRuntime()
            .then((snap) => setSandboxSnapshot(snap))
            .catch((err) => console.error('[SettingsPanel] Failed to read plugin sandbox runtime:', err))
            .finally(() => setSandboxLoading(false));
    }, [tab, refreshAudioDevices]);

    useEffect(() => {
        if (tab !== 'audio') return;
        if (restartingEngine) return;
        const selected = settings.outputDevice;
        if (!selected || selected === 'Default Output') return;
        if (audioDevices.outputs.length === 0) return;
        if (audioDevices.outputs.includes(selected)) return;

        setRestartingEngine(true);
        void engine.restartAudioEngine('Default Output')
            .then((resolvedDevice) => {
                updateSetting('outputDevice', resolvedDevice);
            })
            .catch((err) => {
                console.error('[SettingsPanel] Failed to auto-fallback output device:', err);
            })
            .finally(() => {
                setRestartingEngine(false);
                void refreshAudioDevices({ force: true, silent: true });
            });
    }, [tab, restartingEngine, settings.outputDevice, audioDevices.outputs, updateSetting, refreshAudioDevices]);

    const outputOptions = useMemo(() => {
        const options = [...audioDevices.outputs];
        if (settings.outputDevice && !options.includes(settings.outputDevice)) {
            options.push(settings.outputDevice);
        }
        return options.length > 0 ? options : ['Default Output'];
    }, [audioDevices.outputs, settings.outputDevice]);

    const inputOptions = useMemo(() => {
        const options = [...audioDevices.inputs];
        if (settings.inputDevice && !options.includes(settings.inputDevice)) {
            options.push(settings.inputDevice);
        }
        return options.length > 0 ? options : ['Default Input'];
    }, [audioDevices.inputs, settings.inputDevice]);

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
            if (e.defaultPrevented || e.isComposing) return;
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === 'Comma') {
                e.preventDefault();
                // toggle handled externally
                return;
            }
            if (e.key === 'Escape' && isOpen) {
                onClose();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [isOpen, onClose]);

    const handleRescan = useCallback(async () => {
        setRescanningPlugins(true);
        setRescanResult(null);
        try {
            const entries = await engine.scanPluginFolders();
            const pluginCount = entries.filter((e) => e.file_type === 'plugin').length;
            let autoResolved = 0;
            let unresolvedAfter = 0;
            try {
                const report = await engine.autoResolveMissingPluginsReportWithDeltas();
                autoResolved = report.resolved_internal + report.resolved_external;
                unresolvedAfter = report.missing_after;
                if (report.deltas.length > 0) {
                    await applyProjectDeltas(report.deltas, 'settings:rescan-auto-resolve');
                }
            } catch (err) {
                console.warn('[SettingsPanel] auto-resolve after rescan failed:', err);
            }
            setRescanResult(
                unresolvedAfter > 0
                    ? `Found ${pluginCount} plugins · auto-resolved ${autoResolved} · unresolved ${unresolvedAfter}`
                    : autoResolved > 0
                        ? `Found ${pluginCount} plugins · auto-resolved ${autoResolved}`
                        : `Found ${pluginCount} plugins`,
            );
        } catch (err) {
            console.error('[SettingsPanel] plugin rescan failed:', err);
            setRescanResult('Plugin rescan failed');
        } finally {
            setRescanningPlugins(false);
        }
    }, [applyProjectDeltas]);

    const connectMidiInput = useCallback(async (portName: string) => {
        setMidiConnecting(portName);
        try {
            await engine.connectMidiInput(portName);
            const refreshed = await engine.getMidiInputs();
            setMidiInputs(refreshed);
        } catch (err) {
            console.error('[SettingsPanel] connectMidiInput failed:', err);
        } finally {
            setMidiConnecting(null);
        }
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
                    <div style={{ padding: 'var(--space-4) var(--space-3) var(--space-2)', fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-bold)' as unknown as number, opacity: 0.5, letterSpacing: '0.05em' }}>
                        SETTINGS
                    </div>
                    {TABS.map(t => (
                        <button
                            key={t.key}
                            onClick={() => setTab(t.key)}
                            style={{
                                ...tabBtnStyle,
                                background: tab === t.key ? 'var(--color-accent-primary)' : 'transparent',
                                color: tab === t.key ? 'var(--color-text-on-accent)' : 'var(--color-text-secondary)',
                            }}
                        >
                            <span style={{ fontSize: 'var(--font-size-lg)', width: 20, textAlign: 'center' }}>{t.icon}</span>
                            {t.label}
                        </button>
                    ))}
                </div>

                {/* ── Content ── */}
                <div style={contentStyle}>
                    {/* Close button */}
                    <button onClick={onClose} style={closeBtnStyle}>✕</button>

                    {tab === 'general' && <GeneralTab settings={settings} updateSetting={updateSetting} />}

                    {tab === 'appearance' && <AppearanceTab settings={settings} updateSetting={updateSetting} />}

                    {tab === 'audio' && (
                        <AudioTab
                            settings={settings}
                            updateSetting={updateSetting}
                            refreshAudioDevices={refreshAudioDevices}
                            audioDevices={audioDevices}
                            outputOptions={outputOptions}
                            inputOptions={inputOptions}
                            devicesLoading={devicesLoading}
                            restartingEngine={restartingEngine}
                            setRestartingEngine={setRestartingEngine}
                            latencyMs={latencyMs}
                            sandboxSnapshot={sandboxSnapshot}
                            setSandboxSnapshot={setSandboxSnapshot}
                            sandboxLoading={sandboxLoading}
                            setSandboxLoading={setSandboxLoading}
                        />
                    )}

                    {tab === 'folders' && (
                        <FoldersTab
                            settings={settings}
                            pickAndSetFolder={pickAndSetFolder}
                            handleRescan={handleRescan}
                            rescanningPlugins={rescanningPlugins}
                            rescanResult={rescanResult}
                        />
                    )}

                    {tab === 'midi' && (
                        <MidiTab
                            midiLoading={midiLoading}
                            midiInputs={midiInputs}
                            midiConnecting={midiConnecting}
                            connectMidiInput={connectMidiInput}
                            settings={settings}
                            updateSetting={updateSetting}
                        />
                    )}

                    {tab === 'about' && <AboutTab />}
                </div>
            </div>
        </div>
    );
};
