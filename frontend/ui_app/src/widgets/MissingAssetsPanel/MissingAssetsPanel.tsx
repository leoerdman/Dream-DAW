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
    const trackIds = useEngineStore((s) => s.tracks.allIds);
    const tracksById = useEngineStore((s) => s.tracks.byId);
    const applyProjectDeltas = useEngineStore((s) => s.applyProjectDeltas);

    const [pluginEntries, setPluginEntries] = useState<engineApi.BrowserFileEntry[]>([]);
    const [scanBusy, setScanBusy] = useState(false);
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
