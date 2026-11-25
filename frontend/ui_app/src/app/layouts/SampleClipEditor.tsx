import { useCallback, useEffect, useRef, useState } from 'react';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { useGridStore } from '@/shared/stores/useGridStore';
import * as engineApi from '@/shared/api/engine';
import { divisionToInterval } from '@/shared/lib/gridSnap';
import { beatDurationToFrames, frameToBeat, resolveBpm, resolveSampleRate, formatBeatsAsBBS, clampPitchShift, DEFAULT_TIME_SIG_NUMERATOR, MIN_BPM, MAX_BPM } from '@/shared/lib/audioMath';
import { getClipAvailableSourceFrames, getClipSourcePerTimelineFrame } from '@/shared/lib/clipSourceMath';
import { ClipEditorShell } from '@/widgets/ClipEditor/ClipEditorShell';
import { ClipEditorToolbar } from '@/widgets/ClipEditor/ClipEditorToolbar';
import { SampleClipEditorSidebar } from './SampleClipEditorSidebar';
import { SampleClipWaveformPane } from './SampleClipWaveformPane';


export const SampleClipEditor = ({ clip }: { clip: TimelineClip }) => {
    const sampleRate = useEngineStore((s) => resolveSampleRate(s.projectSampleRate, s.transport.sample_rate));
    const bpm = useEngineStore((s) => resolveBpm(s.transport.bpm));
    const gridDivision = useGridStore((s) => s.division);
    const gridTriplet = useGridStore((s) => s.triplet);
    const beatsPerBar = useGridStore((s) => Math.max(1, Math.round(s.fixedNumerator || DEFAULT_TIME_SIG_NUMERATOR)));

    const [zoomX, setZoomX] = useState(1);
    const [zoomY, setZoomY] = useState(1);
    const [draftWarpEnabled, setDraftWarpEnabled] = useState<boolean>(Boolean(clip.isWarped));
    const [draftWarpMode, setDraftWarpMode] = useState<number>((clip.warpMode ?? 0) > 0 ? 1 : 0);
    const [draftWarpBaseBpm, setDraftWarpBaseBpm] = useState<number>(Math.max(MIN_BPM, Math.round(clip.warpBaseBpm ?? bpm)));
    const [draftPitch, setDraftPitch] = useState<number>(clip.pitchShiftSemitones ?? 0);
    const isPreviewingRef = useRef(false);
    const [isPreviewing, setIsPreviewing] = useState(false);
    const commitInFlightRef = useRef(false);
    const editorRootRef = useRef<HTMLDivElement>(null);

    // Bug #55 fix: Sync draft state when clip changes.
    const prevClipIdRef = useRef(clip.id);
    useEffect(() => {
        if (prevClipIdRef.current !== clip.id) {
            prevClipIdRef.current = clip.id;
            setDraftWarpEnabled(Boolean(clip.isWarped));
            setDraftWarpMode((clip.warpMode ?? 0) > 0 ? 1 : 0);
            setDraftWarpBaseBpm(Math.max(MIN_BPM, Math.round(clip.warpBaseBpm ?? bpm)));
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
        const liveClip = useEngineStore.getState().clips.byId[clip.id];
        if (!liveClip) return;

        const previousPitch = liveClip.pitchShiftSemitones ?? 0;
        const previousDurationSamples = liveClip.durationSamples;
        const previousDurationBeats = liveClip.durationBeats;

        let nextDurationBeats = liveClip.durationBeats;
        let nextDurationSamples = liveClip.durationSamples;

        if (!liveClip.isWarped) {
            const sourcePerTimeline = getClipSourcePerTimelineFrame(
                { ...liveClip, pitchShiftSemitones: nextPitch },
                sampleRate,
            );
            const availableSource = getClipAvailableSourceFrames(liveClip, sampleRate);
            nextDurationSamples = Math.max(1, Math.round(availableSource / sourcePerTimeline));
            nextDurationBeats = frameToBeat(nextDurationSamples, bpm, sampleRate);
        }

        useEngineStore.getState().patchClip(clip.id, {
            pitchShiftSemitones: nextPitch,
            durationSamples: nextDurationSamples,
            durationBeats: nextDurationBeats,
        });

        setDraftPitch(nextPitch);
        try {
            const response = await engineApi.setClipPitchWithDeltas({
                clipId: clip.id,
                pitchShiftSemitones: nextPitch,
            });
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'sample-clip-editor:pitch');
        } catch (err) {
            useEngineStore.getState().patchClip(clip.id, {
                pitchShiftSemitones: previousPitch,
                durationSamples: previousDurationSamples,
                durationBeats: previousDurationBeats,
            });
            console.error('[SampleClipEditor] setClipPitch failed:', err);
            useStatusStore.getState().setError(`Pitch change failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }, [clip.id, bpm, sampleRate]);

    // Bug #10 fix: Serialization guard for async commits.
    const commitWarp = useCallback(async (next: { enabled: boolean; mode: number; baseBpm: number }) => {
        if (commitInFlightRef.current) return;
        commitInFlightRef.current = true;
        // BUG-038 FIX: Use MIN_BPM/MAX_BPM constants instead of hardcoded 20/300.
        const base = Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(next.baseBpm)));
        const store = useEngineStore.getState();
        const sr = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
        const projectTempo = resolveBpm(store.transport.bpm);
        const liveClip = store.clips.byId[clip.id];
        // BUG-039 FIX: Clear commitInFlightRef on early return to prevent permanent block.
        if (!liveClip) {
            commitInFlightRef.current = false;
            return;
        }

        const previousWarpEnabled = liveClip.isWarped;
        const previousWarpMode = liveClip.warpMode;
        const previousWarpBaseBpm = liveClip.warpBaseBpm;
        const previousDurationBeats = liveClip.durationBeats;
        const previousDurationSamples = liveClip.durationSamples;
        const previousSourceFrames = liveClip.warpSourceDurationFrames;

        const sourceFrames = getClipAvailableSourceFrames(liveClip, sr);
        const sourcePerTimeline = getClipSourcePerTimelineFrame(liveClip, sr);
        const nextDurationBeats = next.enabled ? frameToBeat(sourceFrames, base, sr) : frameToBeat(Math.max(1, Math.round(sourceFrames / sourcePerTimeline)), projectTempo, sr);
        const nextDurationSamples = next.enabled ? Math.max(1, beatDurationToFrames(nextDurationBeats, projectTempo, sr)) : Math.max(1, Math.round(sourceFrames / sourcePerTimeline));

        useEngineStore.getState().patchClip(clip.id, {
            isWarped: next.enabled,
            warpMode: next.mode > 0 ? 1 : 0,
            warpBaseBpm: base,
            warpSourceDurationFrames: sourceFrames,
            durationBeats: nextDurationBeats,
            durationSamples: nextDurationSamples,
        });

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
            useEngineStore.getState().patchClip(clip.id, {
                isWarped: previousWarpEnabled,
                warpMode: previousWarpMode,
                warpBaseBpm: previousWarpBaseBpm,
                warpSourceDurationFrames: previousSourceFrames,
                durationBeats: previousDurationBeats,
                durationSamples: previousDurationSamples,
            });
            console.error('[SampleClipEditor] setClipWarp failed:', err);
            useStatusStore.getState().setError(`Warp change failed: ${err instanceof Error ? err.message : String(err)}`);
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
            useStatusStore.getState().setError(`Audio preview failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }, [clip.filePath, isPreviewing]);

    // Bug #28 fix: Use ref-based cleanup that always stops preview on unmount.
    useEffect(() => () => {
        if (isPreviewingRef.current) {
            void engineApi.stopPreview().catch((err) => console.warn('[Dream] stopPreview cleanup failed:', err));
            isPreviewingRef.current = false;
        }
    }, []);

    // ── Scroll-wheel zoom for clip editor ──
    // Cmd/Ctrl+Scroll = horizontal zoom (zoomX), Alt+Scroll = vertical zoom (zoomY).
    // Uses passive:false wheel listener on the editor container for smooth,
    // responsive zoom matching the arrangement timeline UX.
    useEffect(() => {
        const el = editorRootRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            const isZoomH = e.metaKey || e.ctrlKey;
            const isZoomV = e.altKey;
            if (!isZoomH && !isZoomV) return;
            e.preventDefault();
            e.stopPropagation();
            const factor = e.deltaY > 0 ? 0.9 : 1.1; // 10% steps
            if (isZoomH) {
                setZoomX((prev) => Math.max(0.05, Math.min(128, prev * factor)));
            }
            if (isZoomV) {
                setZoomY((prev) => Math.max(0.5, Math.min(4, prev * factor)));
            }
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, []);

    return (
        <div ref={editorRootRef} style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--color-bg-base)', outline: 'none' }}>
            <ClipEditorToolbar>
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
            </ClipEditorToolbar>

            <ClipEditorShell sidebar={<SampleClipEditorSidebar
                clipDurationBeats={clipDurationBeats}
                filePath={clip.filePath}
                sampleRate={clip.sampleRate}
                channels={clip.channels}
                numFrames={clip.numFrames}
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
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
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
