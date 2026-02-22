import { useCallback, useEffect, useState } from 'react';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useGridStore } from '@/shared/stores/useGridStore';
import * as engineApi from '@/shared/api/engine';
import { divisionToInterval } from '@/shared/lib/gridSnap';
import { beatDurationToFrames, frameToBeat, resolveSampleRate } from '@/shared/lib/audioMath';
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
    const bpm = useEngineStore((s) => s.projectBpm || s.transport.bpm || 120);
    const gridDivision = useGridStore((s) => s.division);
    const gridTriplet = useGridStore((s) => s.triplet);

    const [zoomX, setZoomX] = useState(1);
    const [draftWarpEnabled, setDraftWarpEnabled] = useState<boolean>(Boolean(clip.isWarped));
    const [draftWarpMode, setDraftWarpMode] = useState<number>((clip.warpMode ?? 0) > 0 ? 1 : 0);
    const [draftWarpBaseBpm, setDraftWarpBaseBpm] = useState<number>(Math.max(20, Math.round(clip.warpBaseBpm ?? bpm)));
    const [draftPitch, setDraftPitch] = useState<number>(clip.pitchShiftSemitones ?? 0);
    const [isPreviewing, setIsPreviewing] = useState(false);

    const durationSamples = Math.max(0, clip.durationSamples ?? 0);
    const beatsPerBar = 4;
    const clipDurationBeats = Math.max(0.25, clip.durationBeats || frameToBeat(durationSamples, bpm, sampleRate));
    const gridStep = Math.max(0.0625, divisionToInterval(gridDivision, beatsPerBar, gridTriplet));
    const pxPerBeat = 82 * zoomX;

    const commitPitch = useCallback(async (val: number) => {
        const nextPitch = Math.max(-48, Math.min(48, val));
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

    const commitWarp = useCallback(async (next: { enabled: boolean; mode: number; baseBpm: number }) => {
        const base = Math.max(20, Math.min(300, Math.round(next.baseBpm)));
        const store = useEngineStore.getState();
        const sr = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
        const projectTempo = store.projectBpm || store.transport.bpm || 120;
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
        }
    }, [clip.id]);

    const togglePreview = useCallback(async () => {
        if (!clip.filePath) return;
        try {
            if (isPreviewing) {
                await engineApi.stopPreview();
                setIsPreviewing(false);
                return;
            }
            await engineApi.previewAudioFile(clip.filePath);
            setIsPreviewing(true);
        } catch (err) {
            console.error('[SampleClipEditor] preview failed:', err);
        }
    }, [clip.filePath, isPreviewing]);

    useEffect(() => () => {
        if (isPreviewing) {
            void engineApi.stopPreview();
        }
    }, [isPreviewing]);

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--color-bg-panel)' }}>
            <div style={{ height: 28, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '0 10px', borderBottom: '1px solid var(--color-divider)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', fontWeight: 'var(--font-weight-bold)' as unknown as number, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{clip.name}</span>
                <span style={{ fontFamily: 'var(--font-mono)' }}>{clipDurationBeats.toFixed(2)} beats</span>
            </div>

            <ClipEditorShell sidebar={<SampleClipEditorSidebar
                clipDurationBeats={clipDurationBeats}
                filePath={clip.filePath}
                draftWarpEnabled={draftWarpEnabled}
                draftWarpMode={draftWarpMode}
                draftWarpBaseBpm={draftWarpBaseBpm}
                draftPitch={draftPitch}
                zoomX={zoomX}
                isPreviewing={isPreviewing}
                setDraftWarpBaseBpm={setDraftWarpBaseBpm}
                setDraftPitch={setDraftPitch}
                setZoomX={setZoomX}
                onCommitWarp={(next) => { void commitWarp(next); }}
                onCommitPitch={(value) => { void commitPitch(value); }}
                onTogglePreview={() => { void togglePreview(); }}
            />}>
                <div style={{ flex: 1, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
                    {clip.filePath && durationSamples > 0 && !clip.isOffline ? (
                        <SampleClipWaveformPane
                            filePath={clip.filePath}
                            durationSamples={durationSamples}
                            sourceOffset={clip.sourceOffset}
                            clipDurationBeats={clipDurationBeats}
                            pxPerBeat={pxPerBeat}
                            gridStep={gridStep}
                        />
                    ) : (
                        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-base)', border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-lg)' }}>
                            {clip.isOffline ? 'Media offline — resolve file in timeline (double-click clip).' : 'Audio source unavailable'}
                        </div>
                    )}
                </div>
            </ClipEditorShell>
        </div>
    );
};
