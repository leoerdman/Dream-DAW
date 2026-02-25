import { useCallback, useEffect, useRef, useState } from 'react';
import throttle from 'lodash.throttle';
import * as engineApi from '@/shared/api/engine';
import type { MidiNote } from '@/widgets/PianoRoll/PianoRoll';
import { useSettingsStore } from '@/shared/stores/useSettingsStore';
import { beatDurationToFrames, beatToFrame, resolveSampleRate } from '@/shared/lib/audioMath';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';

type ThrottledSender<T> = ((payload: T) => void) & {
    cancel: () => void;
    flush: () => void;
};

interface UseDawShellMidiPersistenceArgs {
    timelineClips: TimelineClip[];
    trackIds: string[];
    tracksById: Record<string, ProjectTrack>;
    projectBpm: number;
    transportBpm: number;
    projectSampleRate: number;
    applyProjectDeltas: (deltas: engineApi.ProjectDelta[], reason?: string) => Promise<void>;
}

function makeUiId(prefix: string, index: number): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `${prefix}_${crypto.randomUUID()}`;
    }
    return `${prefix}_${Date.now()}_${index}`;
}

export function useDawShellMidiPersistence({
    timelineClips,
    trackIds,
    tracksById,
    projectBpm,
    transportBpm,
    projectSampleRate,
    applyProjectDeltas,
}: UseDawShellMidiPersistenceArgs) {
    const [midiNotesByClip, setMidiNotesByClip] = useState<Record<string, MidiNote[]>>({});
    const [clipFadeCurves, setClipFadeCurves] = useState<Record<string, { fadeInCurve: number; fadeOutCurve: number }>>({});
    const [aiVariationBusy, setAiVariationBusy] = useState(false);

    const midiSaveThrottlesRef = useRef<Map<string, ThrottledSender<MidiNote[]>>>(new Map());
    const midiEnvelopeSaveThrottlesRef = useRef<
        Map<string, ThrottledSender<Array<{ paramId: string; points: Array<{ beat: number; value: number }> }>>>
    >(new Map());
    const latestMidiEnvelopesRef = useRef<
        Record<string, Array<{ paramId: string; points: Array<{ beat: number; value: number }> }>>
    >({});
    const latestMidiNotesRef = useRef<Record<string, MidiNote[]>>({});
    const dirtyMidiNotesClipIdsRef = useRef<Set<string>>(new Set());
    const dirtyMidiEnvelopeClipIdsRef = useRef<Set<string>>(new Set());

    const serializeMidiNotesToFrames = useCallback((notes: MidiNote[]) => {
        const bpm = projectBpm || transportBpm || 120;
        const sampleRate = resolveSampleRate(projectSampleRate);
        return notes.map((note) => ({
            pitch: note.pitch,
            velocity: note.velocity,
            startFrames: Math.max(0, beatToFrame(note.startBeat, bpm, sampleRate)),
            durationFrames: Math.max(1, beatDurationToFrames(note.durationBeats, bpm, sampleRate)),
        }));
    }, [projectBpm, transportBpm, projectSampleRate]);

    const flushMidiThrottles = useCallback(() => {
        midiSaveThrottlesRef.current.forEach((send) => send.flush());
        midiEnvelopeSaveThrottlesRef.current.forEach((send) => send.flush());
    }, []);

    useEffect(() => {
        const incoming: Record<string, MidiNote[]> = {};
        for (const clip of timelineClips) {
            if (clip.type !== 'midi') continue;
            const backendNotes = (clip.midiNotes ?? []).map((note) => ({
                id: note.id ?? `${clip.id}-${note.pitch}-${note.startBeat}`,
                pitch: note.pitch,
                startBeat: note.startBeat,
                durationBeats: note.durationBeats,
                velocity: note.velocity,
            }));
            if (dirtyMidiNotesClipIdsRef.current.has(clip.id)) {
                // Keep local edits if they exist; otherwise never drop to empty.
                // This prevents "empty piano roll" after snapshot/delta churn when
                // a clip id is marked dirty but local cache has been reset.
                incoming[clip.id] = latestMidiNotesRef.current[clip.id] ?? backendNotes;
            } else {
                incoming[clip.id] = backendNotes;
            }
        }
        setMidiNotesByClip((prev) => {
            const prevKeys = Object.keys(prev);
            const incomingKeys = Object.keys(incoming);
            if (prevKeys.length !== incomingKeys.length) return incoming;
            for (const key of incomingKeys) {
                if (prev[key] !== incoming[key]) return incoming;
            }
            return prev;
        });
    }, [timelineClips]);

    useEffect(() => {
        latestMidiNotesRef.current = midiNotesByClip;
    }, [midiNotesByClip]);

    useEffect(() => {
        const activeMidiClipIds = new Set(
            timelineClips.filter((clip) => clip.type === 'midi').map((clip) => clip.id),
        );
        for (const [clipId, send] of midiSaveThrottlesRef.current.entries()) {
            if (!activeMidiClipIds.has(clipId)) {
                send.cancel();
                midiSaveThrottlesRef.current.delete(clipId);
                dirtyMidiNotesClipIdsRef.current.delete(clipId);
            }
        }
        for (const [clipId, send] of midiEnvelopeSaveThrottlesRef.current.entries()) {
            if (!activeMidiClipIds.has(clipId)) {
                send.cancel();
                midiEnvelopeSaveThrottlesRef.current.delete(clipId);
                dirtyMidiEnvelopeClipIdsRef.current.delete(clipId);
            }
        }
    }, [timelineClips]);

    useEffect(() => {
        const midiSaveThrottles = midiSaveThrottlesRef.current;
        const midiEnvelopeSaveThrottles = midiEnvelopeSaveThrottlesRef.current;
        const dirtyMidiNotes = dirtyMidiNotesClipIdsRef.current;
        const dirtyMidiEnvelopes = dirtyMidiEnvelopeClipIdsRef.current;
        return () => {
            midiSaveThrottles.forEach((send) => send.cancel());
            midiEnvelopeSaveThrottles.forEach((send) => send.cancel());
            midiSaveThrottles.clear();
            midiEnvelopeSaveThrottles.clear();
            dirtyMidiNotes.clear();
            dirtyMidiEnvelopes.clear();
        };
    }, []);

    const handleGenerateMidiVariation = useCallback(async (selectedTimelineClip: TimelineClip | undefined) => {
        if (!selectedTimelineClip || selectedTimelineClip.type !== 'midi') return;
        const clip = selectedTimelineClip;
        const notes = midiNotesByClip[clip.id] ?? [];
        const trackId = trackIds[clip.trackIndex];
        const track = trackId ? tracksById[trackId] : undefined;
        const bpm = projectBpm || transportBpm || 120;
        const sampleRate = resolveSampleRate(projectSampleRate);
        const settingsModel = useSettingsStore.getState().settings.openRouterModel;
        const variationModel = (settingsModel && settingsModel !== 'openai/gpt-4o-mini')
            ? settingsModel
            : 'minimax/minimax-m2.5';

        setAiVariationBusy(true);
        try {
            const variedNotes = await engineApi.generateMidiVariation({
                bpm,
                beatsPerBar: 4,
                clipName: clip.name,
                clipDurationBeats: clip.durationBeats,
                notes,
                trackContext: {
                    trackName: track?.name ?? `Track ${clip.trackIndex + 1}`,
                    trackType: track?.track_type ?? 'Midi',
                    instrumentName: track?.instrument?.name ?? null,
                    effectNames: (track?.effects ?? []).map((e) => e.name),
                    samplerSamplePath: track?.sampler?.sample_path ?? null,
                },
                model: variationModel,
            });

            const normalizedForUi: MidiNote[] = variedNotes.map((note, idx) => ({
                id: makeUiId('ai', idx),
                pitch: note.pitch,
                velocity: note.velocity,
                startBeat: note.startBeat,
                durationBeats: note.durationBeats,
            }));

            setMidiNotesByClip((prev) => ({ ...prev, [clip.id]: normalizedForUi }));
            const response = await engineApi.updateMidiClipWithDeltas(
                clip.id,
                normalizedForUi.map((note) => ({
                    pitch: note.pitch,
                    velocity: note.velocity,
                    startFrames: Math.max(0, beatToFrame(note.startBeat, bpm, sampleRate)),
                    durationFrames: Math.max(1, beatDurationToFrames(note.durationBeats, bpm, sampleRate)),
                })),
            );
            await applyProjectDeltas(response.deltas, 'daw-shell:midi-variation');
        } catch (error) {
            console.error('[DawShell] AI MIDI variation failed:', error);
            const message = error instanceof Error ? error.message : 'Unknown AI error';
            window.alert(`Не удалось сгенерировать вариацию: ${message}`);
        } finally {
            setAiVariationBusy(false);
        }
    }, [midiNotesByClip, trackIds, tracksById, projectBpm, transportBpm, projectSampleRate, applyProjectDeltas]);

    const handlePianoRollNotesChange = useCallback((selectedTimelineClip: TimelineClip | undefined, notes: MidiNote[]) => {
        if (!selectedTimelineClip || selectedTimelineClip.type !== 'midi') return;
        const clipId = selectedTimelineClip.id;
        setMidiNotesByClip((prev) => ({ ...prev, [clipId]: notes }));
        latestMidiNotesRef.current[clipId] = notes;
        dirtyMidiNotesClipIdsRef.current.add(clipId);

        let send = midiSaveThrottlesRef.current.get(clipId);
        if (!send) {
            send = throttle((toSend: MidiNote[]) => {
                void engineApi
                    .updateMidiClipWithDeltas(
                        clipId,
                        serializeMidiNotesToFrames(toSend),
                        { pushUndoStep: false },
                    )
                    .then((response) => applyProjectDeltas(response.deltas, 'midi-notes:throttle'))
                    .catch((error) => console.error('[DawShell] updateMidiClip failed:', error));
            }, 80) as ThrottledSender<MidiNote[]>;
            midiSaveThrottlesRef.current.set(clipId, send);
        }
        send(notes);
    }, [serializeMidiNotesToFrames, applyProjectDeltas]);

    const handlePianoRollEnvelopesChange = useCallback((selectedTimelineClip: TimelineClip | undefined, envelopes: Array<{ paramId: string; points: Array<{ beat: number; value: number }> }>) => {
        if (!selectedTimelineClip || selectedTimelineClip.type !== 'midi') return;
        const clipId = selectedTimelineClip.id;
        latestMidiEnvelopesRef.current[clipId] = envelopes;

        let send = midiEnvelopeSaveThrottlesRef.current.get(clipId);
        if (!send) {
            send = throttle((toSend) => {
                void engineApi
                    .setMidiClipEnvelopes(clipId, toSend, { pushUndoStep: false })
                    .catch((error) => console.error('[DawShell] setMidiClipEnvelopes failed:', error));
            }, 100) as ThrottledSender<Array<{ paramId: string; points: Array<{ beat: number; value: number }> }>>;
            midiEnvelopeSaveThrottlesRef.current.set(clipId, send);
        }
        dirtyMidiEnvelopeClipIdsRef.current.add(clipId);
        send(envelopes);
    }, []);

    return {
        midiNotesByClip,
        clipFadeCurves,
        setClipFadeCurves,
        aiVariationBusy,
        handleGenerateMidiVariation,
        handlePianoRollNotesChange,
        handlePianoRollEnvelopesChange,
        latestMidiEnvelopesRef,
        latestMidiNotesRef,
        dirtyMidiNotesClipIdsRef,
        dirtyMidiEnvelopeClipIdsRef,
        serializeMidiNotesToFrames,
        flushMidiThrottles,
    };
}
