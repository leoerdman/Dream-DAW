import { useEffect } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { MidiNote } from '@/widgets/PianoRoll/PianoRoll';
import type { ProjectDelta } from '@/shared/api/engine';

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

export function usePointerUpFinalizer({
    flushTrackControlFinals,
    flushMidiThrottles,
    dirtyMidiNotesClipIdsRef,
    dirtyMidiEnvelopeClipIdsRef,
    latestMidiNotesRef,
    latestMidiEnvelopesRef,
    serializeMidiNotesToFrames,
    applyProjectDeltas,
}: Args): void {
    useEffect(() => {
        const onPointerUp = () => {
            void flushTrackControlFinals();
            flushMidiThrottles();
            if (dirtyMidiNotesClipIdsRef.current.size === 0 && dirtyMidiEnvelopeClipIdsRef.current.size === 0) return;

            for (const clipId of Array.from(dirtyMidiNotesClipIdsRef.current)) {
                const notes = latestMidiNotesRef.current[clipId] ?? [];
                void engineApi
                    .updateMidiClipWithDeltas(clipId, serializeMidiNotesToFrames(notes), { pushUndoStep: true })
                    .then(async (response) => {
                        await applyProjectDeltas(response.deltas, 'midi-notes:pointerup');
                        dirtyMidiNotesClipIdsRef.current.delete(clipId);
                    })
                    .catch((err) => console.error('[DawShell] updateMidiClip final flush failed:', err));
            }

            for (const clipId of Array.from(dirtyMidiEnvelopeClipIdsRef.current)) {
                const envelopes = latestMidiEnvelopesRef.current[clipId] ?? [];
                void engineApi
                    .setMidiClipEnvelopes(clipId, envelopes, { pushUndoStep: true })
                    .then(() => {
                        dirtyMidiEnvelopeClipIdsRef.current.delete(clipId);
                    })
                    .catch((err) => console.error('[DawShell] setMidiClipEnvelopes final flush failed:', err));
            }
        };

        window.addEventListener('pointerup', onPointerUp);
        return () => window.removeEventListener('pointerup', onPointerUp);
    }, [
        flushTrackControlFinals,
        flushMidiThrottles,
        dirtyMidiNotesClipIdsRef,
        dirtyMidiEnvelopeClipIdsRef,
        latestMidiNotesRef,
        latestMidiEnvelopesRef,
        serializeMidiNotesToFrames,
        applyProjectDeltas,
    ]);
}
