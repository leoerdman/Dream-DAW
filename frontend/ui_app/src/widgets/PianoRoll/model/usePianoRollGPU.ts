// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — usePianoRollGPU Hook (Main-Thread WebGL2)
// ═══════════════════════════════════════════════════════════════════════════
//
// Renders the PianoRoll grid, notes, and playhead using WebGL2 directly on
// the main thread. No OffscreenCanvas or Web Worker — maximum compatibility
// with Tauri WKWebView on macOS.
//
// The PianoRollGLRenderer is instantiated once per canvas and renders
// via requestAnimationFrame. State changes set a dirty flag and trigger
// a re-render on the next frame.
//
// All coordinate values are in CSS pixels. DPR scaling is done in shaders.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useRef, useCallback, useState } from 'react';
import type { MidiNote } from '@/widgets/PianoRoll/model/pianoRollConfig';
import { PianoRollGLRenderer } from '@/widgets/PianoRoll/worker/PianoRollGLRenderer';

export interface UsePianoRollGPUProps {
    notes: MidiNote[];
    ghostNotes: MidiNote[];
    selectedNotes: Set<string>;
    canvasWidth: number;
    canvasHeight: number;
    pixelsPerBeat: number;
    noteHeight: number;
    color: string;
    scrollX: number;
    scrollY: number;
    beatsPerBar: number;
    gridInterval: number;
    totalBeats: number;
    totalPitches: number;
    highlightScale: boolean;
    scaleRoot: number;
    scaleNotes?: Set<number>;  // Pitch classes in the scale (0-11)
    playheadBeat: number | undefined;
    clipBeats: number;
    paused?: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Parse CSS hex color to RGB [0-1] tuple */
function hexToRGB(hex: string): [number, number, number] {
    const clean = hex.replace('#', '');
    if (clean.length === 3) {
        const r = parseInt(clean[0] + clean[0], 16) / 255;
        const g = parseInt(clean[1] + clean[1], 16) / 255;
        const b = parseInt(clean[2] + clean[2], 16) / 255;
        return [r, g, b];
    }
    const r = parseInt(clean.substring(0, 2), 16) / 255;
    const g = parseInt(clean.substring(2, 4), 16) / 255;
    const b = parseInt(clean.substring(4, 6), 16) / 255;
    return [r, g, b];
}

/**
 * Convert a Set<number> of pitch classes to an int[12] array
 * for the GPU shader. Default: major scale.
 */
function scaleSetToArray(scaleNotes?: Set<number>): number[] {
    if (!scaleNotes || scaleNotes.size === 0) {
        return [1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1]; // Major
    }
    const arr = new Array(12).fill(0) as number[];
    for (const pc of scaleNotes) {
        if (pc >= 0 && pc < 12) arr[pc] = 1;
    }
    return arr;
}

/**
 * Pack MidiNote[] + ghost notes into a Float32Array for GPU upload.
 * Format: [startBeat, pitch, durationBeats, velocity, flags] × N
 * Flags: bit0 = selected, bit1 = ghost
 */
function packNotes(
    notes: MidiNote[],
    ghostNotes: MidiNote[],
    selectedNotes: Set<string>,
): Float32Array {
    const total = notes.length + ghostNotes.length;
    const data = new Float32Array(total * 5);
    let offset = 0;

    // Ghost notes first (drawn under regular notes)
    for (const note of ghostNotes) {
        data[offset] = note.startBeat;
        data[offset + 1] = note.pitch;
        data[offset + 2] = note.durationBeats;
        data[offset + 3] = note.velocity;
        data[offset + 4] = 2; // bit1 = ghost
        offset += 5;
    }

    // Regular notes
    for (const note of notes) {
        data[offset] = note.startBeat;
        data[offset + 1] = note.pitch;
        data[offset + 2] = note.durationBeats;
        data[offset + 3] = note.velocity;
        data[offset + 4] = selectedNotes.has(note.id) ? 1 : 0; // bit0 = selected
        offset += 5;
    }

    return data;
}

// ── Hook ────────────────────────────────────────────────────────────────

export function usePianoRollGPU({
    notes,
    ghostNotes,
    selectedNotes,
    canvasWidth,
    canvasHeight,
    pixelsPerBeat,
    noteHeight,
    color,
    scrollX,
    scrollY,
    beatsPerBar,
    gridInterval,
    totalBeats,
    totalPitches,
    highlightScale,
    scaleRoot,
    scaleNotes,
    playheadBeat,
    clipBeats,
    paused = false,
}: UsePianoRollGPUProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const rendererRef = useRef<PianoRollGLRenderer | null>(null);
    const animFrameRef = useRef<number | null>(null);
    const dirtyRef = useRef(true);
    const [gpuAvailable, setGpuAvailable] = useState(true); // optimistic, verified on first mount
    const initedRef = useRef(false);

    // ── Schedule render on next frame ──
    const scheduleRender = useCallback(() => {
        if (paused) return;
        dirtyRef.current = true;
        if (animFrameRef.current === null) {
            animFrameRef.current = requestAnimationFrame(() => {
                animFrameRef.current = null;
                if (dirtyRef.current && rendererRef.current) {
                    dirtyRef.current = false;
                    rendererRef.current.render();
                }
            });
        }
    }, [paused]);

    // ── Renderer lifecycle (main-thread WebGL2) ──
    useEffect(() => {
        if (!gpuAvailable || initedRef.current) return;
        const canvas = canvasRef.current;
        if (!canvas || canvasWidth <= 0 || canvasHeight <= 0) return;

        try {
            const dpr = window.devicePixelRatio || 1;
            canvas.width = Math.ceil(canvasWidth * dpr);
            canvas.height = Math.ceil(canvasHeight * dpr);

            const gl = canvas.getContext('webgl2', {
                alpha: false,
                antialias: false,
                desynchronized: true,
                powerPreference: 'high-performance',
            });

            if (!gl) {
                console.warn('[PianoRollGPU] WebGL2 context unavailable, falling back to SVG');
                setGpuAvailable(false);
                return;
            }

            const renderer = new PianoRollGLRenderer(gl);
            renderer.setView({ dpr });
            rendererRef.current = renderer;
            initedRef.current = true;
            scheduleRender();

            return () => {
                if (animFrameRef.current !== null) {
                    cancelAnimationFrame(animFrameRef.current);
                    animFrameRef.current = null;
                }
                renderer.destroy();
                rendererRef.current = null;
                initedRef.current = false;
                // Lose the context explicitly to free the WebGL slot
                const ext = gl.getExtension('WEBGL_lose_context');
                if (ext) ext.loseContext();
            };
        } catch (err) {
            console.warn('[PianoRollGPU] WebGL2 init failed, falling back to SVG:', err);
            setGpuAvailable(false);
            initedRef.current = false;
        }
    }, [gpuAvailable, canvasWidth, canvasHeight, scheduleRender]);

    // ── Resize ──
    useEffect(() => {
        const canvas = canvasRef.current;
        const renderer = rendererRef.current;
        if (paused || !renderer || !canvas || canvasWidth <= 0 || canvasHeight <= 0) return;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.ceil(canvasWidth * dpr);
        canvas.height = Math.ceil(canvasHeight * dpr);
        renderer.setView({
            canvasWidth: canvas.width,
            canvasHeight: canvas.height,
            dpr,
        });
        scheduleRender();
    }, [paused, canvasWidth, canvasHeight, scheduleRender]);

    // ── Upload notes ──
    useEffect(() => {
        const renderer = rendererRef.current;
        if (paused || !renderer) return;
        const data = packNotes(notes, ghostNotes, selectedNotes);
        renderer.uploadNotes(data);
        scheduleRender();
    }, [paused, notes, ghostNotes, selectedNotes, scheduleRender]);

    // ── View updates (CSS pixels — shaders apply DPR internally) ──
    useEffect(() => {
        const renderer = rendererRef.current;
        if (paused || !renderer) return;

        const dpr = window.devicePixelRatio || 1;
        const playheadX = playheadBeat !== undefined && playheadBeat >= 0 && playheadBeat < clipBeats
            ? playheadBeat * pixelsPerBeat
            : -1;

        renderer.setView({
            dpr,
            pixelsPerBeat,
            noteHeight,
            scrollX,
            scrollY,
            canvasWidth: Math.ceil(canvasWidth * dpr),
            canvasHeight: Math.ceil(canvasHeight * dpr),
            beatsPerBar,
            gridInterval,
            totalBeats,
            totalPitches,
            highlightScale,
            scaleRoot,
            scaleNotes: scaleSetToArray(scaleNotes),
            playheadX,
        });
        scheduleRender();
    }, [paused, pixelsPerBeat, noteHeight, scrollX, scrollY, canvasWidth, canvasHeight,
        beatsPerBar, gridInterval, totalBeats, totalPitches,
        highlightScale, scaleRoot, scaleNotes, playheadBeat, clipBeats, scheduleRender]);

    // ── Style (color) updates ──
    useEffect(() => {
        const renderer = rendererRef.current;
        if (paused || !renderer) return;
        const noteColor = hexToRGB(color);
        // Root row tint: mix accent color at 12% opacity
        const rootRowColor: [number, number, number] = [
            noteColor[0] * 0.12 + 0.08,
            noteColor[1] * 0.12 + 0.08,
            noteColor[2] * 0.12 + 0.10,
        ];
        // Scale row tint: mix accent color at 5% opacity
        const scaleRowColor: [number, number, number] = [
            noteColor[0] * 0.05 + 0.09,
            noteColor[1] * 0.05 + 0.09,
            noteColor[2] * 0.05 + 0.11,
        ];
        // Out-of-scale: very dim
        const outScaleRowColor: [number, number, number] = [0.065, 0.065, 0.07];

        renderer.setStyle({ noteColor, rootRowColor, scaleRowColor, outScaleRowColor });
        scheduleRender();
    }, [paused, color, scheduleRender]);

    useEffect(() => {
        if (!paused) scheduleRender();
    }, [paused, scheduleRender]);

    return {
        gpuCanvasRef: canvasRef,
        gpuAvailable,
    };
}
