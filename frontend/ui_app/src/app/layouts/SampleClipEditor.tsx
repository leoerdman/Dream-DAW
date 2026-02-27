import { useCallback, useEffect, useRef, useState } from 'react';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useGridStore } from '@/shared/stores/useGridStore';
import * as engineApi from '@/shared/api/engine';
import { divisionToInterval } from '@/shared/lib/gridSnap';
import { beatDurationToFrames, frameToBeat, resolveBpm, resolveSampleRate, formatBeatsAsBBS, clampPitchShift } from '@/shared/lib/audioMath';
import { ClipEditorShell } from '@/widgets/ClipEditor/ClipEditorShell';
import { SampleClipEditorSidebar } from './SampleClipEditorSidebar';
import { SampleClipWaveformPane } from './SampleClipWaveformPane';

function toClipEntityState(clips: TimelineClip[]) {
    const byId = Object.fromEntries(clips.map((c) => [c.id, c]));
    return {
        clipsById: byId,
        clips: {
            byId,
            allIds: clips.map((c) => c.id),
        },
    };
}

export const SampleClipEditor = ({ clip }: { clip: TimelineClip }) => {
    const sampleRate = useEngineStore((s) => resolveSampleRate(s.projectSampleRate, s.transport.sample_rate));
    const bpm = useEngineStore((s) => resolveBpm(s.projectBpm, s.transport.bpm));
    const gridDivision = useGridStore((s) => s.division);
    const gridTriplet = useGridStore((s) => s.triplet);
    const beatsPerBar = useGridStore((s) => Math.max(1, Math.round(s.fixedNumerator || 4)));

    const [zoomX, setZoomX] = useState(1);
    const [zoomY, setZoomY] = useState(1);
    const [draftWarpEnabled, setDraftWarpEnabled] = useState<boolean>(Boolean(clip.isWarped));
    const [draftWarpMode, setDraftWarpMode] = useState<number>((clip.warpMode ?? 0) > 0 ? 1 : 0);
    const [draftWarpBaseBpm, setDraftWarpBaseBpm] = useState<number>(Math.max(20, Math.round(clip.warpBaseBpm ?? bpm)));
    const [draftPitch, setDraftPitch] = useState<number>(clip.pitchShiftSemitones ?? 0);
    const isPreviewingRef = useRef(false);
    const [isPreviewing, setIsPreviewing] = useState(false);
    const commitInFlightRef = useRef(false);

    // Bug #55 fix: Sync draft state when clip changes.
    const prevClipIdRef = useRef(clip.id);
    useEffect(() => {
        if (prevClipIdRef.current !== clip.id) {
            prevClipIdRef.current = clip.id;
            setDraftWarpEnabled(Boolean(clip.isWarped));
            setDraftWarpMode((clip.warpMode ?? 0) > 0 ? 1 : 0);
            setDraftWarpBaseBpm(Math.max(20, Math.round(clip.warpBaseBpm ?? bpm)));
            setDraftPitch(clip.pitchShiftSemitones ?? 0);
        }
    }, [clip.id, clip.isWarped, clip.warpMode, clip.warpBaseBpm, clip.pitchShiftSemitones, bpm]);

    const durationSamples = Math.max(0, clip.durationSamples ?? 0);
    const clipDurationBeats = Math.max(0.25, clip.durationBeats || frameToBeat(durationSamples, bpm, sampleRate));
    const visualDurationSamples = (clip.isWarped && clip.warpSourceDurationFrames) ? clip.warpSourceDurationFrames : durationSamples;
    const gridStep = Math.max(0.0625, divisionToInterval(gridDivision, beatsPerBar, gridTriplet));
    /** BUG-016 FIX: Named constant for sample editor's own base pixels-per-beat.
     *  This is independent of the arrangement timeline's zoom — the sample editor
     *  uses its own zoom context via `zoomX`. */
    const SAMPLE_EDITOR_BASE_PPB = 82;
    const pxPerBeat = SAMPLE_EDITOR_BASE_PPB * zoomX;

    const toolbarColor = clip.color || 'var(--color-accent-primary)';

    const commitPitch = useCallback(async (val: number) => {
        const nextPitch = clampPitchShift(val);
        const previousClips = useEngineStore.getState().timelineClips;
        useEngineStore.setState((state) => ({
            ...(() => {
                const timelineClips = state.timelineClips.map((c) => {
                    if (c.id !== clip.id) return c;
                    let nextDurationBeats = c.durationBeats;
                    let nextDurationSamples = c.durationSamples;
                    if (!c.isWarped) {
                        const pitchMultiplier = Math.pow(2.0, nextPitch / 12.0);
                        const sourceFrames = Math.max(1, c.warpSourceDurationFrames ?? c.durationSamples ?? 1);
                        nextDurationSamples = Math.max(1, Math.round(sourceFrames / pitchMultiplier));
                        nextDurationBeats = frameToBeat(nextDurationSamples, bpm, sampleRate);
                    }
                    return { ...c, pitchShiftSemitones: nextPitch, durationSamples: nextDurationSamples, durationBeats: nextDurationBeats };
                });
                return {
                    timelineClips,
                    ...toClipEntityState(timelineClips),
                };
            })(),
        }));
        setDraftPitch(nextPitch);
        try {
            const response = await engineApi.setClipPitchWithDeltas({
                clipId: clip.id,
                pitchShiftSemitones: nextPitch,
            });
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'sample-clip-editor:pitch');
        } catch (err) {
            useEngineStore.setState({
                timelineClips: previousClips,
                ...toClipEntityState(previousClips),
            });
            console.error('[SampleClipEditor] setClipPitch failed:', err);
        }
    }, [clip.id, bpm, sampleRate]);

    // Bug #10 fix: Serialization guard for async commits.
    const commitWarp = useCallback(async (next: { enabled: boolean; mode: number; baseBpm: number }) => {
        if (commitInFlightRef.current) return;
        commitInFlightRef.current = true;
        const base = Math.max(20, Math.min(300, Math.round(next.baseBpm)));
        const store = useEngineStore.getState();
        const sr = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
        const projectTempo = resolveBpm(store.projectBpm, store.transport.bpm);
        const liveClip = store.timelineClips.find(c => c.id === clip.id);
        if (!liveClip) return;
        const sourceFrames = Math.max(1, liveClip.warpSourceDurationFrames ?? liveClip.durationSamples ?? 1);
        const pitchMultiplier = Math.pow(2.0, (liveClip.pitchShiftSemitones ?? 0) / 12.0);
        const nextDurationBeats = next.enabled ? frameToBeat(sourceFrames, base, sr) : frameToBeat(Math.round(sourceFrames / pitchMultiplier), projectTempo, sr);
        const nextDurationSamples = next.enabled ? Math.max(1, beatDurationToFrames(nextDurationBeats, projectTempo, sr)) : Math.max(1, Math.round(sourceFrames / pitchMultiplier));

        const previousClips = useEngineStore.getState().timelineClips;
        useEngineStore.setState((state) => ({
            ...(() => {
                const timelineClips = state.timelineClips.map((c) => c.id !== clip.id ? c : ({
                    ...c,
                    isWarped: next.enabled,
                    warpMode: next.mode > 0 ? 1 : 0,
                    warpBaseBpm: base,
                    warpSourceDurationFrames: sourceFrames,
                    durationBeats: nextDurationBeats,
                    durationSamples: nextDurationSamples,
                }));
                return {
                    timelineClips,
                    ...toClipEntityState(timelineClips),
                };
            })(),
        }));

        setDraftWarpEnabled(next.enabled);
        setDraftWarpMode(next.mode > 0 ? 1 : 0);
        setDraftWarpBaseBpm(base);
        try {
            const response = await engineApi.setClipWarpWithDeltas({
                clipId: clip.id,
                isWarped: next.enabled,
                warpMode: next.mode > 0 ? 1 : 0,
                warpBaseBpm: base,
            });
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'sample-clip-editor:warp');
        } catch (err) {
            useEngineStore.setState({
                timelineClips: previousClips,
                ...toClipEntityState(previousClips),
            });
            console.error('[SampleClipEditor] setClipWarp failed:', err);
        } finally {
            commitInFlightRef.current = false;
        }
    }, [clip.id]);

    const togglePreview = useCallback(async () => {
        if (!clip.filePath) return;
        try {
            if (isPreviewing) {
                await engineApi.stopPreview();
                setIsPreviewing(false);
                isPreviewingRef.current = false;
                return;
            }
            await engineApi.previewAudioFile(clip.filePath);
            setIsPreviewing(true);
            isPreviewingRef.current = true;
        } catch (err) {
            console.error('[SampleClipEditor] preview failed:', err);
        }
    }, [clip.filePath, isPreviewing]);

    // Bug #28 fix: Use ref-based cleanup that always stops preview on unmount.
    useEffect(() => () => {
        if (isPreviewingRef.current) {
            void engineApi.stopPreview();
            isPreviewingRef.current = false;
        }
    }, []);

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--color-bg-panel)', outline: 'none' }}>
            <div style={{
                height: 'var(--daw-transport-height)',
                display: 'flex',
                alignItems: 'center',
                padding: '0 var(--space-2)',
                gap: 'var(--space-1)',
                background: 'var(--color-bg-elevated)',
                borderBottom: 'var(--space-px) solid var(--color-divider)',
                flexShrink: 0,
            }}>
                <span style={{
                    fontSize: 'var(--font-size-xs)',
                    color: 'var(--color-text-primary)',
                    fontWeight: 600,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    marginLeft: 4,
                }}>{clip.name || 'Audio Clip'}</span>

                <div style={{ width: 1, height: 16, background: 'var(--color-divider-light)', margin: '0 var(--space-1)' }} />
                <div style={{
                    padding: 'var(--space-0-5) var(--space-2)',
                    background: `color-mix(in srgb, ${toolbarColor} 14%, transparent)`,
                    border: `var(--space-px) solid color-mix(in srgb, ${toolbarColor} 32%, transparent)`,
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 'var(--font-size-2xs)',
                    color: toolbarColor,
                    fontWeight: 'var(--font-weight-semibold)',
                    fontFamily: 'var(--font-role-data)',
                    letterSpacing: 'var(--letter-spacing-normal)',
                }}>
                    Length: {formatBeatsAsBBS(clipDurationBeats, beatsPerBar)}
                </div>
            </div>

            <ClipEditorShell sidebar={<SampleClipEditorSidebar
                clipDurationBeats={clipDurationBeats}
                filePath={clip.filePath}
                draftWarpEnabled={draftWarpEnabled}
                draftWarpMode={draftWarpMode}
                draftWarpBaseBpm={draftWarpBaseBpm}
                draftPitch={draftPitch}
                zoomX={zoomX}
                zoomY={zoomY}
                isPreviewing={isPreviewing}
                setDraftWarpBaseBpm={setDraftWarpBaseBpm}
                setDraftPitch={setDraftPitch}
                setZoomX={setZoomX}
                setZoomY={setZoomY}
                onCommitWarp={(next) => { void commitWarp(next); }}
                onCommitPitch={(value) => { void commitPitch(value); }}
                onTogglePreview={() => { void togglePreview(); }}
            />}>
                <div style={{ flex: 1, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
                    {clip.filePath && visualDurationSamples > 0 && !clip.isOffline ? (
                        <SampleClipWaveformPane
                            filePath={clip.filePath}
                            durationSamples={visualDurationSamples}
                            sourceOffset={clip.sourceOffset}
                            clipDurationBeats={clipDurationBeats}
                            pxPerBeat={pxPerBeat}
                            gridStep={gridStep}
                            waveHeightScale={zoomY}
                            color={toolbarColor}
                            beatsPerBar={beatsPerBar}
                        />
                    ) : (
                        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-base)', border: 'var(--space-px) dashed var(--color-divider)', borderRadius: 'var(--radius-lg)' }}>
                            {clip.isOffline ? 'Media offline — resolve file in timeline (double-click clip).' : 'Audio source unavailable'}
                        </div>
                    )}
                </div>
            </ClipEditorShell>
        </div>
    );
};
