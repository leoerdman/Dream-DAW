import { useCallback, useEffect, useRef, useState } from 'react';
import throttle from 'lodash.throttle';
import * as engineApi from '@/shared/api/engine';
import type { MidiNote } from '@/widgets/PianoRoll/model/pianoRollConfig';
import { useSettingsStore } from '@/shared/stores/useSettingsStore';
import { beatDurationToFrames, beatToFrame, resolveBpm, resolveSampleRate } from '@/shared/lib/audioMath';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';

type ThrottledSender<T> = ((payload: T) => void) & {
    cancel: () => void;
    flush: () => void;
};

const MIDI_SAVE_THROTTLE_MS = 80;
const MIDI_ENVELOPE_SAVE_THROTTLE_MS = 100;

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

function normalizeIncomingMidiNotes(
    clip: TimelineClip,
    notes: MidiNote[],
): MidiNote[] {
    if (!Number.isFinite(clip.durationBeats) || clip.durationBeats <= 0) return notes;
    if (!Number.isFinite(clip.startBeat) || clip.startBeat <= 0) return notes;
    if (notes.length === 0) return notes;

    const duration = Math.max(0.25, clip.durationBeats);
    const hasOutOfRangeStarts = notes.some((n) => n.startBeat > duration + 0.001);
    if (!hasOutOfRangeStarts) return notes;

    // Recovery path for legacy/imported absolute note beats.
    return notes.map((n, idx) => ({
        ...n,
        id: n.id || makeUiId(clip.id, idx),
        startBeat: Math.max(0, n.startBeat - clip.startBeat),
    }));
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
        const bpm = resolveBpm(projectBpm, transportBpm);
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
            const normalizedNotes = normalizeIncomingMidiNotes(clip, backendNotes);
            if (dirtyMidiNotesClipIdsRef.current.has(clip.id)) {
                // Keep local edits if they exist; otherwise never drop to empty.
                // This prevents "empty piano roll" after snapshot/delta churn when
                // a clip id is marked dirty but local cache has been reset.
                incoming[clip.id] = latestMidiNotesRef.current[clip.id] ?? normalizedNotes;
            } else {
                incoming[clip.id] = normalizedNotes;
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
        // BUG-M002 FIX: Prune clipFadeCurves for deleted clips to prevent memory leak.
        setClipFadeCurves((prev) => {
            let changed = false;
            const next = { ...prev };
            for (const id in next) {
                // Fade curves aren't intrinsically tied to MIDI, but in the view they are
                // mapped over all timelineClips. We'll use the generic timelineClips check.
                if (!timelineClips.find(c => c.id === id)) {
                    delete next[id];
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
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
        const bpm = resolveBpm(projectBpm, transportBpm);
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
                    .then(async (response) => {
                        await applyProjectDeltas(response.deltas, 'midi-notes:throttle');
                        // Successful roundtrip: clip is no longer locally dirty.
                        dirtyMidiNotesClipIdsRef.current.delete(clipId);
                    })
                    .catch((error) => console.error('[DawShell] updateMidiClip failed:', error));
            }, MIDI_SAVE_THROTTLE_MS) as ThrottledSender<MidiNote[]>;
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
                    .then(() => {
                        dirtyMidiEnvelopeClipIdsRef.current.delete(clipId);
                    })
                    .catch((error) => console.error('[DawShell] setMidiClipEnvelopes failed:', error));
            }, MIDI_ENVELOPE_SAVE_THROTTLE_MS) as ThrottledSender<Array<{ paramId: string; points: Array<{ beat: number; value: number }> }>>;
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
