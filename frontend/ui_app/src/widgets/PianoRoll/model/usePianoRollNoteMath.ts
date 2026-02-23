import { useCallback } from 'react';
import { EPS, MIN_NOTE_BEATS, type MidiNote } from './pianoRollConfig';

export function usePianoRollNoteMath(clipBeats: number, currentGridInterval: number) {
    const enforceNoOverlap = useCallback((input: MidiNote[], aggressorIds: Set<string>): MidiNote[] => {
        if (input.length <= 1 || aggressorIds.size === 0) return input;
        const byId = new Map<string, MidiNote>(input.map((note) => [note.id, { ...note }]));
        const deleted = new Set<string>();
        const aggressors = Array.from(aggressorIds)
            .map((id) => byId.get(id))
            .filter((note): note is MidiNote => !!note)
            .sort((a, b) => a.startBeat - b.startBeat);

        for (const aggressor of aggressors) {
            if (deleted.has(aggressor.id)) continue;
            const aStart = aggressor.startBeat;
            const aEnd = aggressor.startBeat + aggressor.durationBeats;
            for (const [id, note] of byId) {
                if (id === aggressor.id || deleted.has(id) || aggressorIds.has(id)) continue;
                if (note.pitch !== aggressor.pitch) continue;
                const overlaps = aEnd > note.startBeat + EPS && note.startBeat + note.durationBeats > aStart + EPS;
                if (!overlaps) continue;
                if (aStart <= note.startBeat + EPS) {
                    deleted.add(id);
                    continue;
                }
                const trimmedDuration = aStart - note.startBeat;
                if (trimmedDuration < MIN_NOTE_BEATS) deleted.add(id);
                else note.durationBeats = trimmedDuration;
            }
        }

        return input
            .filter((note) => !deleted.has(note.id))
            .map((note) => {
                const next = byId.get(note.id) ?? note;
                const clampedDur = Math.min(next.durationBeats, clipBeats - next.startBeat);
                return { ...next, durationBeats: Math.max(MIN_NOTE_BEATS, clampedDur) };
            })
            .filter((note) => note.durationBeats >= MIN_NOTE_BEATS && note.startBeat < clipBeats);
    }, [clipBeats]);

    const snapToCellStart = useCallback((rawBeat: number) => {
        const step = currentGridInterval > 0 ? currentGridInterval : 0.25;
        const clamped = Math.max(0, Math.min(clipBeats - MIN_NOTE_BEATS, rawBeat));
        const cell = Math.floor((clamped + EPS) / step);
        return Math.max(0, Math.min(clipBeats - MIN_NOTE_BEATS, cell * step));
    }, [clipBeats, currentGridInterval]);

    return {
        enforceNoOverlap,
        snapToCellStart,
    };
}
