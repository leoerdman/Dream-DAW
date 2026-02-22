// ═══════════════════════════════════════════════════════════════════════
// usePianoRollLogic — extracted state/effects/callbacks from PianoRoll
// ═══════════════════════════════════════════════════════════════════════

import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { useGridStore } from '@/shared/stores/useGridStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { divisionToInterval } from '@/shared/lib/gridSnap';
import * as engineApi from '@/shared/api/engine';
import {
    DEFAULT_FOCUS_PITCH,
    DEFAULT_NOTE_HEIGHT,
    DRUM_LANES,
    EPS,
    HIGHEST_PITCH,
    isBlackKey,
    isInScale,
    KEY_NAMES,
    MAX_NOTE_HEIGHT,
    MAX_PPB,
    MIN_NOTE_BEATS,
    MIN_NOTE_HEIGHT,
    MIN_PPB,
    OCTAVE_LABEL_OFFSET,
    TOTAL_KEYS,
    VELOCITY_LANE_HEIGHT,
    LOWEST_PITCH,
    genNoteId,
    type MidiNote,
    type PianoLaneType,
    type PianoRollTool,
    type RootNote,
    type ScaleName,
} from '@/widgets/PianoRoll/model/pianoRollConfig';
import { usePianoRollCanvasEngine } from './usePianoRollCanvasEngine';
import { usePianoRollHotkeys } from './usePianoRollHotkeys';
import { usePianoRollTransforms } from './usePianoRollTransforms';

export interface PianoRollProps {
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

// Audit #8: Shared platform detection
const isMac: boolean = (() => {
    const uad = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
    if (uad?.platform) return uad.platform === 'macOS';
    return /mac/i.test(navigator.userAgent) && !/iphone|ipad/i.test(navigator.userAgent);
})();

const _scrollTopByTrack = new Map<number, number>();

export function usePianoRollLogic(props: PianoRollProps) {
    const {
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
    } = props;

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
            const notesAtStart = notesRef.current;
            const note = notesAtStart.find((n) => n.id === noteId);
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
                notesAtStart
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

    const {
        applyRatchet,
        transposeNotes,
        quantizeAllNotesToGrid,
        duplicateSelection,
        selectSamePitch,
        humanizeSelection,
        applyLegato,
    } = usePianoRollTransforms({
        notes,
        selectedNotes,
        ratchetCount,
        currentGridInterval,
        quantizeAmount,
        clipBeats,
        beatsPerBar,
        pixelsPerBeat,
        snapBeat,
        onNotesChange,
        enforceNoOverlap,
        setSelectedNotes,
        setClipTranspose,
        auditionNote,
    });

    // Canvas note renderer (Extracted to micro-hook)
    const { noteCanvasRef } = usePianoRollCanvasEngine({
        notes,
        ghostNotes,
        selectedNotes,
        canvasWidth,
        canvasHeight,
        pixelsPerBeat,
        noteHeight,
        color,
        pitchToY
    });

    usePianoRollHotkeys({
        isEditorFocused,
        selectedNotes,
        notes,
        onNotesChange,
        currentGridInterval,
        clipBeats,
        duplicateSelection,
        quantizeAllNotesToGrid,
        quantizeAmount,
        humanizeSelection,
        applyLegato,
        copySelection,
        pasteClipboard,
        selectSamePitch,
        stepInputOctave,
        setStepInputOctave,
        stepInputCursorBeat,
        setStepInputCursorBeat,
        pixelsPerBeat,
        snapBeat,
        beatsPerBar,
        auditionNote,
        enforceNoOverlap,
        setSelectedNotes,
        editorRootRef,
        setClipTranspose,
    });

    // Clip duration label
    const clipDurationLabel = useMemo(() => {
        const bars = Math.floor(clipBeats / beatsPerBar);
        const remainBeats = Math.round((clipBeats % beatsPerBar) * 100) / 100;
        if (remainBeats > 0) return `${bars}.${remainBeats}`;
        return `${bars} bar${bars !== 1 ? 's' : ''}`;
    }, [clipBeats, beatsPerBar]);



    return {
        // Refs
        scrollRef, noteCanvasRef, gridViewportRef, keyboardScrollRef,
        editorRootRef, isDragInProgressRef,
        // State
        tool, setTool, selectedNotes, setSelectedNotes,
        selectionRect, setSelectionRect,
        containerWidth, noteHeight, setNoteHeight,
        isEditorFocused, setIsEditorFocused,
        highlightScale, setHighlightScale,
        rootNote, setRootNote,
        scaleName, setScaleName,
        clipTranspose, setClipTranspose,
        quantizeAmount, setQuantizeAmount,
        foldToUsedNotes, setFoldToUsedNotes,
        stepInputOctave, setStepInputOctave,
        stepInputCursorBeat, setStepInputCursorBeat,
        drumMode, setDrumMode,
        activeLane, setActiveLane,
        ratchetCount, setRatchetCount,
        laneValuesByNote, setLaneValuesByNote,
        hoveredNoteEdge, setHoveredNoteEdge,
        zoomOverrideH, setZoomOverrideH,
        // Computed
        playheadBeat, pixelsPerBeat, totalBeats, clipBeats,
        canvasWidth, canvasHeight,
        visiblePitches, pitchRowIndex, scaleSet,
        gridLines, rulerBeatLabels, pianoKeys,
        currentGridInterval, beatsPerBar,
        clipDurationLabel,
        // Callbacks
        pitchToY, yToPitch,
        handleGridClick, handleGridDoubleClick,
        handleGridMouseDown,
        handleNoteClick, handleNoteDrag, handleNoteMouseMove,
        handleVelocityMouseDown,
        transposeNotes, quantizeAllNotesToGrid,
        duplicateSelection, humanizeSelection,
        applyLegato, applyRatchet, selectSamePitch,
        copySelection, pasteClipboard,
        readLaneValue, auditionNote,
        // Props passthrough
        notes, ghostNotes, color, timeSignature,
        onNotesChange, onGenerateVariation, aiVariationBusy,
        trackIndex, clipStartBeat,
        snapBeat, pianoPencilMode, snapEnabled,
        gridDivision, gridTriplet, setGridDivision,
    };
}
