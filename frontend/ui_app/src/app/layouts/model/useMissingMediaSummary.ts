import { useEffect, useMemo, useState } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { checkFilesExist } from '@/shared/api/engine';
import { type TimelineClip } from '@/shared/lib/arrangementTypes';
export interface MissingMediaSummary {
    offlineClipCount: number;
    missingPluginCount: number;
    missingSamplerCount: number;
    total: number;
}

/**
 * ENTERPRISE FIX: Global tracking for all missing media types.
 * Connects to the fast `check_files_exist` Rust IPC API for samplers
 * without causing heavy rendering cycles.
 */
export function useMissingMediaSummary(timelineClipsForView: TimelineClip[]): MissingMediaSummary {
    const tracksEntity = useEngineStore(s => s.tracks);
    const clipsEntity = useEngineStore(s => s.clips);
    const timelineClipsSnapshot = useMemo(() => Object.values(clipsEntity.byId), [clipsEntity]);
    const clipsSource = timelineClipsForView.length > 0 ? timelineClipsForView : timelineClipsSnapshot;

    // 1. Clips & Plugins (synchronous check)
    const storeMissing = useMemo(() => {
        const offlineClipCount = clipsSource.filter((c) => c.type === 'audio' && c.isOffline).length;
        let missingPluginCount = 0;

        for (const trackId of tracksEntity.allIds) {
            const track = tracksEntity.byId[trackId];
            if (!track) continue;
            if (track.instrument?.plugin_id?.startsWith('missing://')) missingPluginCount += 1;
            missingPluginCount += (track.effects ?? []).filter((fx) => fx.plugin_id?.startsWith('missing://')).length;
        }

        return { offlineClipCount, missingPluginCount };
    }, [clipsSource, tracksEntity]);

    // 2. Sampler Samples (async IPC check, debounced via effect)
    const [missingSamplerCount, setMissingSamplerCount] = useState(0);

    useEffect(() => {
        const uniquePaths = new Set<string>();

        // Collect all sampler/pad paths
        for (const trackId of tracksEntity.allIds) {
            const track = tracksEntity.byId[trackId];
            if (!track) continue;

            const samplerPath = (track.sampler?.sample_path ?? '').trim();
            if (samplerPath && !samplerPath.startsWith('internal://')) {
                uniquePaths.add(samplerPath);
            }

            const rack = track.sample_rack;
            if (rack && Array.isArray(rack.pads)) {
                for (const pad of rack.pads) {
                    const padPath = (pad?.sample_path ?? '').trim();
                    if (padPath && !padPath.startsWith('internal://')) {
                        uniquePaths.add(padPath);
                    }
                }
            }
        }

        const paths = Array.from(uniquePaths);
        if (paths.length === 0) {
            setMissingSamplerCount(0);
            return;
        }

        let cancelled = false;

        // Fast IPC check
        checkFilesExist(paths)
            .then((existsArray: boolean[]) => {
                if (cancelled) return;
                // Count how many of the paths returned false
                const missingCount = existsArray.filter((e: boolean) => !e).length;
                setMissingSamplerCount(missingCount);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                console.error('[useMissingMediaSummary] checkFilesExist failed:', err);
                // Fallback: assume all are missing if check fails
                setMissingSamplerCount(paths.length);
            });

        return () => { cancelled = true; };
    }, [tracksEntity]); // Re-run when tracks change (handles path additions/removals)

    return {
        offlineClipCount: storeMissing.offlineClipCount,
        missingPluginCount: storeMissing.missingPluginCount,
        missingSamplerCount,
        total: storeMissing.offlineClipCount + storeMissing.missingPluginCount + missingSamplerCount,
    };
}
