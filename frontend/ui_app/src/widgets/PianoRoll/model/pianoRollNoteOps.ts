import {
    EPS,
    HIGHEST_PITCH,
    LOWEST_PITCH,
    MIN_NOTE_BEATS,
    type MidiNote,
} from '@/widgets/PianoRoll/model/pianoRollConfig';

export function enforceNoOverlap(
    input: MidiNote[],
    aggressorIds: Set<string>,
    clipBeats: number,
): MidiNote[] {
    if (input.length <= 1 || aggressorIds.size === 0) return input;

    const byId = new Map<string, MidiNote>(input.map((n) => [n.id, { ...n }]));
    const deleted = new Set<string>();

    const aggressors = Array.from(aggressorIds)
        .map((id) => byId.get(id))
        .filter((n): n is MidiNote => !!n)
        .sort((a, b) => a.startBeat - b.startBeat);

    for (const a of aggressors) {
        if (deleted.has(a.id)) continue;
        const aStart = a.startBeat;
        const aEnd = a.startBeat + a.durationBeats;

        for (const [id, b] of byId) {
            if (id === a.id || deleted.has(id) || aggressorIds.has(id)) continue;
            if (b.pitch !== a.pitch) continue;

            const bStart = b.startBeat;
            const bEnd = b.startBeat + b.durationBeats;
            const overlaps = aEnd > bStart + EPS && bEnd > aStart + EPS;
            if (!overlaps) continue;

            if (aStart <= bStart + EPS) {
                deleted.add(id);
                continue;
            }

            const trimmedDuration = aStart - bStart;
            if (trimmedDuration < MIN_NOTE_BEATS) {
                deleted.add(id);
            } else {
                b.durationBeats = trimmedDuration;
            }
        }
    }

    const maxBeat = clipBeats;
    return input
        .filter((n) => !deleted.has(n.id))
        .map((n) => {
            const next = byId.get(n.id) ?? n;
            const clampedDur = Math.min(next.durationBeats, maxBeat - next.startBeat);
            return { ...next, durationBeats: Math.max(MIN_NOTE_BEATS, clampedDur) };
        })
        .filter((n) => n.durationBeats >= MIN_NOTE_BEATS && n.startBeat < maxBeat);
}

export function transposeSelectedNotes(
    notes: MidiNote[],
    selectedIds: Set<string>,
    delta: number,
): MidiNote[] {
    if (delta === 0 || notes.length === 0 || selectedIds.size === 0) return notes;
    return notes.map((n) => {
        if (!selectedIds.has(n.id)) return n;
        return { ...n, pitch: Math.max(LOWEST_PITCH, Math.min(HIGHEST_PITCH, n.pitch + delta)) };
    });
}

type QuantizeFn = (beat: number, beatsPerBar: number, pixelsPerBeat: number) => number;

export function quantizeSelectedNotes(
    notes: MidiNote[],
    selectedIds: Set<string>,
    currentGridInterval: number,
    amountPct: number,
    beatsPerBar: number,
    pixelsPerBeat: number,
    clipBeats: number,
    snapBeat: QuantizeFn,
): MidiNote[] {
    if (selectedIds.size === 0) return notes;
    const step = currentGridInterval > 0 ? currentGridInterval : 0.25;
    const amt = Math.max(0, Math.min(1, amountPct / 100));

    return notes.map((n) => {
        if (!selectedIds.has(n.id)) return n;
        const snappedStart = snapBeat(n.startBeat, beatsPerBar, pixelsPerBeat);
        const snappedDur = Math.max(step, Math.round(n.durationBeats / step) * step);
        const blendedStart = n.startBeat + (snappedStart - n.startBeat) * amt;
        const blendedDur = n.durationBeats + (snappedDur - n.durationBeats) * amt;
        return {
            ...n,
            startBeat: Math.max(0, Math.min(Math.max(0, clipBeats - step), blendedStart)),
            durationBeats: Math.max(step, Math.min(clipBeats - blendedStart, blendedDur)),
        };
    });
}

export function duplicateNotes(
    notes: MidiNote[],
    selectedIds: Set<string>,
    clipBeats: number,
): MidiNote[] {
    const targets = selectedIds.size > 0 ? notes.filter((n) => selectedIds.has(n.id)) : notes;
    if (targets.length === 0) return [];

    const spanStart = Math.min(...targets.map((n) => n.startBeat));
    const spanEnd = Math.max(...targets.map((n) => n.startBeat + n.durationBeats));
    const shift = spanEnd - spanStart;

    return targets.map((n) => ({
        ...n,
        id: crypto.randomUUID(),
        startBeat: Math.max(0, Math.min(clipBeats - MIN_NOTE_BEATS, n.startBeat + shift)),
        selected: false,
    }));
}

export function humanizeSelectedNotes(
    notes: MidiNote[],
    selectedIds: Set<string>,
    currentGridInterval: number,
    clipBeats: number,
): MidiNote[] {
    if (selectedIds.size === 0) return notes;
    const step = currentGridInterval > 0 ? currentGridInterval : 0.25;

    return notes.map((n) => {
        if (!selectedIds.has(n.id)) return n;
        const hashSeed = n.id.split('').reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 0);
        const pseudoRand1 = ((hashSeed & 0x7fffffff) % 997) / 997;
        const pseudoRand2 = (((hashSeed * 127) & 0x7fffffff) % 991) / 991;
        const timing = (pseudoRand1 - 0.5) * step * 0.35;
        const velocity = Math.round((pseudoRand2 - 0.5) * 10);
        return {
            ...n,
            startBeat: Math.max(0, Math.min(clipBeats - MIN_NOTE_BEATS, n.startBeat + timing)),
            velocity: Math.max(1, Math.min(127, n.velocity + velocity)),
        };
    });
}

export function applyLegatoToSelectedNotes(
    notes: MidiNote[],
    selectedIds: Set<string>,
    clipBeats: number,
): MidiNote[] {
    if (selectedIds.size === 0) return notes;

    const byPitch = new Map<number, MidiNote[]>();
    notes.forEach((n) => {
        if (!selectedIds.has(n.id)) return;
        const arr = byPitch.get(n.pitch) ?? [];
        arr.push(n);
        byPitch.set(n.pitch, arr);
    });

    const durationById = new Map<string, number>();
    byPitch.forEach((arr) => {
        arr.sort((a, b) => a.startBeat - b.startBeat);
        for (let i = 0; i < arr.length; i++) {
            const current = arr[i];
            const next = arr[i + 1];
            const targetEnd = next ? next.startBeat : clipBeats;
            durationById.set(current.id, Math.max(MIN_NOTE_BEATS, targetEnd - current.startBeat));
        }
    });
    if (durationById.size === 0) return notes;

    return notes.map((n) => (
        durationById.has(n.id)
            ? {
                ...n,
                durationBeats: Math.max(
                    MIN_NOTE_BEATS,
                    Math.min(clipBeats - n.startBeat, durationById.get(n.id) ?? n.durationBeats),
                ),
            }
            : n
    ));
}
