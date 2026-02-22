// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — PianoRoll (MIDI Note Editor)
// ═══════════════════════════════════════════════════════════════════════════
//
// Architecture:
//   - Left piano keyboard (dynamic height keys)
//   - Note grid — ALWAYS fills available panel width (like Ableton)
//   - Scale-aware highlighting: rows in selected key/scale are tinted
//   - Bidirectional zoom: H = Ctrl/⌘+Scroll, V = Alt+Scroll
//   - Note blocks (draggable, resizable)
//   - Velocity lane (bottom)
//   - Snap-to-grid via useGridStore
//   - Tools: Draw, Paint, Select
//
// Design: Uses CSS custom properties from tokens.css exclusively.
//         Piano Roll tokens: --color-piano-* for grid, keyboard, lines.
//         Layout tokens: --color-bg-*, --color-text-*, --color-divider, etc.
//
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useCallback, useRef, useMemo, useEffect, memo } from 'react';
import { useGridStore } from '@/shared/stores/useGridStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import type { GridDivision } from '@/shared/lib/gridSnap';
import { divisionToInterval } from '@/shared/lib/gridSnap';
import * as engineApi from '@/shared/api/engine';
import {
    Pencil,
    Brush,
    Sparkles,
    RotateCw,
    Music,
    Filter,
    ChevronUp,
    ChevronDown,
} from 'lucide-react';
import { ClipEditorMetaRow, ClipEditorSection, ClipEditorSidebar } from '@/widgets/ClipEditor/ClipEditorSidebar';

// ── Types ────────────────────────────────────────────────────────────────

export interface MidiNote {
    id: string;
    pitch: number;
    startBeat: number;
    durationBeats: number;
    velocity: number;
    selected?: boolean;
}

export type PianoRollTool = 'draw' | 'paint';

interface PianoRollProps {
    notes: MidiNote[];
    ghostNotes?: MidiNote[];
    trackIndex?: number;
    midiEnvelopes?: Array<{ paramId: string; points: Array<{ beat: number; value: number }> }>;
    onSetMidiEnvelopes?: (
        envelopes: Array<{ paramId: string; points: Array<{ beat: number; value: number }> }>,
    ) => void;
    onNotesChange: (notes: MidiNote[]) => void;
    onGenerateVariation?: () => void | Promise<void>;
    aiVariationBusy?: boolean;
    color?: string;
    timeSignature?: [number, number];
    totalBars?: number;
    playheadBeat?: number;
    /** Clip start beat for computing relative playhead from transport (store-driven). */
    clipStartBeat?: number;
    clipLengthBeats?: number;
}

// ── Scale Definitions ────────────────────────────────────────────────────

type ScaleName =
    | 'Major'
    | 'Natural Minor'
    | 'Harmonic Minor'
    | 'Melodic Minor'
    | 'Dorian'
    | 'Phrygian'
    | 'Lydian'
    | 'Mixolydian'
    | 'Locrian'
    | 'Pentatonic Major'
    | 'Pentatonic Minor'
    | 'Blues'
    | 'Chromatic';

const SCALE_INTERVALS: Record<ScaleName, number[]> = {
    'Major': [0, 2, 4, 5, 7, 9, 11],
    'Natural Minor': [0, 2, 3, 5, 7, 8, 10],
    'Harmonic Minor': [0, 2, 3, 5, 7, 8, 11],
    'Melodic Minor': [0, 2, 3, 5, 7, 9, 11],
    'Dorian': [0, 2, 3, 5, 7, 9, 10],
    'Phrygian': [0, 1, 3, 5, 7, 8, 10],
    'Lydian': [0, 2, 4, 6, 7, 9, 11],
    'Mixolydian': [0, 2, 4, 5, 7, 9, 10],
    'Locrian': [0, 1, 3, 5, 6, 8, 10],
    'Pentatonic Major': [0, 2, 4, 7, 9],
    'Pentatonic Minor': [0, 3, 5, 7, 10],
    'Blues': [0, 3, 5, 6, 7, 10],
    'Chromatic': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

const SCALE_NAMES = Object.keys(SCALE_INTERVALS) as ScaleName[];
const ROOT_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
type RootNote = typeof ROOT_NOTES[number];

function isInScale(pitch: number, rootNote: RootNote, scale: ScaleName): boolean {
    const rootIndex = ROOT_NOTES.indexOf(rootNote);
    const intervals = SCALE_INTERVALS[scale];
    const degree = ((pitch % 12) - rootIndex + 12) % 12;
    return intervals.includes(degree);
}

// ── Constants ────────────────────────────────────────────────────────────

const KEYBOARD_WIDTH = 52;
const DEFAULT_NOTE_HEIGHT = 14;
const MIN_NOTE_HEIGHT = 4;
const MAX_NOTE_HEIGHT = 32;
const VELOCITY_LANE_HEIGHT = 64;
const RULER_HEIGHT = 22;
const LOWEST_PITCH = 0;
const HIGHEST_PITCH = 127; // Bug #1: was 115, cutting off the top octave of MIDI
const TOTAL_KEYS = HIGHEST_PITCH - LOWEST_PITCH + 1;
const MIN_PPB = 4;
const MAX_PPB = 200;
const MIN_NOTE_BEATS = 0.125;
const EPS = 1e-6;

const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// UI octave labeling offset:
// MIDI 60 is shown as C3 (DAW-style), not C4 (scientific pitch notation).
const OCTAVE_LABEL_OFFSET = -2;
const DEFAULT_FOCUS_PITCH = 60; // C3 in this UI labeling
const MIDI_GRID_PRESETS: Array<{ label: string; division: GridDivision }> = [
    { label: '1 Bar', division: '1/1' },
    { label: '1/4', division: '1/4' },
    { label: '1/8', division: '1/8' },
    { label: '1/16', division: '1/16' },
];

const DRUM_LANES: Array<{ pitch: number; name: string }> = [
    { pitch: 36, name: 'Kick' },
    { pitch: 38, name: 'Snare' },
    { pitch: 42, name: 'Closed Hat' },
    { pitch: 46, name: 'Open Hat' },
    { pitch: 41, name: 'Low Tom' },
    { pitch: 43, name: 'Mid Tom' },
    { pitch: 45, name: 'High Tom' },
    { pitch: 49, name: 'Crash' },
    { pitch: 51, name: 'Ride' },
    { pitch: 37, name: 'Rim' },
    { pitch: 39, name: 'Clap' },
    { pitch: 35, name: 'Sub Kick' },
];

type PianoLaneType = 'velocity' | 'modWheel' | 'expression';

const isBlackKey = (pitch: number) => {
    const note = pitch % 12;
    return [1, 3, 6, 8, 10].includes(note);
};

const genNoteId = () => crypto.randomUUID();

// Audit #8: Shared platform detection — matches useKeyboardShortcuts.ts pattern.
// Uses navigator.userAgentData (modern) with user-agent fallback.
const isMac: boolean = (() => {
    const uad = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
    if (uad?.platform) return uad.platform === 'macOS';
    return /mac/i.test(navigator.userAgent) && !/iphone|ipad/i.test(navigator.userAgent);
})();

// ── Per-track vertical scroll persistence ────────────────────────────
// Module-level map survives React remounts (Shift+Tab panel switches).
// Keyed by trackIndex — stores scrollTop so each track remembers its
// Piano Roll vertical position instead of resetting to C3 every time.
const _scrollTopByTrack = new Map<number, number>();

// ── Component ────────────────────────────────────────────────────────────

export const PianoRoll = memo(function PianoRoll({
    notes,
    ghostNotes = [],
    trackIndex,
    midiEnvelopes = [],
    onSetMidiEnvelopes,
    onNotesChange,
    onGenerateVariation,
    aiVariationBusy = false,
    color = '#4a9eff',
    timeSignature = [4, 4],
    totalBars = 8,
    playheadBeat: playheadBeatProp,
    clipStartBeat = 0,
    clipLengthBeats,
}: PianoRollProps) {
    // Subscribe to transport position directly — avoids DawShell 30fps re-render.
    const storePositionBeats = useEngineStore((s) => s.transport.position_beats ?? 0);
    const playheadBeat = playheadBeatProp ?? (storePositionBeats - clipStartBeat);
    const [tool, setTool] = useState<PianoRollTool>('draw');
    const [selectedNotes, setSelectedNotes] = useState<Set<string>>(new Set());
    const [selectionRect, setSelectionRect] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
    const [containerWidth, setContainerWidth] = useState(0);
    const [zoomOverrideH, setZoomOverrideH] = useState<number | null>(null);
    const [noteHeight, setNoteHeight] = useState(DEFAULT_NOTE_HEIGHT);
    const [isEditorFocused, setIsEditorFocused] = useState(false);

    // Scale state
    const [highlightScale, setHighlightScale] = useState(false);
    const [rootNote, setRootNote] = useState<RootNote>('C');
    const [scaleName, setScaleName] = useState<ScaleName>('Major');
    const [clipTranspose, setClipTranspose] = useState(0);
    // Audit #6 fix: reset clipTranspose when clip changes (via clipLengthBeats prop change).
    useEffect(() => {
        setClipTranspose(0);
        // BUG-13 FIX: Clear saved scroll position when the clip changes
        // so the auto-scroll logic (L655) re-centers on actual note content
        // instead of restoring a stale position from the previous clip.
        if (trackIndex != null) {
            _scrollTopByTrack.delete(trackIndex);
        }
        // BUG-P5 FIX: clipStartBeat in deps ensures the counter resets
        // even when switching to a clip of the same length.
    }, [clipLengthBeats, clipStartBeat, trackIndex]);
    const [quantizeAmount, setQuantizeAmount] = useState(100);
    const [foldToUsedNotes, setFoldToUsedNotes] = useState(false);
    const [stepInputOctave, setStepInputOctave] = useState(4);
    const [stepInputCursorBeat, setStepInputCursorBeat] = useState(0);
    const [drumMode, setDrumMode] = useState(false);
    const [activeLane, setActiveLane] = useState<PianoLaneType>('velocity');
    const [ratchetCount, setRatchetCount] = useState(2);
    const [laneValuesByNote, setLaneValuesByNote] = useState<Record<PianoLaneType, Record<string, number>>>(() => ({
        velocity: {},
        modWheel: {},
        expression: {},
    }));
    const lanePersistTimerRef = useRef<number | null>(null);
    const lanePersistHashRef = useRef('');
    // Always-current refs for use inside stable callbacks/closures that would
    // otherwise capture stale values (e.g. drag handlers, wheel handler).
    const notesRef = useRef(notes);
    const pixelsPerBeatRef = useRef(0);

    const readLaneValue = useCallback((note: MidiNote, lane: PianoLaneType) => {
        if (lane === 'velocity') return note.velocity;
        const cached = laneValuesByNote[lane][note.id];
        // Bug #22: fall back to 0, not 96 — no stored CC value means no modulation.
        return Number.isFinite(cached) ? cached : 0;
    }, [laneValuesByNote]);

    const sampleEnvelopeAtBeat = useCallback((points: Array<{ beat: number; value: number }>, beat: number): number => {
        // Audit #3: empty envelope → return 0, not 96 (no CC spike).
        if (points.length === 0) return 0;
        if (points.length === 1) return Math.round(points[0].value * 127);
        // Audit #13: pre-sort was done inline on every call. Accept pre-sorted input
        // and only sort here as safety net. Callers should pre-sort before loops.
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
        // Audit #3 fix: fallback was 96 (dead code path reachable via float gaps).
        // Return 0 to be consistent with empty envelope behavior.
        return 0;
    }, []);

    useEffect(() => {
        const envMap = new Map(midiEnvelopes.map((e) => [e.paramId, e.points]));
        const buildLane = (paramId: string): Record<string, number> => {
            const points = envMap.get(paramId) ?? [];
            const out: Record<string, number> = {};
            for (const note of notes) {
                out[note.id] = sampleEnvelopeAtBeat(points, note.startBeat);
            }
            return out;
        };

        const raf = window.requestAnimationFrame(() => {
            setLaneValuesByNote((prev) => ({
                ...prev,
                modWheel: buildLane('cc1.modWheel'),
                expression: buildLane('cc11.expression'),
            }));
        });

        return () => {
            window.cancelAnimationFrame(raf);
        };
    }, [midiEnvelopes, notes, sampleEnvelopeAtBeat]);

    useEffect(() => {
        if (!onSetMidiEnvelopes) return;
        const toEnvelope = (paramId: string, values: Record<string, number>) => {
            const points = notes
                .map((n) => ({
                    beat: n.startBeat,
                    // Audit #9 fix: fallback was 96 (75% CC), contradicting Bug #22 fix.
                    // No stored CC value means no modulation → 0.
                    value: Math.max(0, Math.min(1, (values[n.id] ?? 0) / 127)),
                }))
                .sort((a, b) => a.beat - b.beat);
            return { paramId, points };
        };

        const payload = [
            toEnvelope('cc1.modWheel', laneValuesByNote.modWheel),
            toEnvelope('cc11.expression', laneValuesByNote.expression),
        ];
        const hash = JSON.stringify(payload);
        if (hash === lanePersistHashRef.current) return;

        if (lanePersistTimerRef.current != null) {
            window.clearTimeout(lanePersistTimerRef.current);
        }
        // Bug #20: 90ms debounce was too short — rapid drag movements would
        // drop the last frame of edits. 300ms gives a comfortable trailing window.
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

    // ── Undo/Redo ──
    // Unified: PianoRoll delegates undo/redo to the backend undo stack.
    // Every `onNotesChange` flows through DawShell → `updateMidiClip` which
    // calls `push_undo` before mutating the project. Ctrl+Z/Y is handled by
    // the global `useKeyboardShortcuts` hook → `engine.undo()` / `engine.redo()`.
    const clipboardRef = useRef<MidiNote[]>([]);

    // Bug #33: Prune selectedNotes whenever the notes array is replaced externally
    // (e.g. after undo/redo from the backend). Stale IDs cause invisible phantom
    // selections that confuse operations like delete, transpose, etc.
    useEffect(() => {
        const noteIdSet = new Set(notes.map((n) => n.id));
        setSelectedNotes((prev) => {
            const pruned = new Set<string>();
            for (const id of prev) {
                if (noteIdSet.has(id)) pruned.add(id);
            }
            return pruned.size === prev.size ? prev : pruned;
        });
    }, [notes]);

    const copySelection = useCallback(() => {
        const targets = notes.filter((n) => selectedNotes.has(n.id));
        if (targets.length === 0) return;
        // Bug #28: Store a deep-cloned snapshot so later mutations to live notes
        // don't silently corrupt the clipboard contents.
        clipboardRef.current = targets.map((n) => ({ ...n }));
    }, [notes, selectedNotes]);


    const scrollRef = useRef<HTMLDivElement>(null);
    const noteCanvasRef = useRef<HTMLCanvasElement>(null);
    const gridViewportRef = useRef<HTMLDivElement>(null);
    const keyboardScrollRef = useRef<HTMLDivElement>(null);
    const editorRootRef = useRef<HTMLDivElement>(null);
    const snapBeat = useGridStore((s) => s.snapBeat);
    const pianoPencilMode = useGridStore((s) => s.pianoPencilMode);
    const gridDivision = useGridStore((s) => s.division);
    const gridTriplet = useGridStore((s) => s.triplet);
    const setGridDivision = useGridStore((s) => s.setDivision);

    const beatsPerBar = timeSignature[0];
    const currentGridInterval = useMemo(
        () => divisionToInterval(gridDivision, beatsPerBar, gridTriplet),
        [gridDivision, beatsPerBar, gridTriplet],
    );
    const clipBeats = Math.max(0.25, clipLengthBeats ?? (totalBars * beatsPerBar));

    // Auto-fit horizontal: scale so the entire clip fills the available width.
    // Bug #32: MIN_PPB clamp was applied to auto-fit, which prevented very long
    // clips from shrinking to fit. Only clamp user-driven zoom overrides.
    const gridAreaWidth = Math.max(100, containerWidth);
    const autoFitPPB = Math.min(MAX_PPB, gridAreaWidth / clipBeats); // Audit #35: clamp to MAX_PPB
    const pixelsPerBeat = zoomOverrideH != null
        ? Math.max(MIN_PPB, Math.min(MAX_PPB, zoomOverrideH))
        : autoFitPPB;
    // Keep always-current refs in sync for use inside stable drag/wheel callbacks.
    notesRef.current = notes;
    pixelsPerBeatRef.current = pixelsPerBeat;
    const totalBeats = Math.max(clipBeats, gridAreaWidth / pixelsPerBeat);

    const enforceNoOverlap = useCallback((input: MidiNote[], aggressorIds: Set<string>): MidiNote[] => {
        if (input.length <= 1 || aggressorIds.size === 0) return input;

        // Work on mutable copies keyed by id.
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

                // Aggressor starts at or before victim: trim victim's tail so it
                // ends where the aggressor begins. Only delete if too short to keep.
                if (aStart <= bStart + EPS) {
                    // Aggressor completely covers victim start — delete victim.
                    deleted.add(id);
                    continue;
                }

                // Victim starts before aggressor: trim victim's tail.
                const trimmedDuration = aStart - bStart;
                if (trimmedDuration < MIN_NOTE_BEATS) {
                    deleted.add(id);
                } else {
                    b.durationBeats = trimmedDuration;
                }
            }
        }

        // Clamp all notes to clipBeats (actual clip length), not totalBeats
        // (which is zoom-derived and can exceed the clip's real duration).
        const maxBeat = clipBeats;
        return input
            .filter((n) => !deleted.has(n.id))
            .map((n) => {
                const next = byId.get(n.id) ?? n;
                const clampedDur = Math.min(next.durationBeats, maxBeat - next.startBeat);
                return { ...next, durationBeats: Math.max(MIN_NOTE_BEATS, clampedDur) };
            })
            .filter((n) => n.durationBeats >= MIN_NOTE_BEATS && n.startBeat < maxBeat);
    }, [clipBeats]);

    const pasteClipboard = useCallback(() => {
        if (clipboardRef.current.length === 0) return;
        let minBeat = Infinity;
        let maxEnd = -Infinity;
        for (const n of clipboardRef.current) {
            if (n.startBeat < minBeat) minBeat = n.startBeat;
            const end = n.startBeat + n.durationBeats;
            if (end > maxEnd) maxEnd = end;
        }
        const pasteAt = playheadBeat != null
            ? playheadBeat
            : Math.max(0, ...notes.map((n) => n.startBeat + n.durationBeats));
        let offset = pasteAt - minBeat;
        // Bug fix: clamp the group offset so the last note stays within the clip,
        // rather than clamping individual notes (which breaks relative timing).
        const groupDuration = maxEnd - minBeat;
        const maxOffset = Math.max(0, clipBeats - groupDuration);
        offset = Math.max(-minBeat, Math.min(maxOffset, offset));
        // Bug #9: clamp to clipBeats (actual clip length), not totalBeats (zoom-derived).
        const pasted = clipboardRef.current.map((n) => ({
            ...n,
            id: genNoteId(),
            startBeat: Math.max(0, n.startBeat + offset),
        }));
        onNotesChange(enforceNoOverlap([...notes, ...pasted], new Set(pasted.map((n) => n.id))));
        setSelectedNotes(new Set(pasted.map((n) => n.id)));
    }, [notes, playheadBeat, clipBeats, onNotesChange, enforceNoOverlap]);

    const visiblePitches = useMemo(() => {
        if (drumMode) {
            return DRUM_LANES.map((d) => d.pitch).sort((a, b) => b - a);
        }
        const allPitches = Array.from({ length: TOTAL_KEYS }, (_, i) => HIGHEST_PITCH - i);
        if (!foldToUsedNotes) return allPitches;
        const usedSet = new Set(notes.map((n) => n.pitch));
        const filtered = allPitches.filter((pitch) => usedSet.has(pitch));
        // Never collapse editor to a near-empty row when clip has no notes.
        // If fold has nothing to show, fall back to full keyboard range.
        return filtered.length > 0 ? filtered : allPitches;
    }, [drumMode, foldToUsedNotes, notes]);

    const pitchRowIndex = useMemo(() => {
        const map = new Map<number, number>();
        visiblePitches.forEach((pitch, index) => map.set(pitch, index));
        return map;
    }, [visiblePitches]);

    const canvasWidth = totalBeats * pixelsPerBeat;
    const canvasHeight = visiblePitches.length * noteHeight;

    // Measure container
    useEffect(() => {
        const el = gridViewportRef.current;
        if (!el) return;
        const ro = new ResizeObserver((entries) => {
            for (const entry of entries) {
                setContainerWidth(entry.contentRect.width);
            }
        });
        ro.observe(el);
        setContainerWidth(el.clientWidth);
        return () => ro.disconnect();
    }, []);

    // Reset zoom on clip change
    useEffect(() => {
        Promise.resolve().then(() => setZoomOverrideH(null));
    }, [clipLengthBeats, totalBars]);

    // Sync keyboard scroll with grid + persist scroll position per track
    useEffect(() => {
        const gridEl = scrollRef.current;
        const kbEl = keyboardScrollRef.current;
        if (!gridEl || !kbEl) return;
        const onScroll = () => {
            kbEl.scrollTop = gridEl.scrollTop;
            // Persist vertical scroll position for this track
            if (trackIndex != null) {
                _scrollTopByTrack.set(trackIndex, gridEl.scrollTop);
            }
        };
        gridEl.addEventListener('scroll', onScroll);
        return () => {
            gridEl.removeEventListener('scroll', onScroll);
            // Save final scroll position on unmount (panel switch)
            if (trackIndex != null && gridEl) {
                _scrollTopByTrack.set(trackIndex, gridEl.scrollTop);
            }
        };
    }, [trackIndex]);

    // Bidirectional zoom: Ctrl/⌘ = H, Alt = V
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            if (e.altKey) {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -1 : 1;
                // BUG-14 FIX: Debounce noteHeight changes via RAF to
                // prevent per-pixel re-renders during fast scroll.
                if (noteHeightRafRef.current == null) {
                    noteHeightRafRef.current = requestAnimationFrame(() => {
                        noteHeightRafRef.current = null;
                    });
                    setNoteHeight((prev) => Math.max(MIN_NOTE_HEIGHT, Math.min(MAX_NOTE_HEIGHT, prev + delta)));
                }
            } else if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -2 : 2;
                setZoomOverrideH((prev) => {
                    // Bug fix: use pixelsPerBeatRef.current (always fresh) instead of
                    // the closed-over `pixelsPerBeat` which could be stale. This also
                    // avoids the teardown/re-attach cycle on every ppb change.
                    const current = prev ?? pixelsPerBeatRef.current;
                    return Math.max(MIN_PPB, Math.min(MAX_PPB, current + delta));
                });
            }
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
        // Intentionally omit pixelsPerBeat — accessed via ref to avoid listener teardown on zoom.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Pitch ↔ Y
    // Returns -1 when the pitch is not in the visible row set (e.g. drum-mode
    // pitches that aren't defined drum lanes). Callers must guard against -1
    // to avoid rendering notes at y=0 (top of grid).
    const pitchToY = useCallback(
        (pitch: number) => {
            const rowIndex = pitchRowIndex.get(pitch);
            if (rowIndex === undefined) return -1; // Bug #15: was returning 0 (top of grid)
            return rowIndex * noteHeight;
        },
        [noteHeight, pitchRowIndex],
    );
    const yToPitch = useCallback(
        (y: number) => {
            const row = Math.max(0, Math.min(visiblePitches.length - 1, Math.floor(y / noteHeight)));
            return visiblePitches[row] ?? DEFAULT_FOCUS_PITCH;
        },
        [noteHeight, visiblePitches],
    );

    // Bug #24: debounce note insertion in pencil-click mode to prevent double-notes
    // when a double-click fires two onClick events at nearly the same position.
    const lastInsertPosRef = useRef<{ x: number; y: number; t: number } | null>(null);
    // Bug #40: track whether a drag-selection is currently in progress, to prevent
    // note insertion from firing on the click-up that ends a selection drag.
    const isDragSelectingRef = useRef(false);
    // BUG-3 FIX: Track whether a note drag/resize is in progress to prevent
    // the subsequent click event from inserting a ghost note at the grid level.
    const isDragInProgressRef = useRef(false);

    const auditionOffTimersRef = useRef<Map<number, number>>(new Map());

    const stopAudition = useCallback((pitch: number) => {
        if (trackIndex == null) return;
        const existing = auditionOffTimersRef.current.get(pitch);
        if (existing != null) {
            window.clearTimeout(existing);
            auditionOffTimersRef.current.delete(pitch);
        }
        void engineApi.previewSamplerNoteOff(trackIndex, pitch).catch((err) => {
            console.warn('[PianoRoll] previewSamplerNoteOff failed:', err);
        });
    }, [trackIndex]);

    const auditionNote = useCallback((pitch: number, velocity = 100, durationMs = 140) => {
        if (trackIndex == null) return;
        stopAudition(pitch);
        void engineApi.previewSamplerNoteOn(trackIndex, pitch, velocity).catch((err) => {
            console.warn('[PianoRoll] previewSamplerNoteOn failed:', err);
        });
        const timer = window.setTimeout(() => {
            void engineApi.previewSamplerNoteOff(trackIndex, pitch).catch((err) => {
                console.warn('[PianoRoll] previewSamplerNoteOff(timer) failed:', err);
            });
            auditionOffTimersRef.current.delete(pitch);
        }, durationMs);
        auditionOffTimersRef.current.set(pitch, timer);
    }, [trackIndex, stopAudition]);

    useEffect(() => {
        const timers = auditionOffTimersRef.current;
        return () => {
            timers.forEach((timer) => window.clearTimeout(timer));
            timers.clear();
        };
    }, []);

    // On open/clip-change, center vertical focus around C3 so drawing starts in
    // the musical working range. Bug #16: do NOT re-center on noteHeight changes —
    // that jumps the view every time the user adjusts vertical zoom.
    // We read noteHeight via a ref so it is available without being a dependency.
    const noteHeightRef = useRef(noteHeight);
    const noteHeightRafRef = useRef<number | null>(null);
    useEffect(() => { noteHeightRef.current = noteHeight; }, [noteHeight]);

    useEffect(() => {
        const gridEl = scrollRef.current;
        const kbEl = keyboardScrollRef.current;
        if (!gridEl) return;
        const nh = noteHeightRef.current;
        requestAnimationFrame(() => {
            // Restore saved scroll position for this track, or center on notes
            const saved = trackIndex != null ? _scrollTopByTrack.get(trackIndex) : undefined;
            if (saved != null) {
                gridEl.scrollTop = saved;
                if (kbEl) kbEl.scrollTop = saved;
            } else {
                // AUTO-FOCUS: Compute the median pitch of existing notes
                // so the Piano Roll opens centered on the actual note content
                // instead of always defaulting to C3 (MIDI 60).
                let focusPitch: number;
                if (notes.length > 0) {
                    const sortedPitches = notes.map(n => n.pitch).sort((a, b) => a - b);
                    const mid = Math.floor(sortedPitches.length / 2);
                    focusPitch = sortedPitches.length % 2 === 0
                        ? Math.round((sortedPitches[mid - 1] + sortedPitches[mid]) / 2)
                        : sortedPitches[mid];
                } else {
                    focusPitch = DEFAULT_FOCUS_PITCH;
                }
                // Ensure the focus pitch is in the visible set
                if (!visiblePitches.includes(focusPitch)) {
                    focusPitch = visiblePitches[Math.floor(visiblePitches.length / 2)] ?? DEFAULT_FOCUS_PITCH;
                }
                const targetY = pitchToY(focusPitch);
                if (targetY < 0) return; // pitch not visible
                const centered = Math.max(0, targetY - gridEl.clientHeight * 0.5 + nh * 0.5);
                gridEl.scrollTop = centered;
                if (kbEl) kbEl.scrollTop = centered;
            }
        });
        // Re-run when the track or clip changes. Stale pitchToY/visiblePitches
        // accessed inside the RAF callback are fine for a one-time centering pass.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clipLengthBeats, trackIndex]);

    // Scale membership
    const scaleSet = useMemo(() => {
        if (!highlightScale) return null;
        const set = new Set<number>();
        for (let p = LOWEST_PITCH; p <= HIGHEST_PITCH; p++) {
            if (isInScale(p, rootNote, scaleName)) set.add(p);
        }
        return set;
    }, [highlightScale, rootNote, scaleName]);

    // Grid lines
    const gridLines = useMemo(() => {
        const lines: { x: number; isBar: boolean; label?: string; isMainBeat: boolean }[] = [];
        const epsilon = 1e-6;
        const snap = currentGridInterval;
        const visualStep = snap > 0 ? snap : 0.25; // fallback when OFF
        const totalSteps = Math.ceil(totalBeats / visualStep);
        for (let i = 0; i <= totalSteps; i++) {
            const beat = i * visualStep;
            if (beat > totalBeats + epsilon) break;
            const isBar = Math.abs((beat / beatsPerBar) - Math.round(beat / beatsPerBar)) < epsilon;
            const isMainBeat = Math.abs(beat - Math.round(beat)) < epsilon;
            lines.push({
                x: beat * pixelsPerBeat,
                isBar,
                isMainBeat,
                label: isBar ? `${Math.floor(beat / beatsPerBar) + 1}` : undefined,
            });
        }
        return lines;
    }, [totalBeats, beatsPerBar, pixelsPerBeat, currentGridInterval]);

    const rulerBeatLabels = useMemo(() => {
        const labels: Array<{ x: number; text: string; isBarStart: boolean }> = [];
        const maxBeat = Math.ceil(totalBeats + 1e-6);
        for (let beat = 0; beat <= maxBeat; beat += 1) {
            if (beat > totalBeats + 1e-6) break;
            const barIndex = Math.floor(beat / beatsPerBar);
            const beatInBar = (beat % beatsPerBar) + 1;
            labels.push({
                x: beat * pixelsPerBeat,
                text: `${barIndex + 1}.${beatInBar}`,
                isBarStart: beatInBar === 1,
            });
        }
        return labels;
    }, [totalBeats, beatsPerBar, pixelsPerBeat]);

    // Piano key data
    const pianoKeys = useMemo(() => {
        const drumNameByPitch = new Map(DRUM_LANES.map((d) => [d.pitch, d.name]));
        const keys: { pitch: number; name: string; isBlack: boolean; y: number; inScale: boolean; isC: boolean; drumName?: string }[] = [];
        for (const pitch of visiblePitches) {
            const note = pitch % 12;
            const octave = Math.floor(pitch / 12) + OCTAVE_LABEL_OFFSET;
            keys.push({
                pitch,
                name: `${KEY_NAMES[note]}${octave}`,
                isBlack: isBlackKey(pitch),
                y: pitchToY(pitch),
                inScale: scaleSet ? scaleSet.has(pitch) : true,
                isC: note === 0,
                drumName: drumNameByPitch.get(pitch),
            });
        }
        return keys;
    }, [pitchToY, scaleSet, visiblePitches]);

    // ── Note Actions ──
    const snapToCellStart = useCallback((rawBeat: number) => {
        const step = currentGridInterval > 0 ? currentGridInterval : 0.25;
        // Bug #44: clamp to clipBeats (actual clip boundary), not totalBeats (zoom-derived).
        const clamped = Math.max(0, Math.min(clipBeats - MIN_NOTE_BEATS, rawBeat));
        const cell = Math.floor((clamped + EPS) / step);
        return Math.max(0, Math.min(clipBeats - MIN_NOTE_BEATS, cell * step));
    }, [currentGridInterval, clipBeats]);

    const insertNoteFromPointer = useCallback((clientX: number, clientY: number, target: HTMLElement) => {
        const rect = target.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        const pitch = yToPitch(y);
        const rawBeat = x / pixelsPerBeat;
        const beat = snapToCellStart(rawBeat);
        // Bug #44: refuse insertion at or beyond the clip boundary.
        if (beat >= clipBeats) return;

        const gridStep = currentGridInterval > 0 ? currentGridInterval : 0.25;
        const duration = Math.max(MIN_NOTE_BEATS, Math.min(gridStep, clipBeats - beat));
        const newNote: MidiNote = {
            id: genNoteId(),
            pitch,
            startBeat: beat,
            durationBeats: duration,
            velocity: 100,
        };
        onNotesChange(enforceNoOverlap([...notes, newNote], new Set([newNote.id])));
        setStepInputCursorBeat(Math.min(clipBeats, beat + duration));
        auditionNote(pitch, 100, 160);
    }, [yToPitch, pixelsPerBeat, clipBeats, currentGridInterval, onNotesChange, notes, auditionNote, enforceNoOverlap, snapToCellStart]);

    const handleGridClick = useCallback(
        (e: React.MouseEvent) => {
            editorRootRef.current?.focus();
            if (tool === 'draw' && pianoPencilMode) {
                // Bug #40: if this click ended a drag-selection, don't insert a note.
                if (isDragSelectingRef.current) return;
                // BUG-3 FIX: if this click follows a note drag/resize, don't insert.
                if (isDragInProgressRef.current) return;
                // Bug #24: debounce — ignore click if a note was just inserted
                // at nearly the same position (double-click protection).
                const now = Date.now();
                const last = lastInsertPosRef.current;
                const tooClose = last &&
                    now - last.t < 250 &&
                    Math.abs(e.clientX - last.x) < 6 &&
                    Math.abs(e.clientY - last.y) < 6;
                if (tooClose) return;
                lastInsertPosRef.current = { x: e.clientX, y: e.clientY, t: now };
                insertNoteFromPointer(e.clientX, e.clientY, e.currentTarget as HTMLElement);
            }
        },
        [tool, pianoPencilMode, insertNoteFromPointer],
    );

    const handleGridDoubleClick = useCallback((e: React.MouseEvent) => {
        editorRootRef.current?.focus();
        if (tool !== 'draw' || pianoPencilMode) return;
        // BUG-3 FIX: if this double-click follows a note drag/resize, don't insert.
        if (isDragInProgressRef.current) return;
        // In non-pencil draw mode, double-click inserts. Single-click does not.
        // Record timestamp so a follow-up onClick (if any) won't re-insert.
        lastInsertPosRef.current = { x: e.clientX, y: e.clientY, t: Date.now() };
        insertNoteFromPointer(e.clientX, e.clientY, e.currentTarget as HTMLElement);
    }, [tool, pianoPencilMode, insertNoteFromPointer]);

    const handleGridPaintStart = useCallback((e: React.MouseEvent) => {
        if (tool !== 'paint') return;
        editorRootRef.current?.focus();
        e.preventDefault();
        e.stopPropagation();

        const target = e.currentTarget as HTMLElement;
        const rect = target.getBoundingClientRect();
        const step = currentGridInterval > 0 ? currentGridInterval : 0.25;
        const duration = Math.max(MIN_NOTE_BEATS, step);
        const pitch = yToPitch(e.clientY - rect.top);

        // Bug #41: toFixed(6) can produce different strings for equal floats due to
        // rounding artifacts on long timelines. Round to 4 decimal places instead.
        const beatKey = (b: number) => Math.round(b * 10000);
        // Audit #2 fix: use notesRef.current instead of captured `notes` to prevent
        // stale closure from overwriting concurrent backend edits (undo/redo).
        let workingNotes = notesRef.current;
        const occupied = new Set(
            workingNotes
                .filter((n) => n.pitch === pitch)
                .map((n) => `${n.pitch}:${beatKey(n.startBeat)}`),
        );

        const paintAt = (clientX: number, clientY: number) => {
            const x = clientX - rect.left;
            const y = clientY - rect.top;
            const drawPitch = yToPitch(y);
            const beat = Math.max(0, Math.min(clipBeats - duration, snapToCellStart(x / pixelsPerBeat)));
            const key = `${drawPitch}:${beatKey(beat)}`;
            if (occupied.has(key)) return;
            // Spatial overlap check: don't insert if an existing note at this pitch
            // physically covers the target beat range (handles float precision drift).
            const hasOverlap = workingNotes.some(
                (n) => n.pitch === drawPitch && n.startBeat < beat + duration && n.startBeat + n.durationBeats > beat,
            );
            if (hasOverlap) return;
            occupied.add(key);
            const newNote: MidiNote = {
                id: genNoteId(),
                pitch: drawPitch,
                startBeat: beat,
                durationBeats: duration,
                velocity: 100,
            };
            workingNotes = enforceNoOverlap([...workingNotes, newNote], new Set([newNote.id]));
            onNotesChange(workingNotes);
            auditionNote(drawPitch, 100, 95);
        };

        paintAt(e.clientX, e.clientY);

        const onMove = (ev: MouseEvent) => {
            paintAt(ev.clientX, ev.clientY);
        };
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        // Audit #15 fix: dep was totalBeats (zoom-derived), should be clipBeats.
    }, [tool, currentGridInterval, yToPitch, clipBeats, pixelsPerBeat, onNotesChange, auditionNote, enforceNoOverlap, snapToCellStart]);

    const applyRatchet = useCallback(() => {
        const repeats = Math.max(2, Math.min(12, Math.round(ratchetCount)));
        const targets = selectedNotes.size > 0 ? selectedNotes : new Set(notes.map((n) => n.id));
        if (targets.size === 0) return;

        const next: MidiNote[] = [];
        const newSelected = new Set<string>();
        for (const note of notes) {
            if (!targets.has(note.id)) {
                next.push(note);
                continue;
            }
            const sub = Math.max(0.03125, note.durationBeats / repeats);
            for (let i = 0; i < repeats; i++) {
                const subStart = note.startBeat + sub * i;
                // Audit #28 fix: clamp sub-notes to clip boundary.
                if (subStart >= clipBeats) break;
                const id = genNoteId();
                next.push({
                    ...note,
                    id,
                    startBeat: subStart,
                    durationBeats: Math.min(sub, clipBeats - subStart),
                });
                newSelected.add(id);
            }
        }

        // Bug #13: ratchet sub-notes must go through enforceNoOverlap to avoid
        // collisions with other notes at the same pitch.
        onNotesChange(enforceNoOverlap(next, newSelected));
        setSelectedNotes(newSelected);
    }, [ratchetCount, selectedNotes, notes, onNotesChange, enforceNoOverlap, clipBeats]);

    // BUG-12: Ref to track the last-clicked note for Shift+Click range selection.
    const lastClickedNoteIdRef = useRef<string | null>(null);

    const handleNoteClick = useCallback(
        (e: React.MouseEvent, noteId: string) => {
            e.stopPropagation();
            editorRootRef.current?.focus();
            const target = notes.find((n) => n.id === noteId);
            if (target) {
                if (!e.shiftKey) auditionNote(target.pitch, target.velocity, 120);
            }

            if (e.shiftKey && lastClickedNoteIdRef.current) {
                // BUG-12 FIX: Range selection — select all notes whose beat range
                // and pitch fall within the bounding box between the last-clicked
                // note and the current shift-clicked note.
                const anchor = notes.find((n) => n.id === lastClickedNoteIdRef.current);
                if (anchor && target) {
                    const minBeat = Math.min(anchor.startBeat, target.startBeat);
                    const maxBeat = Math.max(
                        anchor.startBeat + anchor.durationBeats,
                        target.startBeat + target.durationBeats,
                    );
                    const minPitch = Math.min(anchor.pitch, target.pitch);
                    const maxPitch = Math.max(anchor.pitch, target.pitch);
                    const rangeIds = new Set<string>();
                    for (const n of notes) {
                        const noteEnd = n.startBeat + n.durationBeats;
                        if (
                            n.pitch >= minPitch &&
                            n.pitch <= maxPitch &&
                            n.startBeat < maxBeat &&
                            noteEnd > minBeat
                        ) {
                            rangeIds.add(n.id);
                        }
                    }
                    setSelectedNotes(rangeIds);
                    return; // don't update lastClickedNoteIdRef on range select
                }
            }

            // Single click or Shift without anchor — standard toggle behavior
            lastClickedNoteIdRef.current = noteId;
            setSelectedNotes((prev) => {
                const next = new Set(prev);
                if (e.shiftKey) {
                    if (next.has(noteId)) next.delete(noteId);
                    else next.add(noteId);
                } else {
                    next.clear();
                    next.add(noteId);
                }
                return next;
            });
        },
        [notes, auditionNote],
    );

    const handleGridSelectionStart = useCallback((e: React.MouseEvent) => {
        if (tool === 'paint') return;
        editorRootRef.current?.focus();
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const startX = e.clientX - rect.left;
        const startY = e.clientY - rect.top;
        setSelectionRect({ x1: startX, y1: startY, x2: startX, y2: startY });
        // Bug #40: signal that a drag-selection is now in progress so onClick
        // (which fires after mouseup) won't also trigger a note insertion.
        isDragSelectingRef.current = false; // reset; set true once we actually move

        const keepExisting = e.shiftKey;
        if (!keepExisting) setSelectedNotes(new Set());

        const onMove = (ev: MouseEvent) => {
            isDragSelectingRef.current = true; // we moved — this is a real drag
            const x = Math.max(0, Math.min(canvasWidth, ev.clientX - rect.left));
            const y = Math.max(0, Math.min(canvasHeight, ev.clientY - rect.top));
            setSelectionRect({ x1: startX, y1: startY, x2: x, y2: y });
        };

        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            // Reset after a brief delay so the click handler has a chance to check it.
            setTimeout(() => { isDragSelectingRef.current = false; }, 0);
            setSelectionRect((current) => {
                if (!current) return null;
                const minX = Math.min(current.x1, current.x2);
                const maxX = Math.max(current.x1, current.x2);
                const minY = Math.min(current.y1, current.y2);
                const maxY = Math.max(current.y1, current.y2);
                // Bug #30: 3px threshold was too tight — any slight hand movement during
                // a click triggered a drag-selection instead. 6px is more ergonomic.
                const isClick = Math.abs(maxX - minX) < 6 && Math.abs(maxY - minY) < 6;
                if (isClick) return null;

                const hits = new Set<string>();
                for (const note of notes) {
                    const nx = note.startBeat * pixelsPerBeat;
                    const rawNy = pitchToY(note.pitch);
                    if (rawNy < 0) continue; // Bug #15: pitch not in visible row set
                    const ny = rawNy + 1;
                    const nw = Math.max(4, note.durationBeats * pixelsPerBeat - 1);
                    const nh = noteHeight - 2;
                    const overlap = nx < maxX && nx + nw > minX && ny < maxY && ny + nh > minY;
                    if (overlap) hits.add(note.id);
                }
                setSelectedNotes((prev) => {
                    if (keepExisting) {
                        const merged = new Set(prev);
                        hits.forEach((id) => merged.add(id));
                        return merged;
                    }
                    return hits;
                });
                return null;
            });
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [tool, canvasWidth, canvasHeight, notes, pixelsPerBeat, pitchToY, noteHeight]);

    const handleGridMouseDown = useCallback((e: React.MouseEvent) => {
        if (tool === 'paint') {
            handleGridPaintStart(e);
            return;
        }
        handleGridSelectionStart(e);
    }, [tool, handleGridPaintStart, handleGridSelectionStart]);

    const snapEnabled = useGridStore((s) => s.snapEnabled);

    // Note drag
    const handleNoteDrag = useCallback(
        (e: React.MouseEvent, noteId: string) => {
            if (tool === 'paint') return;
            e.stopPropagation();
            e.preventDefault();
            editorRootRef.current?.focus();
            // BUG-3 FIX: Flag that a note drag/resize is starting.
            isDragInProgressRef.current = true;

            const startX = e.clientX;
            const startY = e.clientY;
            const note = notes.find((n) => n.id === noteId);
            if (!note) return;

            const target = e.currentTarget as HTMLElement;
            const edgeGripPx = 6;
            // Bug #26: use getBoundingClientRect for reliable edge detection
            // instead of offsetX which can be relative to a child element.
            const targetRect = target.getBoundingClientRect();
            const localX = e.clientX - targetRect.left;
            const mode = localX >= targetRect.width - edgeGripPx
                ? 'resize-right'
                : localX <= edgeGripPx
                    ? 'resize-left'
                    : 'move';

            const selectedIds = selectedNotes.has(noteId) ? new Set(selectedNotes) : new Set([noteId]);
            if (!selectedNotes.has(noteId)) {
                setSelectedNotes(new Set([noteId]));
            }
            const startStates = new Map(
                notes
                    .filter((n) => selectedIds.has(n.id))
                    .map((n) => [n.id, { startBeat: n.startBeat, pitch: n.pitch, durationBeats: n.durationBeats }] as const),
            );
            let lastAuditionPitch: number | null = null;

            // Note: drag moves call onNotesChange directly (high frequency).
            // Backend push_undo fires via the throttled updateMidiClip IPC.

            const onMove = (ev: MouseEvent) => {
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                const beatDelta = dx / pixelsPerBeatRef.current;
                // Audit #7 fix: add dead zone — require >50% of row height before engaging
                // pitch change, preventing jitter during horizontal-only moves.
                const pitchDelta = Math.abs(dy) > noteHeight * 0.5
                    ? -Math.round(dy / noteHeight)
                    : 0;

                // Audit #8 fix: use shared isMac to match useKeyboardShortcuts.ts pattern.
                const snapOverrideHeld = isMac ? ev.metaKey : ev.ctrlKey;
                const shouldSnap = snapEnabled && !snapOverrideHeld;

                // Audit #1 fix: use notesRef.current instead of captured `notes` to prevent
                // stale closure from overwriting concurrent backend edits (undo/redo).
                const currentNotes = notesRef.current;
                const updated = currentNotes.map((n) => {
                    if (!selectedIds.has(n.id)) return n;
                    const original = startStates.get(n.id);
                    if (!original) return n;

                    if (mode === 'resize-right') {
                        if (n.id !== noteId) return n;
                        const maxDur = Math.max(MIN_NOTE_BEATS, clipBeats - original.startBeat);
                        const rawDur = original.durationBeats + beatDelta;
                        const finalDur = shouldSnap ? snapBeat(rawDur, beatsPerBar, pixelsPerBeatRef.current) : rawDur;
                        return {
                            ...n,
                            durationBeats: Math.min(maxDur, Math.max(MIN_NOTE_BEATS, finalDur)),
                        };
                    }
                    if (mode === 'resize-left') {
                        if (n.id !== noteId) return n;
                        const rawStart = original.startBeat + beatDelta;
                        const noteEnd = original.startBeat + original.durationBeats;
                        const maxStart = noteEnd - MIN_NOTE_BEATS;
                        const snappedBeat = Math.max(0, Math.min(maxStart, shouldSnap ? snapBeat(rawStart, beatsPerBar, pixelsPerBeatRef.current) : rawStart));
                        return {
                            ...n,
                            startBeat: snappedBeat,
                            durationBeats: Math.max(MIN_NOTE_BEATS, noteEnd - snappedBeat),
                        };
                    }

                    const rawStart = original.startBeat + beatDelta;
                    const newBeat = Math.max(0, Math.min(clipBeats - MIN_NOTE_BEATS, shouldSnap ? snapBeat(rawStart, beatsPerBar, pixelsPerBeatRef.current) : rawStart));
                    let newPitch: number;
                    if (drumMode && pitchDelta !== 0) {
                        const drumPitches = visiblePitches;
                        const currentRow = drumPitches.indexOf(original.pitch);
                        if (currentRow < 0) {
                            newPitch = original.pitch;
                        } else {
                            const newRow = Math.max(0, Math.min(drumPitches.length - 1, currentRow - pitchDelta));
                            newPitch = drumPitches[newRow];
                        }
                    } else {
                        newPitch = Math.max(LOWEST_PITCH, Math.min(LOWEST_PITCH + TOTAL_KEYS - 1, original.pitch + pitchDelta));
                    }
                    return { ...n, startBeat: newBeat, pitch: newPitch };
                });
                onNotesChange(enforceNoOverlap(updated, selectedIds));

                if (mode === 'move') {
                    const lead = updated.find((n) => n.id === noteId);
                    if (lead && lead.pitch !== lastAuditionPitch) {
                        lastAuditionPitch = lead.pitch;
                        auditionNote(lead.pitch, lead.velocity, 110);
                    }
                }
            };

            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                // BUG-3 FIX: Clear drag flag after rAF so any trailing click
                // event from this mouseup doesn't trigger note insertion.
                requestAnimationFrame(() => {
                    isDragInProgressRef.current = false;
                });
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        },
        // Audit #1 fix: removed `notes` and `pixelsPerBeat` from deps — now uses refs.
        [tool, onNotesChange, noteHeight, snapBeat, beatsPerBar, clipBeats, selectedNotes, snapEnabled, auditionNote, enforceNoOverlap, drumMode, visiblePitches],
    );

    const [hoveredNoteEdge, setHoveredNoteEdge] = useState<string | null>(null);

    const handleNoteMouseMove = (e: React.MouseEvent, noteId: string) => {
        // Bug #26: offsetX is relative to the event target which may be a child element,
        // not the note div itself. Use getBoundingClientRect for reliable edge detection.
        const noteDiv = e.currentTarget as HTMLElement;
        const rect = noteDiv.getBoundingClientRect();
        const localX = e.clientX - rect.left;
        const edgeGripPx = 6;
        const isEdge = localX >= rect.width - edgeGripPx || localX <= edgeGripPx;
        setHoveredNoteEdge(isEdge ? noteId : null);
    };

    // Velocity lane drag (single or multi-note)
    const handleVelocityMouseDown = useCallback((noteId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        editorRootRef.current?.focus();

        const laneEl = (e.currentTarget as HTMLElement).parentElement;
        if (!laneEl) return;
        const laneRect = laneEl.getBoundingClientRect();
        const startY = e.clientY;
        const startedValues = new Map<string, number>();
        const targets = selectedNotes.has(noteId)
            ? new Set(selectedNotes)
            : new Set([noteId]);

        if (!selectedNotes.has(noteId)) {
            setSelectedNotes(new Set([noteId]));
        }

        const targetLead = notes.find((n) => n.id === noteId);
        if (targetLead) {
            auditionNote(targetLead.pitch, targetLead.velocity, 120);
        }

        notes.forEach((n) => {
            if (targets.has(n.id)) startedValues.set(n.id, readLaneValue(n, activeLane));
        });

        let moved = false;

        const applyAbsoluteFromY = (clientY: number) => {
            const y = Math.max(0, Math.min(VELOCITY_LANE_HEIGHT, clientY - laneRect.top));
            const absolute = Math.round(Math.max(1, Math.min(127, (1 - y / VELOCITY_LANE_HEIGHT) * 127)));
            if (activeLane === 'velocity') {
                onNotesChange(notes.map((n) => (targets.has(n.id) ? { ...n, velocity: absolute } : n)));
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

        const onMove = (ev: MouseEvent) => {
            const dy = ev.clientY - startY;
            const sensitivity = ev.shiftKey ? 0.5 : 1.5;
            const delta = Math.round(-dy * sensitivity);
            moved = moved || Math.abs(dy) > 1;

            if (activeLane === 'velocity') {
                // Bug fix: use notesRef.current instead of the closed-over `notes` from
                // drag-start — prevents overwriting backend updates that arrive during drag.
                onNotesChange(notesRef.current.map((n) => {
                    if (!targets.has(n.id)) return n;
                    const base = startedValues.get(n.id) ?? n.velocity;
                    return { ...n, velocity: Math.max(1, Math.min(127, base + delta)) };
                }));
            } else {
                setLaneValuesByNote((prev) => {
                    const next = { ...prev, [activeLane]: { ...prev[activeLane] } };
                    targets.forEach((id) => {
                        const base = startedValues.get(id) ?? 0; // BUG-P11 FIX: no stored CC = no modulation = 0
                        next[activeLane][id] = Math.max(1, Math.min(127, base + delta));
                    });
                    return next;
                });
            }
        };

        const onUp = (ev: MouseEvent) => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            if (!moved) {
                applyAbsoluteFromY(ev.clientY);
            }
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [onNotesChange, selectedNotes, activeLane, readLaneValue, auditionNote, notes]);

    const transposeNotes = useCallback((delta: number) => {
        // Bug #34: Only transpose selected notes. If nothing selected, do nothing
        // to avoid accidentally transposing the entire clip.
        if (delta === 0 || notes.length === 0 || selectedNotes.size === 0) return;
        const targets = selectedNotes;
        const next = notes.map((n) => {
            if (!targets.has(n.id)) return n;
            return { ...n, pitch: Math.max(LOWEST_PITCH, Math.min(HIGHEST_PITCH, n.pitch + delta)) };
        });
        setClipTranspose((prev) => Math.max(-24, Math.min(24, prev + delta)));
        onNotesChange(enforceNoOverlap(next, targets));
    }, [notes, onNotesChange, selectedNotes, enforceNoOverlap]);

    const quantizeAllNotesToGrid = useCallback((amountPct = quantizeAmount) => {
        const step = currentGridInterval > 0 ? currentGridInterval : 0.25;
        const amt = Math.max(0, Math.min(1, amountPct / 100));
        // Bug #35: Only quantize selected notes. Require an explicit selection.
        if (selectedNotes.size === 0) return;
        const targetIds = selectedNotes;
        const next = notes.map((n) => {
            if (!targetIds.has(n.id)) return n;
            const snappedStart = snapBeat(n.startBeat, beatsPerBar, pixelsPerBeat);
            const snappedDur = Math.max(step, Math.round(n.durationBeats / step) * step);
            const blendedStart = n.startBeat + (snappedStart - n.startBeat) * amt;
            const blendedDur = n.durationBeats + (snappedDur - n.durationBeats) * amt;
            return {
                ...n,
                // Bug fix: guard against step > clipBeats which makes (clipBeats - step) negative,
                // causing the note to teleport to beat 0.
                startBeat: Math.max(0, Math.min(Math.max(0, clipBeats - step), blendedStart)),
                durationBeats: Math.max(step, Math.min(clipBeats - blendedStart, blendedDur)),
            };
        });
        onNotesChange(enforceNoOverlap(next, targetIds));
    }, [notes, onNotesChange, currentGridInterval, snapBeat, beatsPerBar, pixelsPerBeat, clipBeats, selectedNotes, quantizeAmount, enforceNoOverlap]);

    const duplicateSelection = useCallback(() => {
        const targets = selectedNotes.size > 0 ? notes.filter((n) => selectedNotes.has(n.id)) : notes;
        if (targets.length === 0) return;
        const spanStart = Math.min(...targets.map((n) => n.startBeat));
        const spanEnd = Math.max(...targets.map((n) => n.startBeat + n.durationBeats));
        // Audit #33 fix: always use selection span for shift distance,
        // not max(interval, span) which creates gaps.
        const shift = spanEnd - spanStart;
        // Bug #10: clamp to clipBeats (actual clip length), not totalBeats (zoom-derived).
        const clones = targets.map((n) => ({
            ...n,
            id: genNoteId(),
            startBeat: Math.max(0, Math.min(clipBeats - MIN_NOTE_BEATS, n.startBeat + shift)),
            selected: false,
        }));
        onNotesChange(enforceNoOverlap([...notes, ...clones], new Set(clones.map((n) => n.id))));
        setSelectedNotes(new Set(clones.map((n) => n.id)));
    }, [selectedNotes, notes, currentGridInterval, clipBeats, onNotesChange, enforceNoOverlap]);

    const selectSamePitch = useCallback(() => {
        if (selectedNotes.size === 0) return;
        const seed = notes.find((n) => selectedNotes.has(n.id));
        if (!seed) return;
        const samePitchIds = notes.filter((n) => n.pitch === seed.pitch).map((n) => n.id);
        setSelectedNotes(new Set(samePitchIds));
    }, [selectedNotes, notes]);

    const humanizeSelection = useCallback(() => {
        // Bug #36: Only humanize selected notes. Require an explicit selection.
        if (selectedNotes.size === 0) return;
        const targets = selectedNotes;
        const step = currentGridInterval > 0 ? currentGridInterval : 0.25;
        const next = notes.map((n) => {
            if (!targets.has(n.id)) return n;
            // Audit #31 fix: seed humanize from note ID for deterministic results.
            // Simple hash: sum of char codes mod 1000 / 1000 → pseudo-random 0..1.
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
        onNotesChange(enforceNoOverlap(next, targets));
    }, [selectedNotes, notes, currentGridInterval, clipBeats, onNotesChange, enforceNoOverlap]);

    const applyLegato = useCallback(() => {
        // Bug #37: Only apply legato to selected notes. Require an explicit selection.
        if (selectedNotes.size === 0) return;
        const targets = selectedNotes;
        const byPitch = new Map<number, MidiNote[]>();
        notes.forEach((n) => {
            if (!targets.has(n.id)) return;
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
        if (durationById.size === 0) return;
        onNotesChange(enforceNoOverlap(notes.map((n) => (
            durationById.has(n.id)
                ? { ...n, durationBeats: Math.max(MIN_NOTE_BEATS, Math.min(clipBeats - n.startBeat, durationById.get(n.id) ?? n.durationBeats)) }
                : n
        )), targets));
    }, [selectedNotes, notes, clipBeats, onNotesChange, enforceNoOverlap]);

    // Canvas note renderer
    useEffect(() => {
        const canvas = noteCanvasRef.current;
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.ceil(canvasWidth * dpr);
        canvas.height = Math.ceil(canvasHeight * dpr);
        canvas.style.width = `${canvasWidth}px`;
        canvas.style.height = `${canvasHeight}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);

        // Ghost notes (same track, other clips) for harmony/rhythm context.
        for (const note of ghostNotes) {
            const x = note.startBeat * pixelsPerBeat;
            const rawY = pitchToY(note.pitch);
            if (rawY < 0) continue; // Bug #15: pitch not in visible row set
            const y = rawY + 1;
            const w = Math.max(3, note.durationBeats * pixelsPerBeat - 1);
            const h = noteHeight - 2;
            if (x + w < 0 || x > canvasWidth) continue;
            ctx.globalAlpha = 0.17;
            ctx.fillStyle = '#9db2d6';
            ctx.fillRect(x, y, w, h);
        }

        for (const note of notes) {
            const x = note.startBeat * pixelsPerBeat;
            const rawY = pitchToY(note.pitch);
            if (rawY < 0) continue; // Bug #15: pitch not in visible row set
            const y = rawY + 1;
            const w = Math.max(4, note.durationBeats * pixelsPerBeat - 1);
            const h = noteHeight - 2;

            // Note body — rounded rect with subtle gradient feel
            // Audit #48: expand alpha range from [0.4, 1.0] to [0.15, 1.0] for better
            // visual discrimination of low velocities.
            const alpha = 0.15 + (note.velocity / 127) * 0.85;
            ctx.globalAlpha = alpha;
            ctx.fillStyle = color;
            ctx.beginPath();
            const r = Math.min(2, h / 4);
            ctx.roundRect(x, y, w, h, r);
            ctx.fill();

            // Top highlight edge (gives 3D feel)
            ctx.globalAlpha = 0.35;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(x + 1, y, w - 2, 1);

            // Selection outline
            if (selectedNotes.has(note.id)) {
                ctx.globalAlpha = 1;
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.roundRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1), r);
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;
    }, [notes, ghostNotes, selectedNotes, canvasWidth, canvasHeight, pixelsPerBeat, noteHeight, color, pitchToY]);

    // MIDI-editor-local keyboard editing (active only when this editor has focus).
    // Audit #10 fix: also check that active element is not an editable field.
    useEffect(() => {
        if (!isEditorFocused) return;
        const onKeyDown = (e: KeyboardEvent) => {
            // Audit #10 fix: don't intercept keys when an editable field is focused
            // (inputs, textareas, contenteditable) or inside assistant chat.
            const active = document.activeElement as HTMLElement | null;
            if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
            if (active?.closest?.('[data-assistant-chat]')) return;

            const hasSelected = selectedNotes.size > 0;
            const stepBeatRaw = currentGridInterval;
            const stepBeat = stepBeatRaw > 0 ? stepBeatRaw : 0.25;

            // Audit #52: Escape deselects all — standard in all DAWs.
            if (e.key === 'Escape') {
                e.preventDefault();
                setSelectedNotes(new Set());
                return;
            }

            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (!hasSelected) return;
                e.preventDefault();
                e.stopPropagation();
                onNotesChange(notes.filter((n) => !selectedNotes.has(n.id)));
                setSelectedNotes(new Set());
                return;
            }

            // Ctrl+Z / Cmd+Z / Ctrl+Y — Undo/Redo
            // Intentionally NOT handled here: the global useKeyboardShortcuts
            // hook routes these to engine.undo() / engine.redo() which operate
            // on the unified backend undo stack.

            // Audit #51: Ctrl+X / Cmd+X — Cut selected notes
            if ((e.ctrlKey || e.metaKey) && e.code === 'KeyX') {
                e.preventDefault();
                e.stopPropagation();
                copySelection();
                if (selectedNotes.size > 0) {
                    onNotesChange(notes.filter((n) => !selectedNotes.has(n.id)));
                    setSelectedNotes(new Set());
                }
                return;
            }

            // Ctrl+C / Cmd+C — Copy selected notes
            if ((e.ctrlKey || e.metaKey) && e.code === 'KeyC') {
                e.preventDefault();
                e.stopPropagation();
                copySelection();
                return;
            }

            // Ctrl+V / Cmd+V — Paste notes from clipboard
            if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') {
                e.preventDefault();
                e.stopPropagation();
                pasteClipboard();
                return;
            }

            // Ctrl+A / Cmd+A — select all notes
            if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
                e.preventDefault();
                e.stopPropagation();
                setSelectedNotes(new Set(notes.map((n) => n.id)));
                return;
            }

            // Ctrl/Cmd + D — duplicate selected (or all) notes
            if ((e.ctrlKey || e.metaKey) && e.code === 'KeyD') {
                e.preventDefault();
                e.stopPropagation();
                duplicateSelection();
                return;
            }

            // Q — quantize selected (or all) to current grid amount.
            // Shift+Q forces 100% quantize.
            if (!e.ctrlKey && !e.metaKey && e.code === 'KeyQ') {
                e.preventDefault();
                e.stopPropagation();
                quantizeAllNotesToGrid(e.shiftKey ? 100 : quantizeAmount);
                return;
            }

            // H — humanize selected (or all)
            if (!e.ctrlKey && !e.metaKey && e.code === 'KeyH') {
                e.preventDefault();
                e.stopPropagation();
                humanizeSelection();
                return;
            }

            // L — legato on selected (or all per pitch)
            if (!e.ctrlKey && !e.metaKey && e.code === 'KeyL') {
                e.preventDefault();
                e.stopPropagation();
                applyLegato();
                return;
            }

            // Shift+P — select all notes with the same pitch as first selected note.
            if (e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyP') {
                e.preventDefault();
                e.stopPropagation();
                selectSamePitch();
                return;
            }

            // Step input octave down/up.
            if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key === '[') {
                e.preventDefault();
                setStepInputOctave((prev) => Math.max(0, prev - 1));
                return;
            }
            if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key === ']') {
                e.preventDefault();
                setStepInputOctave((prev) => Math.min(9, prev + 1));
                return;
            }

            // Step input from keyboard: A W S E D F T G Y H U J K
            // Bug Fix: Only allow these when the user is explicitly focused on the canvas root,
            // not just anywhere in the DAW (which was swallowing typing shortcuts like 'S' for solo).
            if (!e.ctrlKey && !e.metaKey && !e.altKey && document.activeElement === editorRootRef.current) {
                const keyToSemitone: Record<string, number> = {
                    KeyA: 0,
                    KeyW: 1,
                    KeyS: 2,
                    KeyE: 3,
                    KeyD: 4,
                    KeyF: 5,
                    KeyT: 6,
                    KeyG: 7,
                    KeyY: 8,
                    KeyH: 9,
                    KeyU: 10,
                    KeyJ: 11,
                    KeyK: 12,
                };
                if (Object.prototype.hasOwnProperty.call(keyToSemitone, e.code)) {
                    e.preventDefault();
                    e.stopPropagation();
                    const semitone = keyToSemitone[e.code];
                    const pitch = Math.max(LOWEST_PITCH, Math.min(HIGHEST_PITCH, stepInputOctave * 12 + semitone));
                    const step = currentGridInterval > 0 ? currentGridInterval : 0.25;
                    const beat = Math.max(0, Math.min(clipBeats - step, snapBeat(stepInputCursorBeat, beatsPerBar, pixelsPerBeat)));
                    if (beat >= clipBeats) return; // cursor past clip end
                    const newNote: MidiNote = {
                        id: genNoteId(),
                        pitch,
                        startBeat: beat,
                        durationBeats: Math.min(step, clipBeats - beat),
                        velocity: 100,
                    };
                    onNotesChange(enforceNoOverlap([...notes, newNote], new Set([newNote.id])));
                    setSelectedNotes(new Set([newNote.id]));
                    setStepInputCursorBeat((prev) => Math.min(clipBeats, prev + step));
                    auditionNote(pitch, 100, 170);
                    return;
                }
            }

            if (!hasSelected) return;
            if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;

            e.preventDefault();
            e.stopPropagation();

            const beatStep = stepBeat;
            const moved = notes.map((n) => {
                if (!selectedNotes.has(n.id)) return n;

                // Shift+Up/Down: transpose by octave (12 semitones)
                if (e.key === 'ArrowUp') {
                    const pitchStep = e.shiftKey ? 12 : 1;
                    // BUG-P6 FIX: Update clipTranspose counter to match sidebar display.
                    setClipTranspose(prev => Math.max(-24, Math.min(24, prev + pitchStep)));
                    return { ...n, pitch: Math.min(HIGHEST_PITCH, n.pitch + pitchStep) };
                }
                if (e.key === 'ArrowDown') {
                    const pitchStep = e.shiftKey ? 12 : 1;
                    // BUG-P6 FIX: Update clipTranspose counter to match sidebar display.
                    setClipTranspose(prev => Math.max(-24, Math.min(24, prev - pitchStep)));
                    return { ...n, pitch: Math.max(LOWEST_PITCH, n.pitch - pitchStep) };
                }

                // Audit #54: Shift+Left/Right adjusts note length (shrink/extend duration).
                if (e.shiftKey && e.key === 'ArrowLeft') {
                    return { ...n, durationBeats: Math.max(MIN_NOTE_BEATS, n.durationBeats - beatStep) };
                }
                if (e.shiftKey && e.key === 'ArrowRight') {
                    const maxDur = clipBeats - n.startBeat;
                    return { ...n, durationBeats: Math.min(maxDur, n.durationBeats + beatStep) };
                }

                // Plain Left/Right: move note start horizontally.
                if (e.key === 'ArrowLeft') {
                    return { ...n, startBeat: Math.max(0, n.startBeat - beatStep) };
                }
                // Bug #8: clamp to clipBeats (actual clip length), not totalBeats (zoom-derived).
                return { ...n, startBeat: Math.min(clipBeats - MIN_NOTE_BEATS, n.startBeat + beatStep) };
            });
            onNotesChange(enforceNoOverlap(moved, selectedNotes));
        };
        window.addEventListener('keydown', onKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
    }, [
        isEditorFocused,
        selectedNotes,
        notes,
        onNotesChange,
        currentGridInterval,
        clipBeats, // Bug #31: was totalBeats (zoom-derived), use actual clip length
        duplicateSelection,
        quantizeAllNotesToGrid,
        quantizeAmount,
        humanizeSelection,
        applyLegato,
        copySelection,
        pasteClipboard,
        selectSamePitch,
        stepInputOctave,
        stepInputCursorBeat,
        pixelsPerBeat,
        snapBeat,
        beatsPerBar,
        auditionNote,
        enforceNoOverlap,
    ]);

    // Clip duration label
    const clipDurationLabel = useMemo(() => {
        const bars = Math.floor(clipBeats / beatsPerBar);
        const remainBeats = Math.round((clipBeats % beatsPerBar) * 100) / 100;
        if (remainBeats > 0) return `${bars}.${remainBeats}`;
        return `${bars} bar${bars !== 1 ? 's' : ''}`;
    }, [clipBeats, beatsPerBar]);

    // ── Toolbar select style ──
    const selectStyle: React.CSSProperties = {
        padding: '2px 4px',
        background: 'var(--color-bg-input)',
        color: 'var(--color-text-secondary)',
        border: '1px solid var(--color-control-border)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 'var(--font-size-2xs)',
        cursor: 'pointer',
        outline: 'none',
        fontFamily: 'var(--font-family)',
    };

    return (
        <div
            ref={(el) => {
                editorRootRef.current = el;
            }}
            tabIndex={0}
            data-keyboard-scope="piano-roll"
            data-selected-notes={selectedNotes.size}
            onFocus={() => setIsEditorFocused(true)}
            onBlur={() => setIsEditorFocused(false)}
            onMouseDown={() => editorRootRef.current?.focus()}
            style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                width: '100%',
                background: 'var(--color-bg-base)',
                fontFamily: 'var(--font-family)',
                fontSize: 'var(--font-size-xs)',
            }}
        >
            {/* ── Toolbar ── */}
            {/* Bug #42: Clicking toolbar buttons/selects steals focus from the editor root,
                silencing keyboard shortcuts. Re-focus the root on any mousedown in the toolbar. */}
            <div
                onMouseDown={(e) => {
                    // Don't prevent default so buttons/selects still work,
                    // but schedule a focus restore after the browser processes the click.
                    const target = e.target as HTMLElement;
                    if (target.tagName !== 'SELECT') {
                        e.preventDefault(); // prevents focus shift for buttons
                    }
                    requestAnimationFrame(() => editorRootRef.current?.focus());
                }}
                style={{
                    height: 'var(--daw-transport-height)',
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0 var(--space-2)',
                    gap: 'var(--space-1)',
                    background: 'var(--color-bg-elevated)',
                    borderBottom: '1px solid var(--color-divider)',
                    flexShrink: 0,
                }}>
                {/* Tool buttons */}
                {(['draw', 'paint'] as const).map((t) => {
                    const isActive = tool === t;
                    let Icon;
                    let label;
                    if (t === 'draw') { Icon = Pencil; label = 'Draw'; }
                    else { Icon = Brush; label = 'Paint'; }

                    return (
                        <button
                            key={t}
                            onClick={() => setTool(t)}
                            style={{
                                padding: '3px 8px',
                                background: isActive ? color : 'var(--color-bg-secondary)',
                                color: isActive ? 'var(--color-text-on-accent)' : 'var(--color-text-secondary)',
                                border: isActive ? 'none' : '1px solid var(--color-control-border)',
                                borderRadius: 'var(--radius-sm)',
                                fontSize: 'var(--font-size-2xs)',
                                fontFamily: 'var(--font-family)',
                                fontWeight: isActive ? 600 : 400,
                                cursor: 'pointer',
                                transition: 'all var(--transition-fast)',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                            }}
                            title={`${label} Tool`}
                        >
                            <Icon size={13} fill={isActive ? 'currentColor' : 'none'} fillOpacity={0.2} />
                            <span style={{ marginTop: 1 }}>{label}</span>
                        </button>
                    );
                })}

                {/* Divider */}
                <div style={{ width: 1, height: 16, background: 'var(--color-divider-light)', margin: '0 var(--space-1)' }} />

                {/* MIDI Grid Presets */}
                <span style={{
                    fontSize: 'var(--font-size-micro)',
                    color: 'var(--color-text-tertiary)',
                    textTransform: 'uppercase',
                    letterSpacing: 'var(--letter-spacing-wide)',
                    fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                    marginRight: 2,
                }}>
                    Grid
                </span>
                {MIDI_GRID_PRESETS.map((preset) => (
                    <button
                        key={preset.division}
                        onClick={() => setGridDivision(preset.division)}
                        style={{
                            padding: '2px 8px',
                            background: gridDivision === preset.division ? color : 'var(--color-bg-secondary)',
                            color: gridDivision === preset.division ? 'var(--color-text-on-accent)' : 'var(--color-text-secondary)',
                            border: gridDivision === preset.division ? 'none' : '1px solid var(--color-control-border)',
                            borderRadius: 'var(--radius-sm)',
                            fontSize: 'var(--font-size-2xs)',
                            fontFamily: 'var(--font-mono)',
                            cursor: 'pointer',
                            fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                        }}
                        title={`Set MIDI grid to ${preset.label}`}
                    >
                        {preset.label}
                    </button>
                ))}

                {/* Divider */}
                <div style={{ width: 1, height: 16, background: 'var(--color-divider-light)', margin: '0 var(--space-1)' }} />

                {/* Scale highlight toggle */}
                <button
                    onClick={() => setHighlightScale((v) => !v)}
                    style={{
                        padding: '3px 10px',
                        background: highlightScale ? 'var(--color-accent-primary-dim)' : 'var(--color-bg-secondary)',
                        color: highlightScale ? 'var(--color-accent-primary)' : 'var(--color-text-tertiary)',
                        border: highlightScale
                            ? '1px solid var(--color-accent-primary)'
                            : '1px solid var(--color-control-border)',
                        borderRadius: 'var(--radius-sm)',
                        fontSize: 'var(--font-size-2xs)',
                        fontFamily: 'var(--font-family)',
                        fontWeight: highlightScale ? 600 : 400,
                        cursor: 'pointer',
                        transition: 'all var(--transition-fast)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                    }}
                    title="Highlight notes in the selected scale"
                >
                    <Music size={13} fill={highlightScale ? 'currentColor' : 'none'} fillOpacity={0.2} />
                    <span style={{ marginTop: 1 }}>Scale</span>
                </button>

                {/* Root + Scale selectors (shown when active) */}
                {highlightScale && (
                    <>
                        <select
                            value={rootNote}
                            onChange={(e) => setRootNote(e.target.value as RootNote)}
                            style={selectStyle}
                        >
                            {ROOT_NOTES.map((n) => (
                                <option key={n} value={n}>{n}</option>
                            ))}
                        </select>
                        <select
                            value={scaleName}
                            onChange={(e) => setScaleName(e.target.value as ScaleName)}
                            style={selectStyle}
                        >
                            {SCALE_NAMES.map((s) => (
                                <option key={s} value={s}>{s}</option>
                            ))}
                        </select>
                    </>
                )}

                {/* Divider */}
                <div style={{ width: 1, height: 16, background: 'var(--color-divider-light)', margin: '0 var(--space-1)' }} />

                {/* Clip length badge */}
                <div style={{
                    padding: '2px 8px',
                    background: `${color}1a`,
                    border: `1px solid ${color}40`,
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 'var(--font-size-2xs)',
                    color: color,
                    fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                    fontFamily: 'var(--font-mono)',
                    letterSpacing: '0.3px',
                }}>
                    {clipDurationLabel}
                </div>

                <div style={{ width: 1, height: 16, background: 'var(--color-divider-light)', margin: '0 var(--space-1)' }} />

                <button onClick={duplicateSelection} style={actionBtnStyle} title="Duplicate selected notes (Cmd/Ctrl + D)">
                    Duplicate
                </button>
                <button onClick={() => quantizeAllNotesToGrid()} style={actionBtnStyle} title="Quantize selected notes (Q)">
                    Quantize
                </button>
                <button onClick={selectSamePitch} style={actionBtnStyle} title="Select same pitch (Shift+P)">
                    Same Pitch
                </button>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-xs)' }}>
                    <span>Amt</span>
                    <select
                        value={quantizeAmount}
                        onChange={(e) => setQuantizeAmount(Number(e.target.value))}
                        style={{ ...selectStyle, width: 58, padding: '2px 3px' }}
                        title="Quantize amount"
                    >
                        <option value={100}>100%</option>
                        <option value={75}>75%</option>
                        <option value={50}>50%</option>
                        <option value={25}>25%</option>
                    </select>
                </label>
                <button onClick={applyLegato} style={actionBtnStyle} title="Legato selected notes (L)">
                    Legato
                </button>
                <button onClick={humanizeSelection} style={actionBtnStyle} title="Humanize selected notes (H)">
                    Humanize
                </button>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-xs)' }}>
                    <span>Ratchet</span>
                    <select
                        value={ratchetCount}
                        onChange={(e) => setRatchetCount(Number(e.target.value))}
                        style={{ ...selectStyle, width: 52, padding: '2px 3px' }}
                        title="Ratchet repeats"
                    >
                        <option value={2}>x2</option>
                        <option value={3}>x3</option>
                        <option value={4}>x4</option>
                        <option value={6}>x6</option>
                        <option value={8}>x8</option>
                    </select>
                </label>
                <button onClick={applyRatchet} style={actionBtnStyle} title="Split selected notes by repeats">
                    Ratchet
                </button>
                <button
                    onClick={() => setFoldToUsedNotes((v) => !v)}
                    style={{
                        ...actionBtnStyle,
                        background: foldToUsedNotes ? 'var(--color-accent-primary-dim)' : actionBtnStyle.background,
                        color: foldToUsedNotes ? 'var(--color-accent-primary)' : actionBtnStyle.color,
                        border: foldToUsedNotes ? '1px solid var(--color-accent-primary)' : actionBtnStyle.border,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                    }}
                    title="Fold to used notes"
                >
                    <Filter size={12} />
                    Fold
                </button>
                <button
                    onClick={() => setDrumMode((v) => !v)}
                    style={{
                        ...actionBtnStyle,
                        background: drumMode ? 'var(--color-accent-primary-dim)' : actionBtnStyle.background,
                        color: drumMode ? 'var(--color-accent-primary)' : actionBtnStyle.color,
                        border: drumMode ? '1px solid var(--color-accent-primary)' : actionBtnStyle.border,
                    }}
                    title="Drum mode with named lanes"
                >
                    Drum
                </button>

                <div style={{ width: 1, height: 16, background: 'var(--color-divider-light)', margin: '0 var(--space-1)' }} />
                <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>Step</span>
                <button
                    onClick={() => setStepInputOctave((prev) => Math.max(0, prev - 1))}
                    style={{ ...actionBtnStyle, padding: '2px 6px' }}
                    title="Step octave down ([)"
                >
                    <ChevronDown size={12} />
                </button>
                <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)', minWidth: 30, textAlign: 'center' }}>
                    C{stepInputOctave}
                </span>
                <button
                    onClick={() => setStepInputOctave((prev) => Math.min(9, prev + 1))}
                    style={{ ...actionBtnStyle, padding: '2px 6px' }}
                    title="Step octave up (])"
                >
                    <ChevronUp size={12} />
                </button>
                <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                    @{stepInputCursorBeat.toFixed(2)}
                </span>

                <div style={{ width: 1, height: 16, background: 'var(--color-divider-light)', margin: '0 var(--space-1)' }} />
                <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>Lane</span>
                <select
                    value={activeLane}
                    onChange={(e) => setActiveLane(e.target.value as PianoLaneType)}
                    style={{ ...selectStyle, width: 96, padding: '2px 4px' }}
                    title="Control lane"
                >
                    <option value="velocity">Velocity</option>
                    <option value="modWheel">Mod Wheel (CC1)</option>
                    <option value="expression">Expression (CC11)</option>
                </select>

                <div style={{ flex: 1 }} />

                <button
                    onClick={() => { void onGenerateVariation?.(); }}
                    disabled={!onGenerateVariation || aiVariationBusy}
                    style={{
                        padding: '3px 12px',
                        background: aiVariationBusy ? 'var(--color-bg-secondary)' : 'var(--color-accent-primary)',
                        color: aiVariationBusy ? 'var(--color-text-tertiary)' : 'var(--color-text-on-accent)',
                        border: aiVariationBusy ? '1px solid var(--color-control-border)' : 'none',
                        borderRadius: 'var(--radius-sm)',
                        fontSize: 'var(--font-size-2xs)',
                        fontFamily: 'var(--font-family)',
                        fontWeight: 'var(--font-weight-bold)' as unknown as number,
                        cursor: !onGenerateVariation || aiVariationBusy ? 'not-allowed' : 'pointer',
                        opacity: !onGenerateVariation ? 0.6 : 1,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        boxShadow: aiVariationBusy ? 'none' : '0 2px 8px color-mix(in srgb, var(--color-accent-primary) 30%, transparent)',
                    }}
                    title="Generate AI variation for this MIDI clip"
                >
                    <Sparkles size={13} className={aiVariationBusy ? 'animate-spin' : ''} />
                    <span style={{ marginTop: 1 }}>{aiVariationBusy ? 'Generating…' : 'AI Variation'}</span>
                </button>

                {/* Zoom hint */}
                <span style={{
                    fontSize: 'var(--font-size-micro)',
                    color: 'var(--color-text-tertiary)',
                    opacity: 0.5,
                    fontFamily: 'var(--font-mono)',
                }}>
                    ⌘Scroll H · Alt V
                </span>

                {/* Reset zoom */}
                {(zoomOverrideH || noteHeight !== DEFAULT_NOTE_HEIGHT) && (
                    <button
                        onClick={() => { setZoomOverrideH(null); setNoteHeight(DEFAULT_NOTE_HEIGHT); }}
                        style={{
                            padding: '2px 8px',
                            background: 'var(--color-bg-secondary)',
                            border: '1px solid var(--color-control-border)',
                            borderRadius: 'var(--radius-sm)',
                            fontSize: 'var(--font-size-micro)',
                            fontFamily: 'var(--font-family)',
                            color: 'var(--color-text-secondary)',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            transition: 'all var(--transition-fast)',
                        }}
                        title="Reset zoom to auto-fit"
                    >
                        <RotateCw size={11} />
                        <span style={{ marginTop: 1 }}>Fit</span>
                    </button>
                )}

                <span style={{
                    fontSize: 'var(--font-size-2xs)',
                    color: 'var(--color-text-tertiary)',
                    fontFamily: 'var(--font-mono)',
                }}>
                    {selectedNotes.size > 0 ? `${selectedNotes.size} selected` : `${notes.length} notes`}
                </span>
            </div>

            {/* ── Main area ── */}
            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                <ClipEditorSidebar>
                    <ClipEditorSection title="Clip Setup">
                        <ClipEditorMetaRow label="Length" value={clipDurationLabel} />
                        <ClipEditorMetaRow label="Grid" value={`${gridDivision}${gridTriplet ? 'T' : ''}`} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>Transpose</span>
                            <button
                                onClick={() => transposeNotes(-1)}
                                style={miniBtnStyle}
                            >
                                -1
                            </button>
                            <button
                                onClick={() => transposeNotes(1)}
                                style={miniBtnStyle}
                            >
                                +1
                            </button>
                            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-primary)', fontFamily: 'var(--font-mono)', marginLeft: 'auto' }}>
                                {clipTranspose >= 0 ? `+${clipTranspose}` : clipTranspose}
                            </span>
                        </div>
                    </ClipEditorSection>

                    <ClipEditorSection title="Performance">
                        <button onClick={() => quantizeAllNotesToGrid()} style={{ ...miniBtnStyle, width: '100%', marginBottom: 6 }}>
                            Quantize To Grid
                        </button>
                        <button
                            onClick={() => setZoomOverrideH(null)}
                            style={{ ...miniBtnStyle, width: '100%', marginBottom: 6 }}
                        >
                            Fit To Clip
                        </button>
                        <button
                            onClick={() => {
                                // Audit #4 fix: respect selection — only nudge selected notes.
                                // If nothing selected, do nothing (matches transpose/quantize behavior).
                                if (selectedNotes.size === 0) return;
                                const nudged = notes.map((n) => (
                                    selectedNotes.has(n.id)
                                        ? { ...n, velocity: Math.max(1, Math.min(127, n.velocity + 8)) }
                                        : n
                                ));
                                onNotesChange(nudged);
                            }}
                            style={{ ...miniBtnStyle, width: '100%' }}
                        >
                            Velocity +8
                        </button>
                    </ClipEditorSection>
                </ClipEditorSidebar>

                {/* Piano Keyboard */}
                <div style={{
                    width: KEYBOARD_WIDTH,
                    flexShrink: 0,
                    display: 'flex',
                    flexDirection: 'column',
                }}>
                    {/* Ruler spacer */}
                    <div style={{
                        height: RULER_HEIGHT,
                        background: 'var(--color-bg-tertiary)',
                        borderBottom: '1px solid var(--color-divider)',
                        borderRight: '1px solid var(--color-divider)',
                        flexShrink: 0,
                    }} />

                    {/* Keys */}
                    <div
                        ref={keyboardScrollRef}
                        style={{
                            flex: 1,
                            overflowY: 'hidden',
                            background: 'var(--color-bg-base)',
                            borderRight: '1px solid var(--color-divider)',
                        }}
                    >
                        {/* Total scrollable height must match the grid's scrollable height:
                            grid scrolls RULER_HEIGHT + canvasHeight + VELOCITY_LANE_HEIGHT,
                            but RULER_HEIGHT is a sticky spacer above this div (not scrolled),
                            so we need canvasHeight + VELOCITY_LANE_HEIGHT here. */}
                        <div style={{ height: canvasHeight + VELOCITY_LANE_HEIGHT, position: 'relative' }}>
                            {pianoKeys.map((k) => {
                                // Keyboard key colors from design tokens
                                let bg: string;
                                if (highlightScale && k.inScale) {
                                    // In-scale keys get a subtle accent tint
                                    bg = k.isBlack ? 'var(--color-bg-hover)' : 'var(--color-meter-silent)';
                                } else if (highlightScale && !k.inScale) {
                                    // Out-of-scale keys are dimmed
                                    bg = k.isBlack ? 'var(--color-bg-base)' : 'var(--color-bg-tertiary)';
                                } else {
                                    // Default: use design tokens
                                    bg = k.isBlack ? 'var(--color-piano-black)' : 'var(--color-piano-white)';
                                }

                                return (
                                    <div
                                        key={k.pitch}
                                        onMouseDown={() => auditionNote(k.pitch, 110, 220)}
                                        onMouseUp={() => stopAudition(k.pitch)}
                                        onMouseLeave={() => stopAudition(k.pitch)}
                                        style={{
                                            position: 'absolute',
                                            top: k.y,
                                            left: 0,
                                            width: KEYBOARD_WIDTH,
                                            height: noteHeight,
                                            background: bg,
                                            borderBottom: '1px solid var(--color-border-subtle)',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'flex-end',
                                            paddingRight: 4,
                                            zIndex: k.isBlack ? 2 : 1,
                                            transition: `background var(--transition-fast)`,
                                            cursor: 'pointer',
                                        }}
                                    >
                                        {/* Show label on C notes (octave markers) + every 12th on zoom */}
                                        {(drumMode || k.isC) && noteHeight >= 8 && (
                                            <span style={{
                                                fontSize: Math.min(9, noteHeight - 2),
                                                color: 'var(--color-text-secondary)',
                                                fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                                                fontFamily: 'var(--font-mono)',
                                                letterSpacing: '-0.02em',
                                            }}>
                                                {drumMode ? (k.drumName ?? k.name) : k.name}
                                            </span>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>

                {/* Grid area */}
                <div
                    ref={(el) => {
                        scrollRef.current = el;
                        gridViewportRef.current = el;
                    }}
                    style={{ flex: 1, overflow: 'auto', position: 'relative' }}
                >
                    <div style={{
                        width: canvasWidth,
                        height: RULER_HEIGHT + canvasHeight + VELOCITY_LANE_HEIGHT,
                        position: 'relative',
                    }}>
                        {/* ── Ruler ── */}
                        <div style={{
                            position: 'sticky',
                            top: 0,
                            left: 0,
                            width: canvasWidth,
                            height: RULER_HEIGHT,
                            zIndex: 'var(--z-sticky)' as unknown as number,
                            background: 'var(--color-bg-tertiary)',
                            borderBottom: '1px solid var(--color-divider)',
                            overflow: 'hidden',
                        }}>
                            {/* Clip region bar (Ableton-style colored stripe) */}
                            {/* BUG-11 FIX: Use clipBeats (actual clip duration) not canvasWidth
                                (totalBeats × ppb) which extends beyond the clip when zoomed out. */}
                            <div style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: clipBeats * pixelsPerBeat,
                                height: 3,
                                background: color,
                                opacity: 0.65,
                            }} />

                            {/* Beat labels (1.1, 1.2, 1.3...) */}
                            {rulerBeatLabels.map((label, idx) => (
                                <span
                                    key={`ruler-${idx}`}
                                    style={{
                                        position: 'absolute',
                                        left: label.x + 5,
                                        top: 6,
                                        fontSize: 'var(--font-size-2xs)',
                                        color: label.isBarStart
                                            ? 'var(--color-text-primary)'
                                            : 'var(--color-text-secondary)',
                                        fontWeight: label.isBarStart ? 700 : 500,
                                        fontFamily: 'var(--font-mono)',
                                        pointerEvents: 'none',
                                        userSelect: 'none',
                                    }}
                                >
                                    {label.text}
                                </span>
                            ))}

                            {/* Beat ticks */}
                            {gridLines.map((gl, idx) => (
                                <div
                                    key={`tick-${idx}`}
                                    style={{
                                        position: 'absolute',
                                        left: gl.x,
                                        bottom: 0,
                                        width: 1,
                                        height: gl.isBar ? 10 : 5,
                                        background: gl.isBar
                                            ? 'var(--color-grid-line-major)'
                                            : 'var(--color-grid-line)',
                                    }}
                                />
                            ))}

                            {/* Clip end marker */}
                            {/* BUG-P9 FIX: Use clipBeats * pixelsPerBeat (actual clip end)
                                not canvasWidth (zoom-dependent totalBeats × ppb) which drifts
                                past the real clip boundary when zoomed out. */}
                            <div style={{
                                position: 'absolute',
                                top: 0,
                                left: clipBeats * pixelsPerBeat - 2,
                                width: 2,
                                height: RULER_HEIGHT,
                                background: color,
                                opacity: 0.85,
                            }} />
                        </div>

                        {/* ── Grid (SVG with scale-aware row coloring) ── */}
                        <svg
                            width={canvasWidth}
                            height={canvasHeight}
                            style={{ position: 'absolute', top: RULER_HEIGHT, left: 0, pointerEvents: 'none' }}
                        >
                            {visiblePitches.map((pitch, i) => {
                                const black = isBlackKey(pitch);
                                const inScale = scaleSet ? scaleSet.has(pitch) : true;
                                const isRoot = highlightScale && ((pitch % 12) === ROOT_NOTES.indexOf(rootNote));
                                const isC = pitch % 12 === 0;

                                let fill: string;
                                if (highlightScale) {
                                    if (isRoot) {
                                        // Root note — strongest accent tint
                                        fill = `${color}20`;
                                    } else if (inScale) {
                                        // In-scale — subtle accent
                                        fill = black ? `${color}0c` : `${color}0a`;
                                    } else {
                                        // Out-of-scale — deeply dimmed
                                        fill = black ? '#111111' : '#161616';
                                    }
                                } else {
                                    // Default — use piano grid token colors
                                    // Fix: White key rows should be lighter than black key rows
                                    fill = black ? 'var(--color-piano-black-row)' : 'var(--color-piano-white-row)';
                                }

                                return (
                                    <g key={`row-${i}`}>
                                        <rect
                                            x={0}
                                            y={i * noteHeight}
                                            width={canvasWidth}
                                            height={noteHeight}
                                            fill={fill}
                                        />
                                        {/* Row bottom border */}
                                        <line
                                            x1={0}
                                            y1={(i + 1) * noteHeight}
                                            x2={canvasWidth}
                                            y2={(i + 1) * noteHeight}
                                            stroke={isC
                                                ? 'var(--color-piano-c-line)'
                                                : 'var(--color-border-subtle)'}
                                            strokeWidth={isC ? 1 : 0.5}
                                        />
                                    </g>
                                );
                            })}

                            {/* Vertical beat/bar lines */}
                            {gridLines.map((gl, idx) => (
                                <line
                                    key={`v-${idx}`}
                                    x1={gl.x}
                                    y1={0}
                                    x2={gl.x}
                                    y2={canvasHeight}
                                    stroke={
                                        gl.isBar
                                            ? 'var(--color-piano-bar)'
                                            : gl.isMainBeat
                                                ? 'var(--color-piano-beat)'
                                                : 'var(--color-border-subtle)'
                                    }
                                    strokeWidth={gl.isBar ? 1 : gl.isMainBeat ? 0.65 : 0.45}
                                />
                            ))}
                        </svg>

                        {/* ── Clickable grid ── */}
                        <div
                            onClick={handleGridClick}
                            onDoubleClick={handleGridDoubleClick}
                            onMouseDown={handleGridMouseDown}
                            style={{
                                position: 'absolute',
                                top: RULER_HEIGHT,
                                left: 0,
                                width: canvasWidth,
                                height: canvasHeight,
                                cursor:
                                    tool === 'draw' || tool === 'paint'
                                        ? 'crosshair'
                                        : 'default',
                            }}
                        >
                            <canvas
                                ref={noteCanvasRef}
                                style={{
                                    position: 'absolute',
                                    left: 0,
                                    top: 0,
                                    width: canvasWidth,
                                    height: canvasHeight,
                                    pointerEvents: 'none',
                                }}
                            />
                            {/* Interactive note overlays */}
                            {notes.map((note) => {
                                const x = note.startBeat * pixelsPerBeat;
                                const y = pitchToY(note.pitch);
                                if (y < 0) return null; // Bug #15: pitch not in visible row set
                                const w = note.durationBeats * pixelsPerBeat;
                                const isSelected = selectedNotes.has(note.id);

                                return (
                                    <div
                                        key={note.id}
                                        onClick={(e) => handleNoteClick(e, note.id)}
                                        onMouseDown={(e) => handleNoteDrag(e, note.id)}
                                        onMouseMove={(e) => handleNoteMouseMove(e, note.id)}
                                        onMouseLeave={() => setHoveredNoteEdge(null)}
                                        style={{
                                            position: 'absolute',
                                            left: x,
                                            top: y + 1,
                                            width: Math.max(4, w - 1),
                                            height: noteHeight - 2,
                                            background: 'transparent',
                                            borderRadius: 'var(--radius-xs)',
                                            cursor: tool === 'draw'
                                                ? 'pointer'
                                                : (hoveredNoteEdge === note.id ? 'col-resize' : 'grab'),
                                            zIndex: isSelected ? 5 : 2,
                                            pointerEvents: tool === 'paint' ? 'none' : 'auto',
                                        }}
                                    />
                                );
                            })}
                            {selectionRect && (
                                <div
                                    style={{
                                        position: 'absolute',
                                        left: Math.min(selectionRect.x1, selectionRect.x2),
                                        top: Math.min(selectionRect.y1, selectionRect.y2),
                                        width: Math.abs(selectionRect.x2 - selectionRect.x1),
                                        height: Math.abs(selectionRect.y2 - selectionRect.y1),
                                        background: 'var(--color-accent-primary-dim)',
                                        border: '1px solid color-mix(in srgb, var(--color-accent-primary) 85%, transparent)',
                                        borderRadius: 'var(--radius-xs)',
                                        pointerEvents: 'none',
                                        zIndex: 'var(--z-local-raised)' as unknown as number,
                                    }}
                                />
                            )}
                            {notes.length === 0 && (
                                <div style={{
                                    position: 'absolute',
                                    left: '50%',
                                    top: '50%',
                                    transform: 'translate(-50%, -50%)',
                                    pointerEvents: 'none',
                                    zIndex: 'var(--z-local-raised)' as unknown as number,
                                    textAlign: 'center',
                                    padding: '10px 14px',
                                    borderRadius: 'var(--radius-xl)',
                                    border: '1px solid color-mix(in srgb, var(--color-accent-primary) 35%, var(--color-divider))',
                                    background: 'color-mix(in srgb, var(--color-bg-header) 85%, #0b1525)',
                                    boxShadow: 'var(--shadow-lg)',
                                }}>
                                    <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-primary)', fontWeight: 'var(--font-weight-bold)' as unknown as number, marginBottom: 2 }}>
                                        Draw notes to start
                                    </div>
                                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                                        Draw tool click adds notes. `Q` quantize, `H` humanize, `L` legato.
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* ── Playhead ── */}
                        {/* Bug #38: Clamp playhead display to clip length so it doesn't
                            render past the visible clip boundary when looping. */}
                        {playheadBeat !== undefined && playheadBeat >= 0 && playheadBeat < clipBeats && (
                            <div style={{
                                position: 'absolute',
                                left: Math.min(playheadBeat, clipBeats) * pixelsPerBeat,
                                top: RULER_HEIGHT,
                                width: 2,
                                height: canvasHeight,
                                background: 'rgba(255, 255, 255, 0.95)',
                                zIndex: 'var(--z-header)' as unknown as number,
                                pointerEvents: 'none',
                                boxShadow: '0 0 6px rgba(255,255,255,0.45)',
                            }} />
                        )}

                        {stepInputCursorBeat > 0 && (
                            <div style={{
                                position: 'absolute',
                                left: stepInputCursorBeat * pixelsPerBeat,
                                top: RULER_HEIGHT,
                                width: 1,
                                height: canvasHeight,
                                background: 'color-mix(in srgb, var(--color-accent-primary) 90%, transparent)',
                                zIndex: 'var(--z-ui-overlay)' as unknown as number,
                                pointerEvents: 'none',
                            }} />
                        )}

                        {/* ── Velocity Lane ── */}
                        <div style={{
                            position: 'absolute',
                            top: RULER_HEIGHT + canvasHeight,
                            left: 0,
                            width: canvasWidth,
                            height: VELOCITY_LANE_HEIGHT,
                            background: 'var(--color-bg-base)',
                            borderTop: '1px solid var(--color-divider)',
                        }}>
                            {/* Velocity guide lines (25%, 50%, 75%) */}
                            {[0.25, 0.5, 0.75].map((pct) => (
                                <div
                                    key={`vg-${pct}`}
                                    style={{
                                        position: 'absolute',
                                        left: 0,
                                        bottom: pct * (VELOCITY_LANE_HEIGHT - 4),
                                        width: canvasWidth,
                                        height: 1,
                                        background: 'var(--color-border-subtle)',
                                        pointerEvents: 'none',
                                    }}
                                />
                            ))}

                            {notes.map((note) => {
                                const x = note.startBeat * pixelsPerBeat;
                                const w = Math.max(3, note.durationBeats * pixelsPerBeat * 0.4);
                                const laneValue = readLaneValue(note, activeLane);
                                const barHeight = (laneValue / 127) * (VELOCITY_LANE_HEIGHT - 4);
                                const isSelected = selectedNotes.has(note.id);
                                const laneColor =
                                    activeLane === 'velocity'
                                        ? color
                                        : activeLane === 'modWheel'
                                            ? '#b48cff'
                                            : '#7fd7ff';

                                return (
                                    <div
                                        key={`vel-${note.id}`}
                                        onMouseDown={(e) => handleVelocityMouseDown(note.id, e)}
                                        style={{
                                            position: 'absolute',
                                            left: x,
                                            bottom: 0,
                                            width: w,
                                            height: barHeight,
                                            background: isSelected ? 'var(--color-text-bright)' : laneColor,
                                            opacity: isSelected ? 0.9 : 0.6,
                                            borderRadius: '1px 1px 0 0',
                                            cursor: 'ns-resize',
                                            transition: `opacity var(--transition-micro)`,
                                        }}
                                    />
                                );
                            })}

                            <span style={{
                                position: 'absolute',
                                top: 4,
                                left: 4,
                                fontSize: 'var(--font-size-micro)',
                                color: 'var(--color-text-tertiary)',
                                fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                                textTransform: 'uppercase',
                                letterSpacing: 'var(--letter-spacing-wide)',
                                fontFamily: 'var(--font-family)',
                            }}>
                                {activeLane === 'velocity' ? 'Velocity' : activeLane === 'modWheel' ? 'CC1 Mod Wheel' : 'CC11 Expression'}
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
});

const miniBtnStyle: React.CSSProperties = {
    border: '1px solid var(--color-control-border)',
    borderRadius: 'var(--radius-xs)',
    background: 'var(--color-bg-input)',
    color: 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-family)',
    padding: '4px 6px',
    cursor: 'pointer',
};

const actionBtnStyle: React.CSSProperties = {
    border: '1px solid var(--color-control-border)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--color-bg-secondary)',
    color: 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-2xs)',
    fontFamily: 'var(--font-family)',
    fontWeight: 'var(--font-weight-semibold)' as unknown as number,
    padding: '3px 8px',
    cursor: 'pointer',
};

export default PianoRoll;
