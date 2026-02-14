// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — PianoRoll (MIDI Note Editor)
// ═══════════════════════════════════════════════════════════════════════════
//
// LEVIATHAN Epic 5: Full piano roll editor for MIDI clips.
//
// Architecture:
//   - Left piano keyboard (88 keys, C1-C8)
//   - Note grid (horizontal beats × vertical pitch)
//   - Note blocks (draggable, resizable)
//   - Velocity lane (bottom, per-note velocity bars)
//   - Snap-to-grid using shared grid store
//   - Tools: Draw, Select, Erase
//
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useCallback, useRef, useMemo, useEffect, memo } from 'react';
import { useGridStore } from '@/shared/stores/useGridStore';

// ── Types ────────────────────────────────────────────────────────────────

export interface MidiNote {
    id: string;
    /** MIDI pitch 0-127. */
    pitch: number;
    /** Start position in beats. */
    startBeat: number;
    /** Duration in beats. */
    durationBeats: number;
    /** Velocity 0-127. */
    velocity: number;
    /** Whether this note is selected. */
    selected?: boolean;
}

export type PianoRollTool = 'draw' | 'select' | 'erase';

interface PianoRollProps {
    /** Array of MIDI notes. */
    notes: MidiNote[];
    /** Called when notes change. */
    onNotesChange: (notes: MidiNote[]) => void;
    /** Clip color for note blocks. */
    color?: string;
    /** BPM (for grid display). */
    bpm?: number;
    /** Time signature. */
    timeSignature?: [number, number];
    /** Total length in bars. */
    totalBars?: number;
    /** Playhead position in beats. */
    playheadBeat?: number;
}

// ── Constants ────────────────────────────────────────────────────────────

const KEYBOARD_WIDTH = 48;
const NOTE_HEIGHT = 12;
const VELOCITY_LANE_HEIGHT = 60;
const TOTAL_KEYS = 88;
const LOWEST_PITCH = 21; // A0
const DEFAULT_PPB = 20;
const MIN_PPB = 8;
const MAX_PPB = 120;

const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

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
    color = '#58a6ff',
    bpm: _bpm = 120,
    timeSignature = [4, 4],
    totalBars = 8,
    playheadBeat,
}: PianoRollProps) {
    const [pixelsPerBeat, setPixelsPerBeat] = useState(DEFAULT_PPB);
    const [tool, setTool] = useState<PianoRollTool>('draw');
    const [selectedNotes, setSelectedNotes] = useState<Set<string>>(new Set());
    const scrollRef = useRef<HTMLDivElement>(null);
    const snapBeat = useGridStore((s) => s.snapBeat);

    const beatsPerBar = timeSignature[0];
    const totalBeats = totalBars * beatsPerBar;
    const canvasWidth = totalBeats * pixelsPerBeat;
    const canvasHeight = TOTAL_KEYS * NOTE_HEIGHT;

    // ── Zoom ────────────────────────────────────────────────────────

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -2 : 2;
                setPixelsPerBeat((prev) => Math.max(MIN_PPB, Math.min(MAX_PPB, prev + delta)));
            }
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, []);

    // ── Pitch ↔ Y conversion ────────────────────────────────────────

    const pitchToY = useCallback(
        (pitch: number) => (LOWEST_PITCH + TOTAL_KEYS - 1 - pitch) * NOTE_HEIGHT,
        [],
    );

    const yToPitch = useCallback(
        (y: number) => LOWEST_PITCH + TOTAL_KEYS - 1 - Math.floor(y / NOTE_HEIGHT),
        [],
    );

    // ── Grid lines ──────────────────────────────────────────────────

    const gridLines = useMemo(() => {
        const lines: { x: number; isBar: boolean; isBeat: boolean }[] = [];
        for (let beat = 0; beat <= totalBeats; beat++) {
            lines.push({
                x: beat * pixelsPerBeat,
                isBar: beat % beatsPerBar === 0,
                isBeat: true,
            });
        }
        return lines;
    }, [totalBeats, beatsPerBar, pixelsPerBeat]);

    // ── Piano key data ──────────────────────────────────────────────

    const pianoKeys = useMemo(() => {
        const keys: { pitch: number; name: string; isBlack: boolean; y: number }[] = [];
        for (let i = TOTAL_KEYS - 1; i >= 0; i--) {
            const pitch = LOWEST_PITCH + i;
            const note = pitch % 12;
            const octave = Math.floor(pitch / 12) - 1;
            keys.push({
                pitch,
                name: `${KEY_NAMES[note]}${octave}`,
                isBlack: isBlackKey(pitch),
                y: pitchToY(pitch),
            });
        }
        return keys;
    }, [pitchToY]);

    // ── Note Actions ────────────────────────────────────────────────

    const handleGridClick = useCallback(
        (e: React.MouseEvent) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const pitch = yToPitch(y);
            const rawBeat = x / pixelsPerBeat;
            const beat = snapBeat(rawBeat, beatsPerBar);

            if (tool === 'draw') {
                const newNote: MidiNote = {
                    id: genNoteId(),
                    pitch,
                    startBeat: beat,
                    durationBeats: 1,
                    velocity: 100,
                };
                onNotesChange([...notes, newNote]);
            } else if (tool === 'select') {
                setSelectedNotes(new Set());
            }
        },
        [tool, yToPitch, pixelsPerBeat, snapBeat, beatsPerBar, notes, onNotesChange],
    );

    const handleNoteClick = useCallback(
        (e: React.MouseEvent, noteId: string) => {
            e.stopPropagation();

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

    // ── Note dragging ────────────────────────────────────────────────

    const handleNoteDrag = useCallback(
        (e: React.MouseEvent, noteId: string) => {
            if (tool !== 'select' && tool !== 'draw') return;
            e.stopPropagation();
            e.preventDefault();

            const startX = e.clientX;
            const startY = e.clientY;
            const note = notes.find((n) => n.id === noteId);
            if (!note) return;

            const startBeat = note.startBeat;
            const startPitch = note.pitch;

            const onMove = (ev: MouseEvent) => {
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                const beatDelta = dx / pixelsPerBeat;
                const pitchDelta = -Math.round(dy / NOTE_HEIGHT);

                const newBeat = Math.max(0, snapBeat(startBeat + beatDelta, beatsPerBar));
                const newPitch = Math.max(LOWEST_PITCH, Math.min(LOWEST_PITCH + TOTAL_KEYS - 1, startPitch + pitchDelta));

                const updated = notes.map((n) =>
                    n.id === noteId ? { ...n, startBeat: newBeat, pitch: newPitch } : n,
                );
                onNotesChange(updated);
            };

            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
            };

            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        },
        [tool, notes, onNotesChange, pixelsPerBeat, snapBeat, beatsPerBar],
    );

    // ── Velocity change (on velocity lane click) ─────────────────────

    const handleVelocityClick = useCallback(
        (noteId: string, e: React.MouseEvent) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            const y = e.clientY - rect.top;
            const newVelocity = Math.round(Math.max(1, Math.min(127, (1 - y / VELOCITY_LANE_HEIGHT) * 127)));
            const updated = notes.map((n) => (n.id === noteId ? { ...n, velocity: newVelocity } : n));
            onNotesChange(updated);
        },
        [notes, onNotesChange],
    );

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            background: '#0d0d11',
            fontSize: 10,
        }}>
            {/* ── Toolbar ── */}
            <div style={{
                height: 28,
                display: 'flex',
                alignItems: 'center',
                padding: '0 8px',
                gap: 4,
                background: '#16161a',
                borderBottom: '1px solid var(--color-divider)',
                flexShrink: 0,
            }}>
                {(['draw', 'select', 'erase'] as const).map((t) => (
                    <button
                        key={t}
                        onClick={() => setTool(t)}
                        style={{
                            padding: '2px 10px',
                            background: tool === t ? color : 'transparent',
                            color: tool === t ? '#fff' : 'var(--color-text-tertiary)',
                            border: tool === t ? 'none' : '1px solid var(--color-control-border)',
                            borderRadius: 3,
                            fontSize: 10,
                            fontWeight: tool === t ? 700 : 400,
                            cursor: 'pointer',
                            transition: 'all 0.15s ease',
                        }}
                    >
                        {t === 'draw' ? '✏ Draw' : t === 'select' ? '◻ Select' : '✕ Erase'}
                    </button>
                ))}
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)' }}>
                    {notes.length} notes
                </span>
            </div>

            {/* ── Main area (keyboard + grid) ── */}
            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                {/* Piano keyboard */}
                <div style={{
                    width: KEYBOARD_WIDTH,
                    flexShrink: 0,
                    overflowY: 'hidden',
                    background: '#111115',
                    borderRight: '1px solid var(--color-divider)',
                }}>
                    <div style={{ height: canvasHeight, position: 'relative' }}>
                        {pianoKeys.map((k) => (
                            <div
                                key={k.pitch}
                                style={{
                                    position: 'absolute',
                                    top: k.y,
                                    left: 0,
                                    width: k.isBlack ? KEYBOARD_WIDTH * 0.65 : KEYBOARD_WIDTH,
                                    height: NOTE_HEIGHT,
                                    background: k.isBlack ? '#1a1a1e' : '#2a2a30',
                                    borderBottom: '1px solid rgba(255,255,255,0.05)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'flex-end',
                                    paddingRight: 4,
                                    zIndex: k.isBlack ? 2 : 1,
                                }}
                            >
                                {k.pitch % 12 === 0 && (
                                    <span style={{
                                        fontSize: 7,
                                        color: 'var(--color-text-tertiary)',
                                        fontWeight: 600,
                                    }}>
                                        {k.name}
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                </div>

                {/* Note grid + velocity lane */}
                <div
                    ref={scrollRef}
                    style={{ flex: 1, overflow: 'auto', position: 'relative' }}
                >
                    <div style={{
                        width: canvasWidth,
                        height: canvasHeight + VELOCITY_LANE_HEIGHT,
                        position: 'relative',
                    }}>
                        {/* Grid background */}
                        <svg
                            width={canvasWidth}
                            height={canvasHeight}
                            style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
                        >
                            {/* Horizontal pitch lines */}
                            {Array.from({ length: TOTAL_KEYS }, (_, i) => (
                                <rect
                                    key={`h-${i}`}
                                    x={0}
                                    y={i * NOTE_HEIGHT}
                                    width={canvasWidth}
                                    height={NOTE_HEIGHT}
                                    fill={isBlackKey(LOWEST_PITCH + TOTAL_KEYS - 1 - i) ? 'rgba(0,0,0,0.15)' : 'transparent'}
                                    stroke="rgba(255,255,255,0.03)"
                                    strokeWidth={0.5}
                                />
                            ))}

                            {/* Vertical beat lines */}
                            {gridLines.map((gl, idx) => (
                                <line
                                    key={`v-${idx}`}
                                    x1={gl.x}
                                    y1={0}
                                    x2={gl.x}
                                    y2={canvasHeight}
                                    stroke={gl.isBar ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)'}
                                    strokeWidth={gl.isBar ? 1 : 0.5}
                                />
                            ))}
                        </svg>

                        {/* Clickable note grid area */}
                        <div
                            onClick={handleGridClick}
                            style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: canvasWidth,
                                height: canvasHeight,
                                cursor: tool === 'draw' ? 'crosshair' : tool === 'erase' ? 'not-allowed' : 'default',
                            }}
                        >
                            {/* MIDI Notes */}
                            {notes.map((note) => {
                                const x = note.startBeat * pixelsPerBeat;
                                const y = pitchToY(note.pitch);
                                const w = note.durationBeats * pixelsPerBeat;
                                const isNoteSelected = selectedNotes.has(note.id);

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
                                            height: NOTE_HEIGHT - 2,
                                            background: color,
                                            opacity: note.velocity / 127,
                                            borderRadius: 2,
                                            border: isNoteSelected
                                                ? '1.5px solid #fff'
                                                : '1px solid rgba(255,255,255,0.15)',
                                            cursor: tool === 'erase' ? 'not-allowed' : 'grab',
                                            zIndex: isNoteSelected ? 5 : 2,
                                            transition: 'border 0.1s ease',
                                            boxShadow: isNoteSelected
                                                ? `0 0 6px ${color}88`
                                                : 'none',
                                        }}
                                    />
                                );
                            })}
                        </div>

                        {/* Playhead */}
                        {playheadBeat !== undefined && (
                            <div style={{
                                position: 'absolute',
                                left: playheadBeat * pixelsPerBeat,
                                top: 0,
                                width: 1.5,
                                height: canvasHeight,
                                background: 'var(--color-accent-primary)',
                                zIndex: 20,
                                pointerEvents: 'none',
                                boxShadow: '0 0 6px var(--color-accent-primary)',
                            }} />
                        )}

                        {/* ── Velocity Lane ── */}
                        <div style={{
                            position: 'absolute',
                            top: canvasHeight,
                            left: 0,
                            width: canvasWidth,
                            height: VELOCITY_LANE_HEIGHT,
                            background: '#0a0a0e',
                            borderTop: '1px solid var(--color-divider)',
                        }}>
                            {/* Velocity bars */}
                            {notes.map((note) => {
                                const x = note.startBeat * pixelsPerBeat;
                                const w = Math.max(4, note.durationBeats * pixelsPerBeat * 0.5);
                                const barHeight = (note.velocity / 127) * (VELOCITY_LANE_HEIGHT - 4);
                                const isNoteSelected = selectedNotes.has(note.id);

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
                                            background: isNoteSelected ? '#fff' : color,
                                            opacity: 0.7,
                                            borderRadius: '2px 2px 0 0',
                                            cursor: 'ns-resize',
                                        }}
                                    />
                                );
                            })}

                            {/* Velocity lane label */}
                            <span style={{
                                position: 'absolute',
                                top: 4,
                                left: 4,
                                fontSize: 8,
                                color: 'var(--color-text-tertiary)',
                                fontWeight: 600,
                                textTransform: 'uppercase',
                                letterSpacing: '0.5px',
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
