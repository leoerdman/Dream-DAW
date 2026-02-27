import * as engine from '@/shared/api/engine';
import { beatDurationToFrames, beatToFrame, resolveBpm, resolveSampleRate } from '@/shared/lib/audioMath';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import type { KeyboardShortcutHandlerEnv } from './types';

type ShortcutCtx = KeyboardShortcutHandlerEnv['ctx'];

export async function handleCreateMidiClipRangeShortcut(
    e: KeyboardEvent,
    ctx: ShortcutCtx,
): Promise<boolean> {
    const { activePanel, marqueeSelection, trackIds, tracksById } = ctx;
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.code !== 'KeyM') return false;
    if (activePanel !== 'arrangement' || !marqueeSelection) return false;
    e.preventDefault();
    e.stopPropagation();

    const minTrack = Math.min(marqueeSelection.startTrack, marqueeSelection.endTrack);
    const maxTrack = Math.max(marqueeSelection.startTrack, marqueeSelection.endTrack);
    const store = useEngineStore.getState();
    const bpm = resolveBpm(store.projectBpm, store.transport.bpm);
    const sampleRate = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
    const startBeat = Math.min(marqueeSelection.startBeat, marqueeSelection.endBeat);
    const endBeat = Math.max(marqueeSelection.startBeat, marqueeSelection.endBeat);
    const durationBeats = Math.max(0.25, endBeat - startBeat);
    const positionFrames = Math.max(0, beatToFrame(startBeat, bpm, sampleRate));
    const durationFrames = Math.max(1, beatDurationToFrames(durationBeats, bpm, sampleRate));
    const midiTrackIndices: number[] = [];
    for (let i = minTrack; i <= maxTrack; i += 1) {
        const trackId = trackIds[i];
        const track = trackId ? tracksById[trackId] : undefined;
        if (!track) continue;
        const trackType = (track.track_type ?? '').toLowerCase();
        if (!trackType.includes('midi')) continue;
        if (trackType.includes('group') || trackType.includes('master') || trackType.includes('bus') || trackType.includes('return')) continue;
        midiTrackIndices.push(i);
    }
    if (midiTrackIndices.length === 0) return true;
    try {
        await Promise.all(
            midiTrackIndices.map((trackIndex) =>
                engine
                    .createMidiClipWithDeltas(trackIndex, positionFrames, durationFrames)
                    .then((r) => useEngineStore.getState().applyProjectDeltas(r.deltas, 'keyboard:create-midi-clip-range')),
            ),
        );
    } catch (err) {
        console.error('[Shortcuts] Create MIDI clips from box failed:', err);
    }
    return true;
}
