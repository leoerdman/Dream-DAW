import { useCallback, useEffect, useRef, useState } from 'react';
import { VELOCITY_LANE_HEIGHT, type MidiNote, type PianoLaneType } from '@/widgets/PianoRoll/model/pianoRollConfig';

interface UsePianoRollLaneValuesArgs {
    midiEnvelopes?: Array<{ paramId: string; points: Array<{ beat: number; value: number }> }>;
    notes: MidiNote[];
    onSetMidiEnvelopes?: (
        envelopes: Array<{ paramId: string; points: Array<{ beat: number; value: number }> }>,
    ) => void;
    selectedNotes: Set<string>;
    setSelectedNotes: React.Dispatch<React.SetStateAction<Set<string>>>;
    activeLane: PianoLaneType;
    onNotesChange: (notes: MidiNote[]) => void;
    auditionNote: (pitch: number, velocity?: number, durationMs?: number) => void;
}

export function usePianoRollLaneValues({
    midiEnvelopes = [],
    notes,
    onSetMidiEnvelopes,
    selectedNotes,
    setSelectedNotes,
    activeLane,
    onNotesChange,
    auditionNote,
}: UsePianoRollLaneValuesArgs) {
    const [laneValuesByNote, setLaneValuesByNote] = useState<Record<PianoLaneType, Record<string, number>>>(() => ({
        velocity: {},
        modWheel: {},
        expression: {},
    }));
    const lanePersistTimerRef = useRef<number | null>(null);
    const lanePersistHashRef = useRef('');
    const laneDragCleanupRef = useRef<(() => void) | null>(null);

    const sampleEnvelopeAtBeat = useCallback((points: Array<{ beat: number; value: number }>, beat: number): number => {
        if (points.length === 0) return 0;
        if (points.length === 1) return Math.round(points[0].value * 127);
        const sorted = [...points].sort((a, b) => a.beat - b.beat);
        if (beat <= sorted[0].beat) return Math.round(sorted[0].value * 127);
        if (beat >= sorted[sorted.length - 1].beat) return Math.round(sorted[sorted.length - 1].value * 127);
        for (let i = 0; i < sorted.length - 1; i++) {
            const a = sorted[i];
            const b = sorted[i + 1];
            if (beat >= a.beat && beat <= b.beat) {
                const span = Math.max(0.0001, b.beat - a.beat);
                const t = (beat - a.beat) / span;
                return Math.round((a.value + (b.value - a.value) * t) * 127);
            }
        }
        return 0;
    }, []);

    const readLaneValue = useCallback((note: MidiNote, lane: PianoLaneType) => {
        if (lane === 'velocity') return note.velocity;
        const cached = laneValuesByNote[lane][note.id];
        return Number.isFinite(cached) ? cached : 0;
    }, [laneValuesByNote]);

    useEffect(() => {
        const envMap = new Map(midiEnvelopes.map((env) => [env.paramId, env.points]));
        const buildLane = (paramId: string): Record<string, number> => {
            const points = envMap.get(paramId) ?? [];
            const next: Record<string, number> = {};
            for (const note of notes) next[note.id] = sampleEnvelopeAtBeat(points, note.startBeat);
            return next;
        };
        const raf = window.requestAnimationFrame(() => {
            setLaneValuesByNote((prev) => ({
                ...prev,
                modWheel: buildLane('cc1.modWheel'),
                expression: buildLane('cc11.expression'),
            }));
        });
        return () => window.cancelAnimationFrame(raf);
    }, [midiEnvelopes, notes, sampleEnvelopeAtBeat]);

    useEffect(() => {
        if (!onSetMidiEnvelopes) return;
        const toEnvelope = (paramId: string, values: Record<string, number>) => ({
            paramId,
            points: notes
                .map((note) => ({
                    beat: note.startBeat,
                    value: Math.max(0, Math.min(1, (values[note.id] ?? 0) / 127)),
                }))
                .sort((a, b) => a.beat - b.beat),
        });
        const payload = [
            toEnvelope('cc1.modWheel', laneValuesByNote.modWheel),
            toEnvelope('cc11.expression', laneValuesByNote.expression),
        ];
        const hash = JSON.stringify(payload);
        if (hash === lanePersistHashRef.current) return;
        if (lanePersistTimerRef.current != null) window.clearTimeout(lanePersistTimerRef.current);
        lanePersistTimerRef.current = window.setTimeout(() => {
            onSetMidiEnvelopes(payload);
            lanePersistHashRef.current = hash;
            lanePersistTimerRef.current = null;
        }, 300);
        return () => {
            if (lanePersistTimerRef.current != null) {
                window.clearTimeout(lanePersistTimerRef.current);
                lanePersistTimerRef.current = null;
            }
        };
    }, [laneValuesByNote.modWheel, laneValuesByNote.expression, notes, onSetMidiEnvelopes]);

    const handleVelocityMouseDown = useCallback((noteId: string, event: React.MouseEvent) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        event.preventDefault();
        const laneEl = (event.currentTarget as HTMLElement).parentElement;
        if (!laneEl) return;
        const laneRect = laneEl.getBoundingClientRect();
        const startY = event.clientY;
        const startedValues = new Map<string, number>();
        const targets = selectedNotes.has(noteId) ? new Set(selectedNotes) : new Set([noteId]);
        if (!selectedNotes.has(noteId)) setSelectedNotes(new Set([noteId]));
        const targetLead = notes.find((note) => note.id === noteId);
        if (targetLead) auditionNote(targetLead.pitch, targetLead.velocity, 120);
        notes.forEach((note) => {
            if (targets.has(note.id)) startedValues.set(note.id, readLaneValue(note, activeLane));
        });

        let moved = false;
        const applyAbsoluteFromY = (clientY: number) => {
            const y = Math.max(0, Math.min(VELOCITY_LANE_HEIGHT, clientY - laneRect.top));
            const absolute = Math.round(Math.max(1, Math.min(127, (1 - y / VELOCITY_LANE_HEIGHT) * 127)));
            if (activeLane === 'velocity') {
                onNotesChange(notes.map((note) => (targets.has(note.id) ? { ...note, velocity: absolute } : note)));
            } else {
                setLaneValuesByNote((prev) => ({
                    ...prev,
                    [activeLane]: {
                        ...prev[activeLane],
                        ...Object.fromEntries(Array.from(targets).map((id) => [id, absolute])),
                    },
                }));
            }
        };

        const onMove = (moveEvent: MouseEvent) => {
            const dy = moveEvent.clientY - startY;
            const sensitivity = moveEvent.shiftKey ? 0.5 : 1.5;
            const delta = Math.round(-dy * sensitivity);
            moved = moved || Math.abs(dy) > 1;
            if (activeLane === 'velocity') {
                onNotesChange(notes.map((note) => {
                    if (!targets.has(note.id)) return note;
                    const base = startedValues.get(note.id) ?? note.velocity;
                    return { ...note, velocity: Math.max(1, Math.min(127, base + delta)) };
                }));
            } else {
                setLaneValuesByNote((prev) => {
                    const next = { ...prev, [activeLane]: { ...prev[activeLane] } };
                    targets.forEach((id) => {
                        const base = startedValues.get(id) ?? 0;
                        next[activeLane][id] = Math.max(1, Math.min(127, base + delta));
                    });
                    return next;
                });
            }
        };

        const onUp = (upEvent: MouseEvent) => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            laneDragCleanupRef.current = null;
            if (!moved) applyAbsoluteFromY(upEvent.clientY);
        };
        laneDragCleanupRef.current?.();
        laneDragCleanupRef.current = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            laneDragCleanupRef.current = null;
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [activeLane, auditionNote, notes, onNotesChange, readLaneValue, selectedNotes, setSelectedNotes]);

    useEffect(() => () => {
        laneDragCleanupRef.current?.();
        laneDragCleanupRef.current = null;
    }, []);

    return {
        laneValuesByNote,
        setLaneValuesByNote,
        readLaneValue,
        handleVelocityMouseDown,
    };
}
