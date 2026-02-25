import { useCallback } from 'react';
import * as engineApi from '@/shared/api/engine';
import { beatToFrame, resolveSampleRate } from '@/shared/lib/audioMath';
import { fileTypeToItemType } from './assetBrowserUtils';
import type { BrowserItem } from './assetBrowserSchema';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { dreamGlobals } from '@/shared/lib/dreamGlobals';
import type { EntityState } from '@/shared/stores/engine/storeHelpers';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';

interface FolderTreeActionsParams {
    expandedFolders: Set<string>;
    folderChildrenCache: Map<string, BrowserItem[]>;
    setExpandedFolders: React.Dispatch<React.SetStateAction<Set<string>>>;
    setLoadingFolders: React.Dispatch<React.SetStateAction<Set<string>>>;
    setFolderChildrenCache: React.Dispatch<React.SetStateAction<Map<string, BrowserItem[]>>>;
    setUserFolders: React.Dispatch<React.SetStateAction<string[]>>;
    setSelectedCategoryId: React.Dispatch<React.SetStateAction<string>>;
    onFoldersChanged?: () => void;
}

export function useFolderTreeActions({
    setExpandedFolders,
    setLoadingFolders,
    setFolderChildrenCache,
    setUserFolders,
    setSelectedCategoryId,
    onFoldersChanged,
}: Pick<FolderTreeActionsParams, 'setExpandedFolders' | 'setLoadingFolders' | 'setFolderChildrenCache' | 'setUserFolders' | 'setSelectedCategoryId' | 'onFoldersChanged'>) {
    const statusError = useStatusStore((s) => s.setError);
    const statusClear = useStatusStore((s) => s.clear);

    const toggleFolderExpand = useCallback(async (path: string) => {
        // BUG-17 FIX: use functional updater to avoid stale closure
        let wasExpanded = false;
        setExpandedFolders((prev) => {
            wasExpanded = prev.has(path);
            const next = new Set(prev);
            if (wasExpanded) {
                for (const p of next) {
                    if (p.startsWith(`${path}/`) || p === path) next.delete(p);
                }
            } else {
                next.add(path);
            }
            return next;
        });

        if (!wasExpanded) {
            // BUG-17 FIX: use functional updater to check cache
            let needsFetch = false;
            setFolderChildrenCache((prev) => {
                needsFetch = !prev.has(path);
                return prev; // no mutation, just reading
            });
            if (needsFetch) {
                setLoadingFolders((prev) => new Set(prev).add(path));
                try {
                    const files = await engineApi.scanFolderAll(path);
                    const children: BrowserItem[] = files.map((f, i) => {
                        const sizeKb = Math.round(f.size_bytes / 1024);
                        const sizeMb = (f.size_bytes / (1024 * 1024)).toFixed(1);
                        const sizeLabel = f.is_directory ? '' : (sizeKb > 1024 ? `${sizeMb} MB` : `${sizeKb} KB`);
                        const stablePathKey = f.path || `${f.name}-${i}`;
                        return {
                            id: `tree-${stablePathKey}`,
                            name: f.name,
                            type: fileTypeToItemType(f.file_type),
                            format: f.extension || undefined,
                            meta: f.is_directory ? 'Folder' : sizeLabel,
                            path: f.path,
                            isDirectory: f.is_directory,
                            durationSeconds: f.duration_seconds ?? undefined,
                            sizeBytes: f.size_bytes,
                        };
                    });
                    children.sort((a, b) => {
                        const aDir = a.isDirectory ? 1 : 0;
                        const bDir = b.isDirectory ? 1 : 0;
                        if (aDir !== bDir) return bDir - aDir;
                        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
                    });
                    setFolderChildrenCache((prev) => new Map(prev).set(path, children));
                } catch (err) {
                    console.warn('[Browser] Tree scan failed for', path, err);
                    statusError(`Asset Browser: failed to scan folder: ${String(err)}`);
                } finally {
                    setLoadingFolders((prev) => {
                        const next = new Set(prev);
                        next.delete(path);
                        return next;
                    });
                }
            }
        }
    }, [setExpandedFolders, setFolderChildrenCache, setLoadingFolders, statusError]);

    const navigateInto = useCallback((path: string) => {
        void toggleFolderExpand(path);
    }, [toggleFolderExpand]);

    const handleAddFolder = useCallback(() => {
        engineApi.addBrowserFolder()
            .then((folders) => {
                setUserFolders(folders);
                const newIdx = folders.length - 1;
                if (newIdx >= 0) setSelectedCategoryId(`user-folder-${newIdx}`);
                onFoldersChanged?.();
                statusClear();
            })
            .catch((err) => {
                if (!String(err).includes('Cancelled')) {
                    console.error('[Browser] Add folder failed:', err);
                    statusError(`Asset Browser: failed to add folder: ${String(err)}`);
                }
            });
    }, [onFoldersChanged, setSelectedCategoryId, setUserFolders, statusClear, statusError]);

    const handleRemoveFolder = useCallback((path: string) => {
        engineApi.removeBrowserFolder(path)
            .then((folders) => {
                setUserFolders(folders);
                setSelectedCategoryId('samples');
                onFoldersChanged?.();
                statusClear();
            })
            .catch((err) => {
                console.error('[Browser] Remove folder failed:', err);
                statusError(`Asset Browser: failed to remove folder: ${String(err)}`);
            });
    }, [onFoldersChanged, setSelectedCategoryId, setUserFolders, statusClear, statusError]);

    return { toggleFolderExpand, navigateInto, handleAddFolder, handleRemoveFolder };
}

interface ItemEnterParams {
    tracks: EntityState<ProjectTrack>;
    enterNonceRef: React.MutableRefObject<number>;
}

export function useItemEnterAction({ tracks, enterNonceRef }: ItemEnterParams) {
    const statusError = useStatusStore((s) => s.setError);
    const statusClear = useStatusStore((s) => s.clear);

    const getTrackById = useCallback((trackId: string) => tracks.byId[trackId] ?? null, [tracks.byId]);
    const getTrackIndexById = useCallback((trackId: string) => tracks.allIds.indexOf(trackId), [tracks.allIds]);
    const hasTimelineClipsOnTrack = useCallback((trackIndex: number) => {
        const { clips } = useEngineStore.getState();
        for (const clipId of clips.allIds) {
            const clip = clips.byId[clipId];
            if (clip?.trackIndex === trackIndex) return true;
        }
        return false;
    }, []);

    const resolveEffectInsertIndex = useCallback((track: ProjectTrack): number | undefined => {
        const selectedTrackId = dreamGlobals.getSelectedTrackId();
        if (!selectedTrackId || selectedTrackId !== track.id) return undefined;
        const rackScope = typeof document !== 'undefined'
            ? document.querySelector<HTMLElement>('[data-keyboard-scope="device-rack"]')
            : null;
        const selectedDeviceId = rackScope?.dataset?.selectedDeviceId ?? '';
        if (!selectedDeviceId) return undefined;
        const selectedEffectIndex = track.effects.findIndex((effect) => effect?.id === selectedDeviceId);
        return selectedEffectIndex >= 0 ? selectedEffectIndex + 1 : undefined;
    }, []);

    const resolveSelectedTrack = useCallback(() => {
        const selected = dreamGlobals.getSelectedTrackId();
        if (selected && selected !== 'master') {
            const selectedTrack = getTrackById(selected);
            if (selectedTrack) return selectedTrack;
        }
        const firstUsable = tracks.allIds
            .map((id) => tracks.byId[id])
            .find((t): t is ProjectTrack => Boolean(t) && t.track_type !== 'Master');
        return firstUsable ?? null;
    }, [getTrackById, tracks.allIds, tracks.byId]);

    const handleItemEnter = useCallback(async (item: BrowserItem | null) => {
        if (!item?.path) return;
        const nonce = ++enterNonceRef.current;
        const track = resolveSelectedTrack();
        if (!track) return;
        try {
            if (item.type === 'plugin') {
                const primary: 'instrument' | 'effect' | 'auto' = item.slotHint ?? 'auto';
                const fallback: 'instrument' | 'effect' = primary === 'instrument' ? 'effect' : 'instrument';
                const insertIndex =
                    (primary === 'effect' || primary === 'auto')
                        ? resolveEffectInsertIndex(track)
                        : undefined;
                let lastErr: unknown = null;
                const attempts: Array<'instrument' | 'effect' | 'auto'> = [];
                for (const slot of [primary, 'auto', fallback] as const) if (!attempts.includes(slot)) attempts.push(slot);
                for (const attempt of attempts) {
                    try {
                        const response = await engineApi.addPluginToTrackWithDeltas(
                            track.id,
                            item.path,
                            item.name,
                            attempt,
                            insertIndex,
                        );
                        await useEngineStore.getState().applyProjectDeltas(response.deltas, 'asset-browser:add-plugin');
                        lastErr = null;
                        break;
                    } catch (err) { lastErr = err; }
                }
                if (lastErr) throw lastErr;
                statusClear();
                return;
            }
            if (item.type !== 'audio') return;
            if (track.track_type === 'Midi') {
                const hasSampler = !!track.instrument && /sampler/i.test(`${track.instrument.plugin_id} ${track.instrument.name}`);
                if (!hasSampler) {
                    const response = await engineApi.addPluginToTrackWithDeltas(track.id, 'internal://instrument/sampler', 'Sampler', 'instrument');
                    await useEngineStore.getState().applyProjectDeltas(response.deltas, 'asset-browser:add-sampler');
                }
                const response = await engineApi.setSamplerSampleWithDeltas(track.id, item.path);
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'asset-browser:set-sampler-sample');
                statusClear();
                return;
            }

            const trackIndex = getTrackIndexById(track.id);
            if (trackIndex < 0) return;

            // UX rule: on an empty audio track, treat Enter on sample as "create Sampler + assign sample".
            if (track.track_type === 'Audio') {
                const hasSampler = !!track.instrument && /sampler/i.test(`${track.instrument.plugin_id} ${track.instrument.name}`);
                const isEmptyAudioTrack = !track.instrument && !hasTimelineClipsOnTrack(trackIndex);
                if (hasSampler || isEmptyAudioTrack) {
                    try {
                        if (!hasSampler) {
                            const addSampler = await engineApi.addPluginToTrackWithDeltas(
                                track.id,
                                'internal://instrument/sampler',
                                'Sampler',
                                'instrument',
                            );
                            await useEngineStore.getState().applyProjectDeltas(addSampler.deltas, 'asset-browser:add-sampler-audio-track');
                        }
                        const setSample = await engineApi.setSamplerSampleWithDeltas(track.id, item.path);
                        await useEngineStore.getState().applyProjectDeltas(setSample.deltas, 'asset-browser:set-sampler-sample-audio-track');
                        statusClear();
                        return;
                    } catch (samplerErr) {
                        // Fallback to classic audio import if sampler placement isn't supported on this track.
                        console.warn('[AssetBrowser] Sampler assignment fallback to audio import:', samplerErr);
                    }
                }
            }

            const store = useEngineStore.getState();
            const bpm = store.projectBpm || store.transport.bpm || 120;
            const sampleRate = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
            const positionFrames = Math.max(0, beatToFrame(store.transport.position_beats ?? 0, bpm, sampleRate));
            if (enterNonceRef.current !== nonce) return;
            const response = await engineApi.importAudioFileWithDeltas(item.path, trackIndex, positionFrames);
            if (enterNonceRef.current !== nonce) return;
            await store.applyProjectDeltas(response.deltas, 'asset-browser:import-audio');
            statusClear();
        } catch (err) {
            console.error('[AssetBrowser] Enter action failed:', err);
            statusError(`Asset Browser: failed to import item: ${String(err)}`);
        }
    }, [enterNonceRef, getTrackIndexById, hasTimelineClipsOnTrack, resolveSelectedTrack, resolveEffectInsertIndex, statusClear, statusError]);

    return { handleItemEnter };
}
