import { useCallback, useEffect } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { MidiNote } from '@/widgets/PianoRoll/PianoRoll';
import type { ProjectDelta } from '@/shared/api/engine';
import { dreamGlobals } from '@/shared/lib/dreamGlobals';

type MidiEnvelopePoint = { beat: number; value: number };
type MidiEnvelope = { paramId: string; points: MidiEnvelopePoint[] };

type Args = {
    flushTrackControlFinals: () => Promise<void>;
    flushMidiThrottles: () => void;
    dirtyMidiNotesClipIdsRef: React.MutableRefObject<Set<string>>;
    dirtyMidiEnvelopeClipIdsRef: React.MutableRefObject<Set<string>>;
    latestMidiNotesRef: React.MutableRefObject<Record<string, MidiNote[]>>;
    latestMidiEnvelopesRef: React.MutableRefObject<Record<string, MidiEnvelope[]>>;
    serializeMidiNotesToFrames: (notes: MidiNote[]) => Array<{ pitch: number; velocity: number; startFrames: number; durationFrames: number }>;
    applyProjectDeltas: (deltas: ProjectDelta[], reason?: string) => Promise<void>;
};

export function usePendingMidiFlush({
    flushTrackControlFinals,
    flushMidiThrottles,
    dirtyMidiNotesClipIdsRef,
    dirtyMidiEnvelopeClipIdsRef,
    latestMidiNotesRef,
    latestMidiEnvelopesRef,
    serializeMidiNotesToFrames,
    applyProjectDeltas,
}: Args): void {
    const flushPendingMidiEdits = useCallback(async () => {
        flushMidiThrottles();
        const noteClipIds = Array.from(dirtyMidiNotesClipIdsRef.current);
        const envelopeClipIds = Array.from(dirtyMidiEnvelopeClipIdsRef.current);

        const noteTasks = noteClipIds.map((clipId) =>
            engineApi
                .updateMidiClipWithDeltas(clipId, serializeMidiNotesToFrames(latestMidiNotesRef.current[clipId] ?? []), {
                    pushUndoStep: true,
                })
                .then(async (response) => {
                    await applyProjectDeltas(response.deltas, 'midi-notes:flush');
                    return { ok: true as const, clipId };
                })
                .catch((err) => {
                    console.error('[DawShell] flushPendingMidiEdits updateMidiClip failed:', err);
                    return { ok: false as const, clipId };
                }),
        );

        const envelopeTasks = envelopeClipIds.map((clipId) =>
            engineApi
                .setMidiClipEnvelopes(clipId, latestMidiEnvelopesRef.current[clipId] ?? [], { pushUndoStep: true })
                .then(() => ({ ok: true as const, clipId }))
                .catch((err) => {
                    console.error('[DawShell] flushPendingMidiEdits setMidiClipEnvelopes failed:', err);
                    return { ok: false as const, clipId };
                }),
        );

        const [noteResults, envelopeResults] = await Promise.all([Promise.all(noteTasks), Promise.all(envelopeTasks)]);

        for (const result of noteResults) {
            if (result.ok) dirtyMidiNotesClipIdsRef.current.delete(result.clipId);
        }
        for (const result of envelopeResults) {
            if (result.ok) dirtyMidiEnvelopeClipIdsRef.current.delete(result.clipId);
        }
    }, [
        applyProjectDeltas,
        dirtyMidiEnvelopeClipIdsRef,
        dirtyMidiNotesClipIdsRef,
        flushMidiThrottles,
        latestMidiEnvelopesRef,
        latestMidiNotesRef,
        serializeMidiNotesToFrames,
    ]);

    useEffect(() => {
        const flushPendingEdits = async () => {
            await flushTrackControlFinals();
            await flushPendingMidiEdits();
        };
        dreamGlobals.setFlushPendingEdits(flushPendingEdits);

        return () => {
            dreamGlobals.clearFlushPendingEdits(flushPendingEdits);
        };
    }, [flushTrackControlFinals, flushPendingMidiEdits]);
}
