import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';

interface MissingAssetsPanelProps {
    isOpen: boolean;
    onClose: () => void;
}

interface MissingPluginSlot {
    trackId: string;
    trackName: string;
    slotId: string;
    displayName: string;
    pluginId: string;
    wantedName: string;
}

const readSlotPluginId = (slot: unknown): string => {
    if (!slot || typeof slot !== 'object') return '';
    const rec = slot as Record<string, unknown>;
    const value = rec.plugin_id ?? rec.pluginId;
    return typeof value === 'string' ? value : '';
};

const readSlotName = (slot: unknown): string => {
    if (!slot || typeof slot !== 'object') return '';
    const rec = slot as Record<string, unknown>;
    const value = rec.name;
    return typeof value === 'string' ? value : '';
};

const readSlotId = (slot: unknown): string => {
    if (!slot || typeof slot !== 'object') return '';
    const rec = slot as Record<string, unknown>;
    const value = rec.id;
    return typeof value === 'string' ? value : '';
};

const decodeWantedPluginName = (pluginId: string, displayName: string): string => {
    if (pluginId.startsWith('missing://')) {
        const query = pluginId.split('?')[1] ?? '';
        const params = new URLSearchParams(query);
        const name = params.get('name') || params.get('vst3') || params.get('user') || params.get('vst2');
        if (name && name.trim()) return name.trim();
    }
    return displayName.replace(/^Plugin Not Found:\s*/i, '').trim() || 'plugin';
};

export const MissingAssetsPanel = ({ isOpen, onClose }: MissingAssetsPanelProps) => {
    const timelineClips = useEngineStore((s) => s.timelineClips);
    const projectTracks = useEngineStore((s) => s.projectTracks);
    const fetchProject = useEngineStore((s) => s.fetchProject);

    const [pluginEntries, setPluginEntries] = useState<engineApi.BrowserFileEntry[]>([]);
    const [scanBusy, setScanBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);

    const missingClips = useMemo(() => {
        return timelineClips
            .filter((c) => c.type === 'audio' && c.isOffline)
            .map((c) => ({
                clipId: c.id,
                clipName: c.name,
                trackName: projectTracks[c.trackIndex]?.name ?? `Track ${c.trackIndex + 1}`,
            }));
    }, [timelineClips, projectTracks]);

    const missingPlugins = useMemo<MissingPluginSlot[]>(() => {
        const out: MissingPluginSlot[] = [];
        for (const track of projectTracks) {
            const instrumentPluginId = readSlotPluginId(track.instrument);
            if (track.instrument && instrumentPluginId.startsWith('missing://')) {
                const instrumentName = readSlotName(track.instrument);
                const instrumentId = readSlotId(track.instrument);
                out.push({
                    trackId: track.id,
                    trackName: track.name,
                    slotId: instrumentId,
                    displayName: instrumentName,
                    pluginId: instrumentPluginId,
                    wantedName: decodeWantedPluginName(instrumentPluginId, instrumentName),
                });
            }
            for (const fx of track.effects) {
                const fxPluginId = readSlotPluginId(fx);
                if (fxPluginId.startsWith('missing://')) {
                    const fxName = readSlotName(fx);
                    const fxId = readSlotId(fx);
                    out.push({
                        trackId: track.id,
                        trackName: track.name,
                        slotId: fxId,
                        displayName: fxName,
                        pluginId: fxPluginId,
                        wantedName: decodeWantedPluginName(fxPluginId, fxName),
                    });
                }
            }
        }
        return out.filter((x) => x.slotId.length > 0);
    }, [projectTracks]);

    useEffect(() => {
        if (!isOpen || missingPlugins.length === 0) return;
        let mounted = true;
        const raf = window.requestAnimationFrame(() => {
            if (!mounted) return;
            setScanBusy(true);
            setMessage(null);
        });
        void engineApi.scanPluginFolders()
            .then((entries) => {
                if (!mounted) return;
                setPluginEntries(entries.filter((e) => e.file_type === 'plugin' && e.extension.toUpperCase() === 'VST3'));
            })
            .catch((err) => {
                console.error('[MissingAssets] scanPluginFolders failed:', err);
                if (mounted) setMessage('Failed to scan plugins');
            })
            .finally(() => {
                if (mounted) setScanBusy(false);
            });
        return () => {
            mounted = false;
            window.cancelAnimationFrame(raf);
        };
    }, [isOpen, missingPlugins.length]);

    if (!isOpen) return null;

    return (
        <div style={{
            position: 'absolute',
            top: 'var(--daw-transport-height)',
            right: 0,
            bottom: 'var(--daw-status-bar-height)',
            width: 380,
            zIndex: 'var(--z-status-popup)' as unknown as number,
            borderLeft: 'var(--border-width-1) solid var(--color-divider)',
            background: 'color-mix(in srgb, var(--color-bg-panel) 93%, var(--color-bg-base))',
            display: 'grid',
            gridTemplateRows: 'auto 1fr',
        }}>
            <div style={{
                padding: 'var(--space-2-5) var(--space-3)',
                borderBottom: 'var(--border-width-1) solid var(--color-divider)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
            }}>
                <div style={{ display: 'grid', gap: 'var(--space-0-5)' }}>
                    <span style={{ fontSize: 'var(--font-size-base)', fontWeight: 'var(--font-weight-bold)' as unknown as number, color: 'var(--color-status-error)' }}>Missing Media Manager</span>
                    <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>
                        {missingClips.length} files offline · {missingPlugins.length} plugins missing
                    </span>
                </div>
                <button onClick={onClose} style={{
                    border: 'var(--border-width-1) solid var(--color-divider)',
                    background: 'var(--color-bg-header)',
                    color: 'var(--color-text-secondary)',
                    borderRadius: 'var(--radius-lg)',
                    fontSize: 'var(--font-size-sm)',
                    fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                    padding: 'var(--space-1) var(--space-2)',
                    cursor: 'pointer',
                    transition: `background var(--transition-fast)`,
                }}>Close</button>
            </div>

            <div style={{ overflowY: 'auto', padding: 'var(--space-2-5)', display: 'grid', gap: 'var(--space-3)' }}>
                <section style={{ display: 'grid', gap: 'var(--space-2)' }}>
                    <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-bold)' as unknown as number, color: 'var(--color-text-primary)' }}>Missing Audio Files</div>
                    {missingClips.length === 0 ? (
                        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-tertiary)' }}>No offline audio clips.</div>
                    ) : missingClips.map((item) => (
                        <div key={item.clipId} style={{
                            border: 'var(--border-width-1) solid var(--color-divider)',
                            borderRadius: 'var(--radius-xl)',
                            background: 'var(--color-bg-header)',
                            padding: 'var(--space-2)',
                            display: 'grid',
                            gap: 'var(--space-1-5)',
                        }}>
                            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-primary)' }}>{item.clipName}</div>
                            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>{item.trackName}</div>
                            <div style={{ display: 'flex', gap: 'var(--space-1-5)' }}>
                                <button
                                    onClick={async () => {
                                        const picked = await open({
                                            multiple: false,
                                            title: `Replace missing file: ${item.clipName}`,
                                            filters: [{ name: 'Audio', extensions: ['wav', 'aif', 'aiff', 'flac', 'mp3', 'ogg', 'm4a', 'aac'] }],
                                        });
                                        const path = typeof picked === 'string' ? picked : null;
                                        if (!path) return;
                                        try {
                                            await engineApi.resolveMissingFile(item.clipId, path);
                                            await fetchProject('missing-assets:resolve-file');
                                            setMessage(`Resolved file for '${item.clipName}'`);
                                        } catch (err) {
                                            console.error('[MissingAssets] resolveMissingFile failed:', err);
                                            setMessage(`Failed to resolve '${item.clipName}'`);
                                        }
                                    }}
                                    style={actionBtnStyle}
                                >
                                    Replace File...
                                </button>
                                <button
                                    onClick={() => {
                                        window.dispatchEvent(new CustomEvent('dream:browser-set-search', {
                                            detail: { query: item.clipName, categoryId: 'samples' },
                                        }));
                                    }}
                                    style={actionBtnStyle}
                                >
                                    Find in Browser
                                </button>
                            </div>
                        </div>
                    ))}
                </section>

                <section style={{ display: 'grid', gap: 'var(--space-2)' }}>
                    <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-bold)' as unknown as number, color: 'var(--color-text-primary)' }}>Missing Plugins</div>
                    {missingPlugins.length === 0 ? (
                        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-tertiary)' }}>No missing plugin placeholders.</div>
                    ) : missingPlugins.map((item) => {
                        const query = item.wantedName.toLowerCase();
                        const matches = pluginEntries
                            .filter((p) => p.name.toLowerCase().includes(query))
                            .slice(0, 4);
                        return (
                            <div key={item.slotId} style={{
                                border: 'var(--border-width-1) solid var(--color-divider)',
                                borderRadius: 'var(--radius-xl)',
                                background: 'var(--color-bg-header)',
                                padding: 'var(--space-2)',
                                display: 'grid',
                                gap: 'var(--space-1-5)',
                            }}>
                                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-primary)' }}>{item.displayName}</div>
                                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>{item.trackName}</div>
                                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>Wanted: {item.wantedName}</div>

                                <div style={{ display: 'grid', gap: 'var(--space-1)' }}>
                                    {matches.length > 0 ? matches.map((p) => (
                                        <button
                                            key={`${item.slotId}:${p.path}`}
                                            onClick={async () => {
                                                try {
                                                    await engineApi.replaceMissingPluginSlot(item.trackId, item.slotId, p.path, p.name);
                                                    await fetchProject('missing-assets:replace-plugin');
                                                    setMessage(`Replaced '${item.wantedName}' with '${p.name}'`);
                                                } catch (err) {
                                                    console.error('[MissingAssets] replaceMissingPluginSlot failed:', err);
                                                    setMessage(`Failed to replace '${item.wantedName}'`);
                                                }
                                            }}
                                            style={{ ...actionBtnStyle, justifyContent: 'space-between', width: '100%', display: 'flex' }}
                                        >
                                            <span>{p.name}</span>
                                            <span style={{ opacity: 0.7 }}>Use</span>
                                        </button>
                                    )) : (
                                        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>
                                            {scanBusy ? 'Scanning plugins...' : 'No close VST3 match found'}
                                        </div>
                                    )}
                                </div>

                                <div style={{ display: 'flex', gap: 'var(--space-1-5)' }}>
                                    <button
                                        onClick={async () => {
                                            const picked = await open({
                                                multiple: false,
                                                title: `Replace missing plugin: ${item.wantedName}`,
                                                filters: [{ name: 'Plugins', extensions: ['vst3'] }],
                                            });
                                            const path = typeof picked === 'string' ? picked : null;
                                            if (!path) return;
                                            try {
                                                await engineApi.replaceMissingPluginSlot(item.trackId, item.slotId, path);
                                                await fetchProject('missing-assets:replace-plugin-manual');
                                                setMessage(`Replaced '${item.wantedName}'`);
                                            } catch (err) {
                                                console.error('[MissingAssets] manual plugin replace failed:', err);
                                                setMessage(`Failed to replace '${item.wantedName}'`);
                                            }
                                        }}
                                        style={actionBtnStyle}
                                    >
                                        Pick VST3...
                                    </button>
                                    <button
                                        onClick={() => {
                                            window.dispatchEvent(new CustomEvent('dream:browser-set-search', {
                                                detail: { query: item.wantedName, categoryId: 'plugins' },
                                            }));
                                        }}
                                        style={actionBtnStyle}
                                    >
                                        Find in Browser
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </section>

                {message && <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>{message}</div>}
            </div>
        </div>
    );
};

const actionBtnStyle: CSSProperties = {
    border: 'var(--border-width-1) solid var(--color-divider)',
    borderRadius: 'var(--radius-lg)',
    background: 'var(--color-bg-panel)',
    color: 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 'var(--font-weight-semibold)' as unknown as number,
    padding: 'var(--space-1) var(--space-2)',
    cursor: 'pointer',
    transition: `background var(--transition-fast)`,
};
