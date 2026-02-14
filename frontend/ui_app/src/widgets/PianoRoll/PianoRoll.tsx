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
//   - Tools: Draw, Select, Erase
//
// Design: Uses CSS custom properties from tokens.css exclusively.
//         Piano Roll tokens: --color-piano-* for grid, keyboard, lines.
//         Layout tokens: --color-bg-*, --color-text-*, --color-divider, etc.
//
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useCallback, useRef, useMemo, useEffect, memo } from 'react';
import { useGridStore } from '@/shared/stores/useGridStore';

// ── Types ────────────────────────────────────────────────────────────────

export interface MidiNote {
    id: string;
    pitch: number;
    startBeat: number;
    durationBeats: number;
    velocity: number;
    selected?: boolean;
}

export type PianoRollTool = 'draw' | 'select' | 'erase';

interface PianoRollProps {
    notes: MidiNote[];
    onNotesChange: (notes: MidiNote[]) => void;
    color?: string;
    timeSignature?: [number, number];
    totalBars?: number;
    playheadBeat?: number;
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
const HIGHEST_PITCH = 115;
const TOTAL_KEYS = HIGHEST_PITCH - LOWEST_PITCH + 1;
const MIN_PPB = 4;
const MAX_PPB = 200;

const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// UI octave labeling offset:
// MIDI 60 is shown as C3 (DAW-style), not C4 (scientific pitch notation).
const OCTAVE_LABEL_OFFSET = -2;
const DEFAULT_FOCUS_PITCH = 60; // C3 in this UI labeling

const isBlackKey = (pitch: number) => {
    const note = pitch % 12;
    return [1, 3, 6, 8, 10].includes(note);
};

let nextNoteId = 1;
const genNoteId = () => `note_${nextNoteId++}`;

// ── Component ────────────────────────────────────────────────────────────

export const PianoRoll = memo(function PianoRoll({
    notes,
    onNotesChange,
    color = '#4a9eff',
    timeSignature = [4, 4],
    totalBars = 8,
    playheadBeat,
    clipLengthBeats,
}: PianoRollProps) {
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

    const scrollRef = useRef<HTMLDivElement>(null);
    const noteCanvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const keyboardScrollRef = useRef<HTMLDivElement>(null);
    const editorRootRef = useRef<HTMLDivElement>(null);
    const snapBeat = useGridStore((s) => s.snapBeat);
    const gridInterval = useGridStore((s) => s.gridInterval);

    const beatsPerBar = timeSignature[0];
    const clipBeats = Math.max(0.25, clipLengthBeats ?? (totalBars * beatsPerBar));

    // Auto-fit horizontal
    const gridAreaWidth = Math.max(100, containerWidth - KEYBOARD_WIDTH);
    const autoFitPPB = gridAreaWidth / clipBeats;
    const pixelsPerBeat = zoomOverrideH ?? Math.max(MIN_PPB, Math.min(MAX_PPB, autoFitPPB));
    const totalBeats = clipBeats;

    const canvasWidth = totalBeats * pixelsPerBeat;
    const canvasHeight = TOTAL_KEYS * noteHeight;

    // Measure container
    useEffect(() => {
        const el = containerRef.current;
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

    // Sync keyboard scroll with grid
    useEffect(() => {
        const gridEl = scrollRef.current;
        const kbEl = keyboardScrollRef.current;
        if (!gridEl || !kbEl) return;
        const onScroll = () => { kbEl.scrollTop = gridEl.scrollTop; };
        gridEl.addEventListener('scroll', onScroll);
        return () => gridEl.removeEventListener('scroll', onScroll);
    }, []);

    // Bidirectional zoom: Ctrl/⌘ = H, Alt = V
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            if (e.altKey) {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -1 : 1;
                setNoteHeight((prev) => Math.max(MIN_NOTE_HEIGHT, Math.min(MAX_NOTE_HEIGHT, prev + delta)));
            } else if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -2 : 2;
                setZoomOverrideH((prev) => {
                    const current = prev ?? pixelsPerBeat;
                    return Math.max(MIN_PPB, Math.min(MAX_PPB, current + delta));
                });
            }
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [pixelsPerBeat]);

    // Pitch ↔ Y
    const pitchToY = useCallback(
        (pitch: number) => (LOWEST_PITCH + TOTAL_KEYS - 1 - pitch) * noteHeight,
        [noteHeight],
    );
    const yToPitch = useCallback(
        (y: number) => LOWEST_PITCH + TOTAL_KEYS - 1 - Math.floor(y / noteHeight),
        [noteHeight],
    );

    // On open, center vertical focus around C3 so drawing starts in the musical working range.
    useEffect(() => {
        const gridEl = scrollRef.current;
        const kbEl = keyboardScrollRef.current;
        if (!gridEl) return;
        requestAnimationFrame(() => {
            const targetY = pitchToY(DEFAULT_FOCUS_PITCH);
            const centered = Math.max(0, targetY - gridEl.clientHeight * 0.5 + noteHeight * 0.5);
            gridEl.scrollTop = centered;
            if (kbEl) kbEl.scrollTop = centered;
        });
    }, [clipLengthBeats, noteHeight, pitchToY]);

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
        const lines: { x: number; isBar: boolean; label?: string }[] = [];
        for (let beat = 0; beat <= totalBeats; beat++) {
            const isBar = beat % beatsPerBar === 0;
            lines.push({
                x: beat * pixelsPerBeat,
                isBar,
                label: isBar ? `${Math.floor(beat / beatsPerBar) + 1}` : undefined,
            });
        }
        return lines;
    }, [totalBeats, beatsPerBar, pixelsPerBeat]);

    // Piano key data
    const pianoKeys = useMemo(() => {
        const keys: { pitch: number; name: string; isBlack: boolean; y: number; inScale: boolean; isC: boolean }[] = [];
        for (let i = TOTAL_KEYS - 1; i >= 0; i--) {
            const pitch = LOWEST_PITCH + i;
            const note = pitch % 12;
            const octave = Math.floor(pitch / 12) + OCTAVE_LABEL_OFFSET;
            keys.push({
                pitch,
                name: `${KEY_NAMES[note]}${octave}`,
                isBlack: isBlackKey(pitch),
                y: pitchToY(pitch),
                inScale: scaleSet ? scaleSet.has(pitch) : true,
                isC: note === 0,
            });
        }
        return keys;
    }, [pitchToY, scaleSet]);

    // ── Note Actions ──
    const handleGridClick = useCallback(
        (e: React.MouseEvent) => {
            editorRootRef.current?.focus();
            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const pitch = yToPitch(y);
            const rawBeat = x / pixelsPerBeat;
            const beat = snapBeat(rawBeat, beatsPerBar);
            if (beat >= totalBeats) return;

            if (tool === 'draw') {
                const duration = Math.max(0.125, Math.min(1, totalBeats - beat));
                const newNote: MidiNote = {
                    id: genNoteId(),
                    pitch,
                    startBeat: beat,
                    durationBeats: duration,
                    velocity: 100,
                };
                onNotesChange([...notes, newNote]);
            }
        },
        [tool, yToPitch, pixelsPerBeat, snapBeat, beatsPerBar, notes, onNotesChange, totalBeats],
    );

    const handleNoteClick = useCallback(
        (e: React.MouseEvent, noteId: string) => {
            e.stopPropagation();
            editorRootRef.current?.focus();
            if (tool === 'erase') {
                onNotesChange(notes.filter((n) => n.id !== noteId));
                return;
            }
            if (tool === 'select') {
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
            }
        },
        [tool, notes, onNotesChange],
    );

    const handleGridSelectionStart = useCallback((e: React.MouseEvent) => {
        if (tool !== 'select') return;
        editorRootRef.current?.focus();
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const startX = e.clientX - rect.left;
        const startY = e.clientY - rect.top;
        setSelectionRect({ x1: startX, y1: startY, x2: startX, y2: startY });

        const keepExisting = e.shiftKey;
        if (!keepExisting) setSelectedNotes(new Set());

        const onMove = (ev: MouseEvent) => {
            const x = Math.max(0, Math.min(canvasWidth, ev.clientX - rect.left));
            const y = Math.max(0, Math.min(canvasHeight, ev.clientY - rect.top));
            setSelectionRect({ x1: startX, y1: startY, x2: x, y2: y });
        };

        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            setSelectionRect((current) => {
                if (!current) return null;
                const minX = Math.min(current.x1, current.x2);
                const maxX = Math.max(current.x1, current.x2);
                const minY = Math.min(current.y1, current.y2);
                const maxY = Math.max(current.y1, current.y2);
                const isClick = Math.abs(maxX - minX) < 3 && Math.abs(maxY - minY) < 3;
                if (isClick) return null;

                const hits = new Set<string>();
                for (const note of notes) {
                    const nx = note.startBeat * pixelsPerBeat;
                    const ny = pitchToY(note.pitch) + 1;
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

    // Note drag
    const handleNoteDrag = useCallback(
        (e: React.MouseEvent, noteId: string) => {
            if (tool !== 'select' && tool !== 'draw') return;
            e.stopPropagation();
            e.preventDefault();
            editorRootRef.current?.focus();

            const startX = e.clientX;
            const startY = e.clientY;
            const note = notes.find((n) => n.id === noteId);
            if (!note) return;

            const target = e.currentTarget as HTMLElement;
            const edgeGripPx = 6;
            const mode = e.nativeEvent.offsetX >= target.clientWidth - edgeGripPx
                ? 'resize-right'
                : e.nativeEvent.offsetX <= edgeGripPx
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

            const onMove = (ev: MouseEvent) => {
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                const beatDelta = dx / pixelsPerBeat;
                const pitchDelta = -Math.round(dy / noteHeight);

                const updated = notes.map((n) => {
                    if (!selectedIds.has(n.id)) return n;
                    const original = startStates.get(n.id);
                    if (!original) return n;
                    if (mode === 'resize-right') {
                        // Resize only the grabbed note to avoid destructive multi-resize.
                        if (n.id !== noteId) return n;
                        const maxDur = Math.max(0.125, totalBeats - original.startBeat);
                        return {
                            ...n,
                            durationBeats: Math.min(maxDur, Math.max(0.125, snapBeat(original.durationBeats + beatDelta, beatsPerBar))),
                        };
                    }
                    if (mode === 'resize-left') {
                        if (n.id !== noteId) return n;
                        const snappedBeat = Math.max(0, Math.min(totalBeats - 0.125, snapBeat(original.startBeat + beatDelta, beatsPerBar)));
                        return {
                            ...n,
                            startBeat: snappedBeat,
                            durationBeats: Math.max(0.125, original.durationBeats + (original.startBeat - snappedBeat)),
                        };
                    }
                    const newBeat = Math.max(0, Math.min(totalBeats - 0.125, snapBeat(original.startBeat + beatDelta, beatsPerBar)));
                    const newPitch = Math.max(LOWEST_PITCH, Math.min(LOWEST_PITCH + TOTAL_KEYS - 1, original.pitch + pitchDelta));
                    return { ...n, startBeat: newBeat, pitch: newPitch };
                });
                onNotesChange(updated);
            };

            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        },
        [tool, notes, onNotesChange, pixelsPerBeat, noteHeight, snapBeat, beatsPerBar, totalBeats, selectedNotes],
    );

    // Velocity change
    const handleVelocityClick = useCallback(
        (noteId: string, e: React.MouseEvent) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            const y = e.clientY - rect.top;
            const newVelocity = Math.round(Math.max(1, Math.min(127, (1 - y / VELOCITY_LANE_HEIGHT) * 127)));
            onNotesChange(notes.map((n) => (n.id === noteId ? { ...n, velocity: newVelocity } : n)));
        },
        [notes, onNotesChange],
    );

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

        for (const note of notes) {
            const x = note.startBeat * pixelsPerBeat;
            const y = pitchToY(note.pitch) + 1;
            const w = Math.max(4, note.durationBeats * pixelsPerBeat - 1);
            const h = noteHeight - 2;

            // Note body — rounded rect with subtle gradient feel
            const alpha = Math.max(0.4, note.velocity / 127);
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
    }, [notes, selectedNotes, canvasWidth, canvasHeight, pixelsPerBeat, noteHeight, color, pitchToY]);

    // MIDI-editor-local keyboard editing (active only when this editor has focus).
    useEffect(() => {
        if (!isEditorFocused) return;
        const onKeyDown = (e: KeyboardEvent) => {
            const hasSelected = selectedNotes.size > 0;
            const stepBeatRaw = gridInterval(beatsPerBar);
            const stepBeat = stepBeatRaw > 0 ? stepBeatRaw : 0.25;

            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (!hasSelected) return;
                e.preventDefault();
                e.stopPropagation();
                onNotesChange(notes.filter((n) => !selectedNotes.has(n.id)));
                setSelectedNotes(new Set());
                return;
            }

            if (!hasSelected) return;
            if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;

            e.preventDefault();
            e.stopPropagation();

            const pitchStep = e.shiftKey ? 12 : 1;
            const beatStep = stepBeat;
            const moved = notes.map((n) => {
                if (!selectedNotes.has(n.id)) return n;
                if (e.key === 'ArrowUp') {
                    return { ...n, pitch: Math.min(HIGHEST_PITCH, n.pitch + pitchStep) };
                }
                if (e.key === 'ArrowDown') {
                    return { ...n, pitch: Math.max(LOWEST_PITCH, n.pitch - pitchStep) };
                }
                if (e.key === 'ArrowLeft') {
                    return { ...n, startBeat: Math.max(0, n.startBeat - beatStep) };
                }
                return { ...n, startBeat: Math.min(totalBeats - 0.125, n.startBeat + beatStep) };
            });
            onNotesChange(moved);
        };
        window.addEventListener('keydown', onKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
    }, [isEditorFocused, selectedNotes, notes, onNotesChange, gridInterval, beatsPerBar, totalBeats]);

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
                containerRef.current = el;
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
            <div style={{
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
                {(['draw', 'select', 'erase'] as const).map((t) => (
                    <button
                        key={t}
                        onClick={() => setTool(t)}
                        style={{
                            padding: '3px 10px',
                            background: tool === t ? color : 'var(--color-bg-secondary)',
                            color: tool === t ? 'var(--color-text-on-accent)' : 'var(--color-text-secondary)',
                            border: tool === t ? 'none' : '1px solid var(--color-control-border)',
                            borderRadius: 'var(--radius-sm)',
                            fontSize: 'var(--font-size-2xs)',
                            fontFamily: 'var(--font-family)',
                            fontWeight: tool === t ? 600 : 400,
                            cursor: 'pointer',
                            transition: 'all var(--transition-fast)',
                            letterSpacing: 'var(--letter-spacing-wide)',
                        }}
                    >
                        {t === 'draw' ? '✏ Draw' : t === 'select' ? '◻ Select' : '✕ Erase'}
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
                    }}
                    title="Highlight notes in the selected scale"
                >
                    ♪ Scale
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
                    fontWeight: 600,
                    fontFamily: 'var(--font-mono)',
                    letterSpacing: '0.3px',
                }}>
                    {clipDurationLabel}
                </div>

                <div style={{ flex: 1 }} />

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
                            transition: 'all var(--transition-fast)',
                        }}
                        title="Reset zoom to auto-fit"
                    >
                        ↻ Fit
                    </button>
                )}

                <span style={{
                    fontSize: 'var(--font-size-2xs)',
                    color: 'var(--color-text-tertiary)',
                    fontFamily: 'var(--font-mono)',
                }}>
                    {notes.length} notes
                </span>
            </div>

            {/* ── Main area ── */}
            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
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
                        <div style={{ height: canvasHeight, position: 'relative' }}>
                            {pianoKeys.map((k) => {
                                // Keyboard key colors from design tokens
                                let bg: string;
                                if (highlightScale && k.inScale) {
                                    // In-scale keys get a subtle accent tint
                                    bg = k.isBlack ? '#3a3a50' : '#4a4a5a';
                                } else if (highlightScale && !k.inScale) {
                                    // Out-of-scale keys are dimmed
                                    bg = k.isBlack ? '#1a1a1a' : '#2a2a2a';
                                } else {
                                    // Default: use design tokens
                                    bg = k.isBlack ? 'var(--color-piano-black)' : 'var(--color-piano-white)';
                                }

                                return (
                                    <div
                                        key={k.pitch}
                                        style={{
                                            position: 'absolute',
                                            top: k.y,
                                            left: 0,
                                            width: k.isBlack ? KEYBOARD_WIDTH * 0.65 : KEYBOARD_WIDTH,
                                            height: noteHeight,
                                            background: bg,
                                            borderBottom: '1px solid var(--color-border-subtle)',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'flex-end',
                                            paddingRight: 4,
                                            zIndex: k.isBlack ? 2 : 1,
                                            transition: 'background 0.15s ease',
                                        }}
                                    >
                                        {/* Show label on C notes (octave markers) + every 12th on zoom */}
                                        {k.isC && noteHeight >= 8 && (
                                            <span style={{
                                                fontSize: Math.min(9, noteHeight - 2),
                                                color: 'var(--color-text-secondary)',
                                                fontWeight: 600,
                                                fontFamily: 'var(--font-mono)',
                                                letterSpacing: '-0.02em',
                                            }}>
                                                {k.name}
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
                    ref={scrollRef}
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
                            zIndex: 30,
                            background: 'var(--color-bg-tertiary)',
                            borderBottom: '1px solid var(--color-divider)',
                            overflow: 'hidden',
                        }}>
                            {/* Clip region bar (Ableton-style colored stripe) */}
                            <div style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: canvasWidth,
                                height: 3,
                                background: color,
                                opacity: 0.65,
                            }} />

                            {/* Bar labels */}
                            {gridLines.filter(gl => gl.label).map((gl, idx) => (
                                <span
                                    key={`ruler-${idx}`}
                                    style={{
                                        position: 'absolute',
                                        left: gl.x + 5,
                                        top: 6,
                                        fontSize: 'var(--font-size-2xs)',
                                        color: 'var(--color-text-secondary)',
                                        fontWeight: 500,
                                        fontFamily: 'var(--font-mono)',
                                        pointerEvents: 'none',
                                        userSelect: 'none',
                                    }}
                                >
                                    {gl.label}
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
                            <div style={{
                                position: 'absolute',
                                top: 0,
                                left: canvasWidth - 2,
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
                            {Array.from({ length: TOTAL_KEYS }, (_, i) => {
                                const pitch = LOWEST_PITCH + TOTAL_KEYS - 1 - i;
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
                                    fill = black ? 'var(--color-piano-black)' : 'var(--color-piano-grid)';
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
                                    stroke={gl.isBar ? 'var(--color-piano-bar)' : 'var(--color-piano-beat)'}
                                    strokeWidth={gl.isBar ? 1 : 0.5}
                                />
                            ))}
                        </svg>

                        {/* ── Clickable grid ── */}
                        <div
                            onClick={handleGridClick}
                            onMouseDown={handleGridSelectionStart}
                            style={{
                                position: 'absolute',
                                top: RULER_HEIGHT,
                                left: 0,
                                width: canvasWidth,
                                height: canvasHeight,
                                cursor: tool === 'draw' ? 'crosshair' : tool === 'erase' ? 'not-allowed' : 'default',
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
                                const w = note.durationBeats * pixelsPerBeat;
                                const isSelected = selectedNotes.has(note.id);

                                return (
                                    <div
                                        key={note.id}
                                        onClick={(e) => handleNoteClick(e, note.id)}
                                        onMouseDown={(e) => handleNoteDrag(e, note.id)}
                                        style={{
                                            position: 'absolute',
                                            left: x,
                                            top: y + 1,
                                            width: Math.max(4, w - 1),
                                            height: noteHeight - 2,
                                            background: 'transparent',
                                            borderRadius: 'var(--radius-xs)',
                                            cursor: tool === 'erase' ? 'not-allowed' : 'grab',
                                            zIndex: isSelected ? 5 : 2,
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
                                        background: 'rgba(74, 158, 255, 0.15)',
                                        border: '1px solid rgba(74, 158, 255, 0.85)',
                                        borderRadius: 2,
                                        pointerEvents: 'none',
                                        zIndex: 9,
                                    }}
                                />
                            )}
                        </div>

                        {/* ── Playhead ── */}
                        {playheadBeat !== undefined && (
                            <div style={{
                                position: 'absolute',
                                left: playheadBeat * pixelsPerBeat,
                                top: RULER_HEIGHT,
                                width: 'var(--daw-playhead-width)',
                                height: canvasHeight,
                                background: 'var(--color-playhead)',
                                zIndex: 20,
                                pointerEvents: 'none',
                                boxShadow: '0 0 4px var(--color-accent-primary-glow)',
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
                                const barHeight = (note.velocity / 127) * (VELOCITY_LANE_HEIGHT - 4);
                                const isSelected = selectedNotes.has(note.id);

                                return (
                                    <div
                                        key={`vel-${note.id}`}
                                        onClick={(e) => handleVelocityClick(note.id, e)}
                                        style={{
                                            position: 'absolute',
                                            left: x,
                                            bottom: 0,
                                            width: w,
                                            height: barHeight,
                                            background: isSelected ? 'var(--color-text-bright)' : color,
                                            opacity: isSelected ? 0.9 : 0.6,
                                            borderRadius: '1px 1px 0 0',
                                            cursor: 'ns-resize',
                                            transition: 'opacity 0.1s ease',
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
                                fontWeight: 600,
                                textTransform: 'uppercase',
                                letterSpacing: 'var(--letter-spacing-wide)',
                                fontFamily: 'var(--font-family)',
                            }}>
                                Velocity
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
});

export default PianoRoll;
