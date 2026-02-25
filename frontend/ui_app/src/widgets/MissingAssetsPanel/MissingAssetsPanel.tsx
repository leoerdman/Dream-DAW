import { useEffect, useMemo, useState } from 'react';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import {
    MissingAudioSection,
    MissingPluginsSection,
    type MissingClipItem,
    type MissingPluginSlot,
} from './MissingAssetsSections';

interface MissingAssetsPanelProps {
    isOpen: boolean;
    onClose: () => void;
}

const readSlotStringField = (slot: unknown, key: string): string => {
    if (!slot || typeof slot !== 'object') return '';
    const rec = slot as Record<string, unknown>;
    const value = rec[key];
    return typeof value === 'string' ? value : '';
};

const readSlotPluginId = (slot: unknown): string =>
    readSlotStringField(slot, 'plugin_id') || readSlotStringField(slot, 'pluginId');
const readSlotName = (slot: unknown): string => readSlotStringField(slot, 'name');
const readSlotId = (slot: unknown): string => readSlotStringField(slot, 'id');

const decodeWantedPluginName = (pluginId: string, displayName: string): string => {
    const decode = (value: string): string => {
        try {
            return decodeURIComponent(value);
        } catch {
            return value;
        }
    };
    if (pluginId.startsWith('missing://')) {
        const query = pluginId.split('?')[1] ?? '';
        const params = new URLSearchParams(query);
        const name = params.get('name') || params.get('vst3') || params.get('user') || params.get('vst2');
        const decoded = decode(name ?? '');
        if (decoded.trim()) return decoded.trim();
    }
    const stripped = displayName.replace(/^Plugin Not Found:\s*/i, '').trim();
    const primary = stripped.split('[')[0]?.trim() ?? stripped;
    return primary || 'plugin';
};

export const MissingAssetsPanel = ({ isOpen, onClose }: MissingAssetsPanelProps) => {
    const timelineClips = useEngineStore((s) => s.timelineClips);
    const trackIds = useEngineStore((s) => s.tracks.allIds);
    const tracksById = useEngineStore((s) => s.tracks.byId);
    const applyProjectDeltas = useEngineStore((s) => s.applyProjectDeltas);

    const [pluginEntries, setPluginEntries] = useState<engineApi.BrowserFileEntry[]>([]);
    const [scanBusy, setScanBusy] = useState(false);
    const [autoResolveBusy, setAutoResolveBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);

    const missingClips = useMemo<MissingClipItem[]>(() => {
        return timelineClips
            .filter((c) => c.type === 'audio' && c.isOffline)
            .map((c) => ({
                clipId: c.id,
                clipName: c.name,
                trackName: (trackIds[c.trackIndex] ? tracksById[trackIds[c.trackIndex]]?.name : undefined) ?? `Track ${c.trackIndex + 1}`,
            }));
    }, [timelineClips, trackIds, tracksById]);

    const missingPlugins = useMemo<MissingPluginSlot[]>(() => {
        const out: MissingPluginSlot[] = [];
        for (const trackId of trackIds) {
            const track = tracksById[trackId];
            if (!track) continue;
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
    }, [trackIds, tracksById]);

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
                setPluginEntries(entries.filter((e) => e.file_type === 'plugin'));
                // Auto-retry resolver immediately after scan so user does not
                // need to click Auto Resolve manually every time.
                return engineApi.autoResolveMissingPluginsReportWithDeltas();
            })
            .then(async (response) => {
                if (!mounted || !response) return;
                if (response.deltas.length > 0) {
                    await applyProjectDeltas(response.deltas, 'missing-assets:scan-auto-resolve');
                }
                const resolved = response.resolved_internal + response.resolved_external;
                if (resolved > 0) {
                    setMessage(`Auto-resolved ${resolved} missing plugin slot(s) after scan`);
                } else if (response.missing_after > 0) {
                    const unresolvedPreview = response.unresolved_labels.slice(0, 2).join(', ');
                    setMessage(unresolvedPreview.length > 0
                        ? `Scan complete: ${response.missing_after} unresolved (${unresolvedPreview})`
                        : `Scan complete: ${response.missing_after} unresolved`);
                } else {
                    setMessage('Scan complete: no missing plugin slots');
                }
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
    }, [isOpen, missingPlugins.length, applyProjectDeltas]);

    const runAutoResolvePlugins = async () => {
        if (autoResolveBusy || missingPlugins.length === 0) return;
        setAutoResolveBusy(true);
        setMessage('Auto-resolving missing plugins...');
        try {
            const response = await engineApi.autoResolveMissingPluginsReportWithDeltas();
            await applyProjectDeltas(response.deltas, 'missing-assets:auto-resolve-bulk');
            const resolved = response.resolved_internal + response.resolved_external;
            if (resolved > 0) {
                setMessage(`Auto Resolve complete: fixed ${resolved} slot(s), ${response.missing_after} unresolved`);
            } else if (response.missing_after > 0) {
                const unresolvedPreview = response.unresolved_labels.slice(0, 3).join(', ');
                setMessage(unresolvedPreview.length > 0
                    ? `Auto Resolve: ${response.missing_after} unresolved (${unresolvedPreview})`
                    : `Auto Resolve: ${response.missing_after} unresolved`);
            } else {
                setMessage('Auto Resolve complete');
            }
        } catch (err) {
            console.error('[MissingAssets] auto resolve failed:', err);
            setMessage('Auto Resolve failed');
        } finally {
            setAutoResolveBusy(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div style={{
            position: 'absolute',
            top: 'var(--daw-transport-height)',
            right: 0,
            bottom: 'var(--daw-status-bar-height)',
            width: 380,
            zIndex: 'var(--z-status-popup)',
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
                    <span style={{ fontSize: 'var(--font-size-base)', fontWeight: 'var(--font-weight-bold)', color: 'var(--color-status-error)' }}>Missing Media Manager</span>
                    <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>
                        {missingClips.length} files offline · {missingPlugins.length} plugins missing
                    </span>
                </div>
                <div style={{ display: 'flex', gap: 'var(--space-1-5)' }}>
                    <button
                        onClick={() => { void runAutoResolvePlugins(); }}
                        disabled={autoResolveBusy || missingPlugins.length === 0}
                        style={{
                            border: 'var(--border-width-1) solid var(--color-divider)',
                            background: 'var(--color-bg-header)',
                            color: 'var(--color-text-secondary)',
                            borderRadius: 'var(--radius-lg)',
                            fontSize: 'var(--font-size-sm)',
                            fontWeight: 'var(--font-weight-semibold)',
                            padding: 'var(--space-1) var(--space-2)',
                            cursor: autoResolveBusy || missingPlugins.length === 0 ? 'default' : 'pointer',
                            opacity: autoResolveBusy || missingPlugins.length === 0 ? 0.6 : 1,
                            transition: `background var(--transition-fast)`,
                        }}
                    >
                        {autoResolveBusy ? 'Resolving...' : 'Auto Resolve'}
                    </button>
                    <button onClick={onClose} style={{
                        border: 'var(--border-width-1) solid var(--color-divider)',
                        background: 'var(--color-bg-header)',
                        color: 'var(--color-text-secondary)',
                        borderRadius: 'var(--radius-lg)',
                        fontSize: 'var(--font-size-sm)',
                        fontWeight: 'var(--font-weight-semibold)',
                        padding: 'var(--space-1) var(--space-2)',
                        cursor: 'pointer',
                        transition: `background var(--transition-fast)`,
                    }}>Close</button>
                </div>
            </div>

            <div style={{ overflowY: 'auto', padding: 'var(--space-2-5)', display: 'grid', gap: 'var(--space-3)' }}>
                <MissingAudioSection
                    missingClips={missingClips}
                    onResolveFile={async (clipId, path, clipName) => {
                        try {
                            const response = await engineApi.resolveMissingFileWithDeltas(clipId, path);
                            await applyProjectDeltas(response.deltas, 'missing-assets:resolve-file');
                            setMessage(`Resolved file for '${clipName}'`);
                        } catch (err) {
                            console.error('[MissingAssets] resolveMissingFile failed:', err);
                            setMessage(`Failed to resolve '${clipName}'`);
                        }
                    }}
                />
                <MissingPluginsSection
                    missingPlugins={missingPlugins}
                    pluginEntries={pluginEntries}
                    scanBusy={scanBusy}
                    onReplacePlugin={async (trackId, slotId, path, name, wantedName) => {
                        try {
                            const response = await engineApi.replaceMissingPluginSlotWithDeltas(trackId, slotId, path, name || undefined);
                            await applyProjectDeltas(response.deltas, name ? 'missing-assets:replace-plugin' : 'missing-assets:replace-plugin-manual');
                            setMessage(name ? `Replaced '${wantedName}' with '${name}'` : `Replaced '${wantedName}'`);
                        } catch (err) {
                            console.error('[MissingAssets] replaceMissingPluginSlot failed:', err);
                            setMessage(`Failed to replace '${wantedName}'`);
                        }
                    }}
                />

                {message && <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>{message}</div>}
            </div>
        </div>
    );
};
