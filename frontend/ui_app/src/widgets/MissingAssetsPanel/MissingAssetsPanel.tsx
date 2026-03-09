import { useEffect, useMemo, useCallback, useState, useRef } from 'react';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { selectAllClips } from '@/shared/stores/entitySelectors';
import {
    MissingAudioSection,
    MissingPluginsSection,
    MissingSamplerSection,
    type MissingClipItem,
    type MissingPluginSlot,
    type MissingSamplerItem,
} from './MissingAssetsSections';

interface MissingAssetsPanelProps {
    isOpen: boolean;
    onClose: () => void;
}

// ── Auto Search: Audio file matching constants ────────────────────────
const AUDIO_EXTENSIONS = new Set(['wav', 'aif', 'aiff', 'flac', 'mp3', 'ogg', 'm4a', 'aac', 'wma', 'opus']);

/** Extract filename without extension. */
const stem = (name: string): string => {
    const dotIdx = name.lastIndexOf('.');
    return dotIdx > 0 ? name.slice(0, dotIdx) : name;
};

/** Compact: lowercase alphanumeric only (ignores punctuation, spaces, underscores). */
const compact = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Score how well a scanned audio file matches a missing clip name.
 * Returns 0 (no match) to 100 (exact match).
 */
const scoreAudioFileMatch = (clipName: string, scannedName: string): number => {
    const cn = clipName.trim().toLowerCase();
    const sn = scannedName.trim().toLowerCase();
    if (!cn || !sn) return 0;

    // Exact basename match
    if (cn === sn) return 100;

    const clipStem = stem(cn);
    const scanStem = stem(sn);

    // Stem match (name without extension)
    if (clipStem === scanStem) return 95;

    // Compact match (ignore non-alphanumeric)
    const clipCompact = compact(clipStem);
    const scanCompact = compact(scanStem);
    if (clipCompact && scanCompact && clipCompact === scanCompact) return 90;

    // Prefix/suffix overlap
    if (scanStem.startsWith(clipStem) || clipStem.startsWith(scanStem)) return 75;

    // Substring containment
    if (clipCompact && scanCompact) {
        if (scanCompact.includes(clipCompact) || clipCompact.includes(scanCompact)) return 60;
    }

    return 0;
};

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

// ── Grouped missing clip type ──
export type GroupedMissingFile = {
    /** Canonical source file name (the key for grouping). */
    fileName: string;
    /** All clip IDs that reference this source file. */
    clipIds: string[];
    /** Human-readable track names where this file is used. */
    trackNames: string[];
    /** Number of clips using this source file. */
    usageCount: number;
};

export const MissingAssetsPanel = ({ isOpen, onClose }: MissingAssetsPanelProps) => {
    const timelineClips = useEngineStore(selectAllClips);
    const trackIds = useEngineStore((s) => s.tracks.allIds);
    const tracksById = useEngineStore((s) => s.tracks.byId);
    const applyProjectDeltas = useEngineStore((s) => s.applyProjectDeltas);

    const [pluginEntries, setPluginEntries] = useState<engineApi.BrowserFileEntry[]>([]);
    const [scanBusy, setScanBusy] = useState(false);
    const [autoResolveBusy, setAutoResolveBusy] = useState(false);
    const [autoSearchBusy, setAutoSearchBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [searchFolder, setSearchFolder] = useState<string | null>(null);
    const [searchProgress, setSearchProgress] = useState<{
        total: number;
        resolved: number;
        processed: number;
        current: string;
        failed: number;
        phase: 'scanning' | 'matching' | 'done';
        audioFilesFound: number;
    } | null>(null);
    // ── ENTERPRISE: Render-style search log with per-file results ──
    type SearchLogEntry = {
        fileName: string;
        status: 'searching' | 'found' | 'not_found' | 'error';
        matchedPath?: string;
        clipCount?: number;
    };
    const [searchLog, setSearchLog] = useState<SearchLogEntry[]>([]);
    const [searchPopupOpen, setSearchPopupOpen] = useState(false);
    const logRef = useRef<HTMLDivElement>(null);

    // ── Raw missing clips (ungrouped) ──
    const missingClips = useMemo<MissingClipItem[]>(() => {
        return timelineClips
            .filter((c) => c.type === 'audio' && c.isOffline)
            .map((c) => ({
                clipId: c.id,
                clipName: c.name,
                trackName: (trackIds[c.trackIndex] ? tracksById[trackIds[c.trackIndex]]?.name : undefined) ?? `Track ${c.trackIndex + 1}`,
            }));
    }, [timelineClips, trackIds, tracksById]);

    // ── ENTERPRISE: Group clips by source file name to avoid duplicates ──
    const groupedMissingFiles = useMemo<GroupedMissingFile[]>(() => {
        const map = new Map<string, GroupedMissingFile>();
        for (const clip of missingClips) {
            const key = clip.clipName.toLowerCase();
            const existing = map.get(key);
            if (existing) {
                existing.clipIds.push(clip.clipId);
                if (!existing.trackNames.includes(clip.trackName)) {
                    existing.trackNames.push(clip.trackName);
                }
                existing.usageCount++;
            } else {
                map.set(key, {
                    fileName: clip.clipName,
                    clipIds: [clip.clipId],
                    trackNames: [clip.trackName],
                    usageCount: 1,
                });
            }
        }
        return Array.from(map.values());
    }, [missingClips]);

    // ── Choose search folder (separate from running the search) ──
    const pickSearchFolder = useCallback(async () => {
        try {
            const folder = await engineApi.pickFolder();
            if (folder) {
                setSearchFolder(folder);
            }
        } catch (err) {
            console.error('[AutoSearch] pickFolder failed:', err);
            useStatusStore.getState().setError(`Folder selection failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }, []);

    // ── Auto Search: Scan project folder FIRST, then user folder ──
    // ENTERPRISE: Two-phase search — project folder is always checked first
    // (bounced/consolidated clips live there), then user-selected folder.
    const runAutoSearchAudio = useCallback(async () => {
        if (autoSearchBusy || missingClips.length === 0) return;

        setAutoSearchBusy(true);
        setMessage('Preparing search…');
        setSearchLog([]);
        setSearchPopupOpen(true);
        setSearchProgress({ total: 0, resolved: 0, processed: 0, current: 'Preparing search…', failed: 0, phase: 'scanning', audioFilesFound: 0 });

        try {
            // ── Phase 0: Get project folder ──
            let projectFolder: string | null = null;
            try {
                const status = await engineApi.getProjectStatus();
                projectFolder = status.projectFolder ?? null;
            } catch {
                // Project may not have been saved yet — continue without project folder
            }

            // Collect all audio entries from multiple scan sources
            let allAudioEntries: engineApi.BrowserFileEntry[] = [];

            // ── Phase 1: Scan project folder first (highest priority) ──
            if (projectFolder) {
                setSearchProgress({ total: 0, resolved: 0, processed: 0, current: `📂 Scanning project folder…`, failed: 0, phase: 'scanning', audioFilesFound: 0 });
                try {
                    const projectEntries = await engineApi.scanFolderAll(projectFolder);
                    const projectAudio = projectEntries.filter(
                        (e) => !e.is_directory && AUDIO_EXTENSIONS.has(e.extension.toLowerCase()),
                    );
                    if (projectAudio.length > 0) {
                        // Tag project folder files for priority scoring
                        allAudioEntries.push(...projectAudio);
                        setSearchProgress({ total: 0, resolved: 0, processed: 0, current: `📂 Found ${projectAudio.length} audio files in project folder`, failed: 0, phase: 'scanning', audioFilesFound: projectAudio.length });
                    }
                } catch (err) {
                    console.warn('[AutoSearch] Failed to scan project folder:', err);
                }
            }

            // ── Phase 2: Scan user-selected folder ──
            let userFolder = searchFolder;
            // If no user folder AND no project folder had results, prompt
            if (!userFolder && allAudioEntries.length === 0) {
                try {
                    userFolder = await engineApi.pickFolder();
                } catch (err) {
                    console.error('[AutoSearch] pickFolder failed:', err);
                    useStatusStore.getState().setError(`Folder selection failed: ${err instanceof Error ? err.message : String(err)}`);
                    return;
                }
                if (!userFolder) return; // User cancelled
                setSearchFolder(userFolder);
            } else if (!userFolder) {
                // Project folder had results but user hasn't picked a folder yet — that's OK,
                // we'll still ask for one to handle non-project-folder files
                // But first try matching with what we have
            }

            if (userFolder && userFolder !== projectFolder) {
                setSearchProgress({ total: 0, resolved: 0, processed: 0, current: `📂 Scanning ${userFolder.split('/').pop()}…`, failed: 0, phase: 'scanning', audioFilesFound: allAudioEntries.length });
                const userEntries = await engineApi.scanFolderAll(userFolder);
                const userAudio = userEntries.filter(
                    (e) => !e.is_directory && AUDIO_EXTENSIONS.has(e.extension.toLowerCase()),
                );
                // Deduplicate by path (project folder files take priority)
                const existingPaths = new Set(allAudioEntries.map(e => e.path));
                for (const entry of userAudio) {
                    if (!existingPaths.has(entry.path)) {
                        allAudioEntries.push(entry);
                    }
                }
            }

            if (allAudioEntries.length === 0) {
                const folderLabel = userFolder?.split('/').pop() ?? projectFolder?.split('/').pop() ?? 'selected';
                setSearchProgress({ total: 0, resolved: 0, processed: 0, current: `✗ No audio files found`, failed: 0, phase: 'done', audioFilesFound: 0 });
                setSearchLog([{ fileName: '(no audio files in folder)', status: 'not_found' }]);
                setMessage(`No audio files found in: ${folderLabel}`);
                return;
            }

            setMessage(`Found ${allAudioEntries.length} audio files — matching…`);
            setSearchProgress({ total: 0, resolved: 0, processed: 0, current: `Found ${allAudioEntries.length} audio files`, failed: 0, phase: 'matching', audioFilesFound: allAudioEntries.length });

            // Step 2: Read fresh missing clips from store — group by source file
            const currentClips = useEngineStore.getState().clips;

            // Build grouped map: fileName → [clipId, clipId, ...]
            const missingByName = new Map<string, { clipIds: string[]; clipName: string }>();
            for (const id of currentClips.allIds) {
                const c = currentClips.byId[id];
                if (!c || c.type !== 'audio' || !c.isOffline) continue;
                const key = c.name.toLowerCase();
                const existing = missingByName.get(key);
                if (existing) {
                    existing.clipIds.push(c.id);
                } else {
                    missingByName.set(key, { clipIds: [c.id], clipName: c.name });
                }
            }

            if (missingByName.size === 0) {
                setMessage('All clips already resolved');
                setSearchProgress(null);
                return;
            }

            const uniqueFiles = Array.from(missingByName.values());
            setSearchProgress({ total: uniqueFiles.length, resolved: 0, processed: 0, current: `Matching ${uniqueFiles.length} unique files…`, failed: 0, phase: 'matching', audioFilesFound: allAudioEntries.length });
            let resolvedFiles = 0;
            let resolvedClips = 0;
            let failedCount = 0;
            let processedFiles = 0;
            const newLog: SearchLogEntry[] = [];

            for (const group of uniqueFiles) {
                // Find best match for this source file
                let bestScore = 0;
                let bestEntry: engineApi.BrowserFileEntry | null = null;

                for (const entry of allAudioEntries) {
                    let score = scoreAudioFileMatch(group.clipName, entry.name);
                    // ENTERPRISE: Boost score for files inside project folder (Samples/Processed/)
                    if (projectFolder && entry.path.startsWith(projectFolder) && score > 0) {
                        score = Math.min(100, score + 10);
                    }
                    if (score > bestScore) {
                        bestScore = score;
                        bestEntry = entry;
                    }
                    // Fallback: try matching clip name against path segments
                    if (score === 0) {
                        const pathSegments = entry.path.split('/').map(s => s.toLowerCase());
                        const clipLower = stem(group.clipName).toLowerCase();
                        for (const seg of pathSegments) {
                            if (seg.includes(clipLower) || clipLower.includes(stem(seg))) {
                                let pathScore = 45;
                                // Boost project folder matches
                                if (projectFolder && entry.path.startsWith(projectFolder)) {
                                    pathScore = Math.min(100, pathScore + 10);
                                }
                                if (pathScore > bestScore) {
                                    bestScore = pathScore;
                                    bestEntry = entry;
                                }
                                break;
                            }
                        }
                    }
                }

                // ENTERPRISE: Resolve ALL clips that reference this source file
                if (bestEntry && bestScore >= 40) {
                    let groupResolved = 0;
                    for (const clipId of group.clipIds) {
                        try {
                            const response = await engineApi.resolveMissingFileWithDeltas(clipId, bestEntry.path);
                            await applyProjectDeltas(response.deltas, 'missing-assets:auto-search-resolve');
                            groupResolved++;
                            resolvedClips++;
                        } catch (err) {
                            console.error(`[AutoSearch] Failed to resolve clip '${clipId}' for '${group.clipName}':`, err);
                            failedCount++;
                        }
                    }
                    if (groupResolved > 0) resolvedFiles++;
                    // Log entry: found
                    const isProjectFile = projectFolder && bestEntry.path.startsWith(projectFolder);
                    newLog.push({
                        fileName: group.clipName,
                        status: groupResolved > 0 ? 'found' : 'error',
                        matchedPath: (isProjectFile ? '📂 ' : '') + (bestEntry.path.split('/').pop() ?? bestEntry.path),
                        clipCount: groupResolved,
                    });
                    setSearchLog([...newLog]);
                    processedFiles++;
                    setSearchProgress({
                        total: uniqueFiles.length,
                        resolved: resolvedFiles,
                        processed: processedFiles,
                        current: `${group.clipName} — ${groupResolved}/${group.clipIds.length} clips`,
                        failed: failedCount,
                        phase: 'matching',
                        audioFilesFound: allAudioEntries.length,
                    });
                } else {
                    // Log entry: not found
                    newLog.push({
                        fileName: group.clipName,
                        status: 'not_found',
                    });
                    setSearchLog([...newLog]);
                    processedFiles++;
                    setSearchProgress({
                        total: uniqueFiles.length,
                        resolved: resolvedFiles,
                        processed: processedFiles,
                        current: `${group.clipName} — no match`,
                        failed: failedCount,
                        phase: 'matching',
                        audioFilesFound: allAudioEntries.length,
                    });
                }
                // Auto-scroll log
                requestAnimationFrame(() => {
                    if (logRef.current) {
                        logRef.current.scrollTop = logRef.current.scrollHeight;
                    }
                });
            }

            // Step 3: Report results
            const unresolvedFiles = uniqueFiles.length - resolvedFiles;
            if (resolvedFiles > 0 && unresolvedFiles === 0) {
                setSearchProgress({ total: uniqueFiles.length, resolved: resolvedFiles, processed: uniqueFiles.length, current: `✓ All ${resolvedFiles} file(s) resolved! (${resolvedClips} clips)`, failed: failedCount, phase: 'done', audioFilesFound: allAudioEntries.length });
                setMessage(`✓ Resolved all ${resolvedFiles} unique file(s) (${resolvedClips} clips total)`);
            } else if (resolvedFiles > 0) {
                setSearchProgress({ total: uniqueFiles.length, resolved: resolvedFiles, processed: uniqueFiles.length, current: `✓ Done — ${resolvedClips} clips resolved, ${unresolvedFiles} files still missing`, failed: failedCount, phase: 'done', audioFilesFound: allAudioEntries.length });
                setMessage(`Resolved ${resolvedFiles} file(s) (${resolvedClips} clips), ${unresolvedFiles} still missing${failedCount > 0 ? `, ${failedCount} error(s)` : ''}`);
            } else {
                setSearchProgress({ total: uniqueFiles.length, resolved: 0, processed: uniqueFiles.length, current: '✗ No matching files found', failed: 0, phase: 'done', audioFilesFound: allAudioEntries.length });
                setMessage('No matching files found');
            }
        } catch (err) {
            console.error('[AutoSearch] scan failed:', err);
            setMessage(`Auto Search failed: ${err instanceof Error ? err.message : String(err)}`);
            useStatusStore.getState().setError(`Auto Search failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setAutoSearchBusy(false);
            // Don't auto-close popup—user can close it manually
        }
    }, [autoSearchBusy, missingClips.length, applyProjectDeltas, searchFolder]);

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

    // ── ENTERPRISE: Missing sampler & sample-rack samples ──────────────
    // Scans all tracks for sampler/rack-pad sample paths and checks file
    // existence by attempting waveform load. Files that fail are missing.
    const [missingSamplerSamples, setMissingSamplerSamples] = useState<MissingSamplerItem[]>([]);
    const [samplerScanBusy, setSamplerScanBusy] = useState(false);

    useEffect(() => {
        if (!isOpen) {
            setMissingSamplerSamples([]);
            return;
        }
        let cancelled = false;
        setSamplerScanBusy(true);

        const scanSamplerPaths = async () => {
            const candidates: MissingSamplerItem[] = [];
            const storeState = useEngineStore.getState();
            const tIds = storeState.tracks.allIds;
            const tById = storeState.tracks.byId;

            for (const trackId of tIds) {
                const track = tById[trackId];
                if (!track) continue;

                // Single-sample sampler instrument
                const samplerPath = (track.sampler?.sample_path ?? '').trim();
                if (samplerPath && !samplerPath.startsWith('internal://')) {
                    candidates.push({
                        trackId: track.id,
                        trackName: track.name,
                        samplePath: samplerPath,
                    });
                }

                // Sample rack pads
                const rack = track.sample_rack;
                if (rack && Array.isArray(rack.pads)) {
                    for (let p = 0; p < rack.pads.length; p++) {
                        const padPath = (rack.pads[p]?.sample_path ?? '').trim();
                        if (padPath && !padPath.startsWith('internal://')) {
                            candidates.push({
                                trackId: track.id,
                                trackName: track.name,
                                samplePath: padPath,
                                padIndex: p,
                                padName: (rack.pads[p] as { name?: string })?.name || undefined,
                            });
                        }
                    }
                }
            }

            if (candidates.length === 0) {
                if (!cancelled) {
                    setMissingSamplerSamples([]);
                    setSamplerScanBusy(false);
                }
                return;
            }

            // Deduplicate by path to avoid checking the same file multiple times
            const uniquePaths = new Map<string, MissingSamplerItem[]>();
            for (const c of candidates) {
                const key = c.samplePath.toLowerCase();
                const existing = uniquePaths.get(key);
                if (existing) {
                    existing.push(c);
                } else {
                    uniquePaths.set(key, [c]);
                }
            }

            const missing: MissingSamplerItem[] = [];

            for (const [, items] of uniquePaths) {
                if (cancelled) break;
                try {
                    // Attempt to load waveform — if successful, file exists
                    await engineApi.getWaveformPeaksBinary(items[0].samplePath);
                } catch {
                    // File is missing — add all items that reference this path
                    missing.push(...items);
                }
            }

            if (!cancelled) {
                setMissingSamplerSamples(missing);
                setSamplerScanBusy(false);
            }
        };

        void scanSamplerPaths();
        return () => { cancelled = true; };
    }, [isOpen, trackIds, tracksById]);

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
        setMessage('Auto-resolving missing plugins…');
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
        <>
            {/* ENTERPRISE: CSS keyframes for scanning pulse animation */}
            <style>{`
            @keyframes missingMediaScanPulse {
                0%, 100% { opacity: 0.5; }
                50% { opacity: 1; }
            }
        `}</style>
            <div style={{
                position: 'absolute',
                top: 'var(--daw-transport-height)',
                right: 0,
                bottom: 'var(--daw-status-bar-height)',
                width: 340,
                zIndex: 'var(--z-status-popup)',
                borderLeft: 'var(--border-width-1) solid var(--color-divider)',
                background: 'color-mix(in srgb, var(--color-bg-panel) 93%, var(--color-bg-base))',
                display: 'grid',
                gridTemplateRows: 'auto 1fr',
                overflow: 'hidden', // ENTERPRISE: Prevent all child overflow
            }}>
                {/* ── Header ── */}
                <div style={{
                    borderBottom: 'var(--border-width-1) solid var(--color-divider)',
                    display: 'grid',
                    gap: 'var(--space-1-5)',
                    padding: 'var(--space-2) var(--space-2)',
                    overflow: 'hidden', // Prevent header overflow
                }}>
                    {/* Title row */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 'var(--font-size-base)', fontWeight: 'var(--font-weight-bold)', color: 'var(--color-text-primary)' }}>Missing Media</span>
                        <button onClick={onClose} style={{
                            border: 'none',
                            background: 'transparent',
                            color: 'var(--color-text-secondary)',
                            fontSize: 'var(--font-size-base)',
                            cursor: 'pointer',
                            padding: '2px 6px',
                            lineHeight: 1,
                        }} title="Close">✕</button>
                    </div>

                    {/* Summary badges */}
                    <div style={{ display: 'flex', gap: 'var(--space-1)', fontSize: 'var(--font-size-xs)', flexWrap: 'wrap' }}>
                        <span style={{
                            padding: '2px 8px',
                            borderRadius: 'var(--radius-sm)',
                            background: missingClips.length > 0
                                ? 'color-mix(in srgb, var(--color-status-error) 18%, transparent)'
                                : 'color-mix(in srgb, var(--color-status-success) 18%, transparent)',
                            color: missingClips.length > 0 ? 'var(--color-status-error)' : 'var(--color-status-success)',
                            fontWeight: 'var(--font-weight-medium)',
                        }}>
                            {groupedMissingFiles.length} file{groupedMissingFiles.length !== 1 ? 's' : ''} ({missingClips.length} clip{missingClips.length !== 1 ? 's' : ''})
                        </span>
                        <span style={{
                            padding: '2px 8px',
                            borderRadius: 'var(--radius-sm)',
                            background: missingPlugins.length > 0
                                ? 'color-mix(in srgb, var(--color-status-warning) 18%, transparent)'
                                : 'color-mix(in srgb, var(--color-status-success) 18%, transparent)',
                            color: missingPlugins.length > 0 ? 'var(--color-status-warning)' : 'var(--color-status-success)',
                            fontWeight: 'var(--font-weight-medium)',
                        }}>
                            {missingPlugins.length} plugin{missingPlugins.length !== 1 ? 's' : ''}
                        </span>
                        {missingSamplerSamples.length > 0 && (
                            <span style={{
                                padding: '2px 8px',
                                borderRadius: 'var(--radius-sm)',
                                background: 'color-mix(in srgb, var(--color-status-error) 18%, transparent)',
                                color: 'var(--color-status-error)',
                                fontWeight: 'var(--font-weight-medium)',
                            }}>
                                {missingSamplerSamples.length} sample{missingSamplerSamples.length !== 1 ? 's' : ''}
                            </span>
                        )}
                    </div>

                    {/* Search folder row — ENTERPRISE: overflow contained */}
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-1)',
                        background: 'var(--color-bg-secondary)',
                        borderRadius: 'var(--radius-md)',
                        padding: '4px 8px',
                        minHeight: 28,
                        overflow: 'hidden', // Contain folder path overflow
                    }}>
                        <button
                            onClick={() => { void pickSearchFolder(); }}
                            style={{
                                border: 'var(--border-width-1) solid var(--color-divider)',
                                background: 'var(--color-bg-header)',
                                color: 'var(--color-text-primary)',
                                borderRadius: 'var(--radius-sm)',
                                fontSize: 'var(--font-size-2xs)',
                                padding: '2px 6px',
                                cursor: 'pointer',
                                flexShrink: 0,
                                transition: 'background var(--transition-fast)',
                            }}
                            title="Choose search folder"
                        >
                            📂 Folder
                        </button>
                        <span style={{
                            fontSize: 'var(--font-size-2xs)',
                            color: searchFolder ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            flex: 1,
                            minWidth: 0, // ENTERPRISE: Allow flex child to shrink below content size
                            direction: 'rtl',
                            textAlign: 'left',
                        }}>
                            {searchFolder || 'No folder selected'}
                        </span>
                    </div>

                    {/* Action buttons */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                        <button
                            onClick={() => { void runAutoSearchAudio(); }}
                            disabled={autoSearchBusy || missingClips.length === 0}
                            style={{
                                border: 'var(--border-width-1) solid var(--color-divider)',
                                background: autoSearchBusy ? 'var(--color-bg-header)' : 'color-mix(in srgb, var(--color-status-info) 15%, var(--color-bg-header))',
                                color: missingClips.length === 0 ? 'var(--color-text-tertiary)' : 'var(--color-status-info)',
                                borderRadius: 'var(--radius-md)',
                                fontSize: 'var(--font-size-xs)',
                                fontWeight: 'var(--font-weight-semibold)',
                                padding: '4px 10px',
                                cursor: autoSearchBusy || missingClips.length === 0 ? 'default' : 'pointer',
                                opacity: autoSearchBusy || missingClips.length === 0 ? 0.5 : 1,
                                transition: 'background var(--transition-fast)',
                            }}
                        >
                            {autoSearchBusy ? '⏳ Searching…' : '🔍 Auto Search'}
                        </button>
                        <button
                            onClick={() => { void runAutoResolvePlugins(); }}
                            disabled={autoResolveBusy || missingPlugins.length === 0}
                            style={{
                                border: 'var(--border-width-1) solid var(--color-divider)',
                                background: 'var(--color-bg-header)',
                                color: missingPlugins.length === 0 ? 'var(--color-text-tertiary)' : 'var(--color-text-secondary)',
                                borderRadius: 'var(--radius-md)',
                                fontSize: 'var(--font-size-xs)',
                                fontWeight: 'var(--font-weight-semibold)',
                                padding: '4px 10px',
                                cursor: autoResolveBusy || missingPlugins.length === 0 ? 'default' : 'pointer',
                                opacity: autoResolveBusy || missingPlugins.length === 0 ? 0.5 : 1,
                                transition: 'background var(--transition-fast)',
                            }}
                        >
                            {autoResolveBusy ? '⏳ Resolving…' : '🔌 Plugins'}
                        </button>
                    </div>

                    {/* ── ENTERPRISE: Render-popup-style search progress overlay ── */}
                    {searchPopupOpen && searchProgress && (
                        <div style={{
                            position: 'fixed',
                            top: 0,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            zIndex: 9999,
                            background: 'rgba(0, 0, 0, 0.6)',
                            backdropFilter: 'blur(4px)',
                            WebkitBackdropFilter: 'blur(4px)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}>
                            <div style={{
                                width: 460,
                                maxWidth: '90vw',
                                maxHeight: '70vh',
                                background: 'color-mix(in srgb, var(--color-bg-elevated) 98%, transparent)',
                                border: 'var(--border-width-1) solid color-mix(in srgb, var(--color-text-primary) 12%, transparent)',
                                borderRadius: 'var(--radius-lg)',
                                boxShadow: '0 24px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.3)',
                                display: 'grid',
                                gridTemplateRows: 'auto auto 1fr auto',
                                overflow: 'hidden',
                            }}>
                                {/* Popup header */}
                                <div style={{
                                    padding: 'var(--space-3) var(--space-3) var(--space-2)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    borderBottom: 'var(--border-width-1) solid var(--color-divider)',
                                }}>
                                    <div>
                                        <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 'var(--font-weight-bold)', color: 'var(--color-text-primary)' }}>
                                            {searchProgress.phase === 'scanning' ? '🔍 Scanning Folder…' :
                                                searchProgress.phase === 'matching' ? '🔍 Auto Search in Progress' :
                                                    searchProgress.resolved > 0 ? '✓ Search Complete' : '✗ Search Complete'}
                                        </div>
                                        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                                            {searchProgress.phase === 'scanning'
                                                ? `Scanning "${searchFolder?.split('/').pop() ?? 'folder'}"…`
                                                : `${searchProgress.audioFilesFound} audio files scanned`}
                                        </div>
                                    </div>
                                    {searchProgress.phase === 'done' && (
                                        <button
                                            onClick={() => { setSearchPopupOpen(false); setSearchProgress(null); }}
                                            style={{
                                                border: 'none',
                                                background: 'var(--color-bg-hover)',
                                                color: 'var(--color-text-primary)',
                                                borderRadius: 'var(--radius-sm)',
                                                fontSize: 'var(--font-size-sm)',
                                                padding: '4px 10px',
                                                cursor: 'pointer',
                                            }}
                                        >
                                            Close
                                        </button>
                                    )}
                                </div>

                                {/* Progress bar — ENTERPRISE: percentage + folder path display */}
                                <div style={{ padding: 'var(--space-2) var(--space-3)' }}>
                                    {/* Current action label + percentage */}
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginBottom: 4 }}>
                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
                                            {searchProgress.current}
                                        </span>
                                        <span style={{
                                            fontWeight: 'var(--font-weight-bold)',
                                            flexShrink: 0,
                                            marginLeft: 8,
                                            fontSize: 'var(--font-size-sm)',
                                            color: searchProgress.phase === 'done'
                                                ? (searchProgress.resolved > 0 ? 'var(--color-status-success)' : 'var(--color-status-error)')
                                                : 'var(--color-status-info)',
                                        }}>
                                            {searchProgress.phase === 'scanning'
                                                ? '…'
                                                : searchProgress.total > 0
                                                    ? `${Math.round((searchProgress.processed / searchProgress.total) * 100)}%`
                                                    : '0%'}
                                        </span>
                                    </div>
                                    {/* Scanning folder path display */}
                                    {searchProgress.phase === 'scanning' && searchFolder && (
                                        <div style={{
                                            fontSize: 'var(--font-size-2xs)',
                                            color: 'var(--color-text-tertiary)',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                            direction: 'rtl',
                                            textAlign: 'left',
                                            marginBottom: 4,
                                        }}>
                                            📂 {searchFolder}
                                        </div>
                                    )}
                                    {/* Progress bar track */}
                                    <div style={{
                                        height: 8,
                                        borderRadius: 4,
                                        background: 'color-mix(in srgb, var(--color-text-primary) 10%, transparent)',
                                        overflow: 'hidden',
                                        position: 'relative',
                                    }}>
                                        <div style={{
                                            height: '100%',
                                            width: searchProgress.total > 0
                                                ? `${Math.round((searchProgress.processed / searchProgress.total) * 100)}%`
                                                : searchProgress.phase === 'scanning' ? '100%' : '0%',
                                            background: searchProgress.phase === 'done'
                                                ? (searchProgress.resolved > 0 ? 'var(--color-status-success)' : 'var(--color-status-error)')
                                                : 'var(--color-status-info)',
                                            borderRadius: 4,
                                            transition: 'width 0.3s ease, background 0.3s ease',
                                            animation: searchProgress.phase === 'scanning'
                                                ? 'missingMediaScanPulse 1.8s ease-in-out infinite'
                                                : undefined,
                                        }} />
                                    </div>
                                    {/* Resolved / Total counter */}
                                    {searchProgress.phase !== 'scanning' && searchProgress.total > 0 && (
                                        <div style={{
                                            fontSize: 'var(--font-size-2xs)',
                                            color: 'var(--color-text-tertiary)',
                                            marginTop: 4,
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                        }}>
                                            <span>{searchProgress.audioFilesFound} audio files in folder</span>
                                            <span>{searchProgress.resolved} / {searchProgress.total} resolved</span>
                                        </div>
                                    )}
                                </div>

                                {/* Scrollable search log */}
                                <div
                                    ref={logRef}
                                    style={{
                                        overflowY: 'auto',
                                        overflowX: 'hidden',
                                        padding: '0 var(--space-3)',
                                        minHeight: 100,
                                        maxHeight: 300,
                                    }}
                                >
                                    {searchLog.length === 0 && searchProgress.phase === 'scanning' && (
                                        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)', padding: 'var(--space-2) 0' }}>
                                            Scanning folders for audio files…
                                        </div>
                                    )}
                                    {searchLog.map((entry, idx) => (
                                        <div
                                            key={`${entry.fileName}-${idx}`}
                                            style={{
                                                display: 'flex',
                                                alignItems: 'flex-start',
                                                gap: 8,
                                                padding: '4px 0',
                                                borderBottom: idx < searchLog.length - 1 ? 'var(--border-width-1) solid color-mix(in srgb, var(--color-divider) 60%, transparent)' : 'none',
                                                fontSize: 'var(--font-size-xs)',
                                            }}
                                        >
                                            {/* Status icon */}
                                            <span style={{
                                                flexShrink: 0,
                                                width: 18,
                                                textAlign: 'center',
                                                fontSize: 'var(--font-size-sm)',
                                            }}>
                                                {entry.status === 'found' ? '✅' :
                                                    entry.status === 'error' ? '⚠️' :
                                                        entry.status === 'not_found' ? '❌' : '🔄'}
                                            </span>
                                            {/* File info */}
                                            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                                                <div style={{
                                                    color: entry.status === 'found' ? 'var(--color-status-success)' :
                                                        entry.status === 'not_found' ? 'var(--color-text-tertiary)' :
                                                            'var(--color-status-error)',
                                                    fontWeight: 'var(--font-weight-medium)',
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    whiteSpace: 'nowrap',
                                                }}>
                                                    {entry.fileName}
                                                </div>
                                                {entry.status === 'found' && entry.matchedPath && (
                                                    <div style={{
                                                        color: 'var(--color-text-secondary)',
                                                        fontSize: 'var(--font-size-2xs)',
                                                        overflow: 'hidden',
                                                        textOverflow: 'ellipsis',
                                                        whiteSpace: 'nowrap',
                                                    }}>
                                                        → {entry.matchedPath}
                                                        {entry.clipCount && entry.clipCount > 1 ? ` (${entry.clipCount} clips resolved)` : ''}
                                                    </div>
                                                )}
                                                {entry.status === 'not_found' && (
                                                    <div style={{ color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-2xs)' }}>
                                                        No match found
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                {/* Footer with error count */}
                                {(searchProgress.failed > 0 || searchProgress.phase === 'done') && (
                                    <div style={{
                                        padding: 'var(--space-2) var(--space-3)',
                                        borderTop: 'var(--border-width-1) solid var(--color-divider)',
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        fontSize: 'var(--font-size-xs)',
                                    }}>
                                        {searchProgress.failed > 0 && (
                                            <span style={{ color: 'var(--color-status-error)' }}>
                                                {searchProgress.failed} error(s)
                                            </span>
                                        )}
                                        {searchProgress.phase === 'done' && (
                                            <span style={{ color: 'var(--color-text-secondary)', marginLeft: 'auto' }}>
                                                {searchProgress.resolved > 0
                                                    ? `${searchProgress.resolved} of ${searchProgress.total} files resolved`
                                                    : 'No files could be resolved'}
                                            </span>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Status message */}
                    {!searchProgress && message && (
                        <div style={{
                            fontSize: 'var(--font-size-2xs)',
                            color: 'var(--color-text-secondary)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}>{message}</div>
                    )}
                </div>

                {/* ── File list — ENTERPRISE: proper padding on all sides ── */}
                <div style={{
                    overflowY: 'auto',
                    overflowX: 'hidden',
                    padding: 'var(--space-2)',
                    display: 'grid',
                    gap: 'var(--space-2)',
                    alignContent: 'start',
                }}>
                    <MissingAudioSection
                        groupedFiles={groupedMissingFiles}
                        onResolveFile={async (clipIds, path, clipName) => {
                            // ENTERPRISE: Batch resolve ALL clips for this source file
                            let resolved = 0;
                            for (const clipId of clipIds) {
                                try {
                                    const response = await engineApi.resolveMissingFileWithDeltas(clipId, path);
                                    await applyProjectDeltas(response.deltas, 'missing-assets:resolve-file');
                                    resolved++;
                                } catch (err) {
                                    console.error(`[MissingAssets] resolveMissingFile failed for clip ${clipId}:`, err);
                                }
                            }
                            if (resolved > 0) {
                                setMessage(`✓ Resolved '${clipName}' (${resolved} clip${resolved > 1 ? 's' : ''})`);
                            } else {
                                setMessage(`✗ Failed to resolve '${clipName}'`);
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
                                setMessage(name ? `✓ Replaced '${wantedName}' → '${name}'` : `✓ Replaced '${wantedName}'`);
                            } catch (err) {
                                console.error('[MissingAssets] replaceMissingPluginSlot failed:', err);
                                setMessage(`✗ Failed to replace '${wantedName}'`);
                            }
                        }}
                    />
                    <MissingSamplerSection
                        missingSamples={missingSamplerSamples}
                        onResolveSamplerSample={async (trackId, newPath, padIndex) => {
                            try {
                                if (padIndex !== undefined) {
                                    // Sample rack pad replacement
                                    const response = await engineApi.setSampleRackPadSampleWithDeltas(
                                        trackId,
                                        padIndex,
                                        newPath,
                                    );
                                    await applyProjectDeltas(response.deltas, 'missing-assets:resolve-sampler-pad');
                                } else {
                                    // Single sampler instrument replacement
                                    const response = await engineApi.setSamplerSampleWithDeltas(
                                        trackId,
                                        newPath,
                                    );
                                    await applyProjectDeltas(response.deltas, 'missing-assets:resolve-sampler');
                                }
                                const fileName = newPath.split('/').pop() ?? newPath;
                                setMessage(`✓ Replaced sampler sample → '${fileName}'`);
                                // Remove resolved item from the missing list immediately
                                setMissingSamplerSamples((prev) =>
                                    prev.filter((item) => !(
                                        item.trackId === trackId &&
                                        (padIndex !== undefined ? item.padIndex === padIndex : item.padIndex === undefined)
                                    )),
                                );
                            } catch (err) {
                                console.error('[MissingAssets] resolve sampler sample failed:', err);
                                const fileName = newPath.split('/').pop() ?? newPath;
                                setMessage(`✗ Failed to replace sampler sample: ${fileName}`);
                            }
                        }}
                    />
                </div>
            </div>
        </>
    );
};
