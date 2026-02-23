// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — usePianoRollGPU Hook
// ═══════════════════════════════════════════════════════════════════════════
//
// React hook that bridges the main thread to the PianoRoll OffscreenCanvas
// Worker. Handles:
// - Worker lifecycle (create on mount, destroy on unmount)
// - OffscreenCanvas transfer via transferControlToOffscreen()
// - Note data serialization to Float32Array (zero-copy transfer)
// - View/style synchronization on zoom/scroll/color changes
// - Scale notes computation for GPU scale highlighting
// - Fallback to 2D canvas if OffscreenCanvas or WebGL2 unavailable
//
// All coordinate values are passed in CSS pixels. The shaders apply DPR
// scaling internally so Retina displays render correctly.
//
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useRef } from 'react';
import type { MidiNote } from '@/widgets/PianoRoll/model/pianoRollConfig';
import type { WorkerInMessage, WorkerOutMessage } from '@/widgets/PianoRoll/worker/PianoRollWorker';

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

/** Detect whether OffscreenCanvas + WebGL2 are available. */
function canUseGPU(): boolean {
    try {
        if (typeof OffscreenCanvas === 'undefined') return false;
        const testCanvas = new OffscreenCanvas(1, 1);
        const gl = testCanvas.getContext('webgl2');
        return !!gl;
    } catch {
        return false;
    }
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
}: UsePianoRollGPUProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const workerRef = useRef<Worker | null>(null);
    const transferredRef = useRef(false);
    const gpuAvailable = canUseGPU();

    // ── Worker lifecycle ──
    useEffect(() => {
        if (gpuAvailable !== true) return;

        const canvas = canvasRef.current;
        if (!canvas || transferredRef.current) return;

        try {
            const offscreen = canvas.transferControlToOffscreen();
            transferredRef.current = true;

            const worker = new Worker(
                new URL('../worker/PianoRollWorker.ts', import.meta.url),
                { type: 'module' },
            );

            worker.onmessage = (event: MessageEvent<WorkerOutMessage>) => {
                if (event.data.type === 'error') {
                    console.error('[PianoRollGPU] Worker error:', event.data.message);
                }
            };

            const dpr = window.devicePixelRatio || 1;
            worker.postMessage(
                { type: 'init', canvas: offscreen, dpr } satisfies WorkerInMessage,
                [offscreen],
            );

            workerRef.current = worker;

            return () => {
                worker.postMessage({ type: 'destroy' } satisfies WorkerInMessage);
                worker.terminate();
                workerRef.current = null;
            };
        } catch (err) {
            console.error('[PianoRollGPU] Failed to init OffscreenCanvas:', err);
        }
    }, [gpuAvailable]);

    // ── Resize ──
    useEffect(() => {
        const worker = workerRef.current;
        if (!worker || canvasWidth <= 0 || canvasHeight <= 0) return;
        const dpr = window.devicePixelRatio || 1;
        worker.postMessage({
            type: 'resize',
            width: canvasWidth,
            height: canvasHeight,
            dpr,
        } satisfies WorkerInMessage);
    }, [canvasWidth, canvasHeight]);

    // ── Upload notes ──
    useEffect(() => {
        const worker = workerRef.current;
        if (!worker) return;
        const data = packNotes(notes, ghostNotes, selectedNotes);
        worker.postMessage(
            { type: 'updateNotes', data } satisfies WorkerInMessage,
            [data.buffer], // Transfer ownership (zero-copy)
        );
    }, [notes, ghostNotes, selectedNotes]);

    // ── View updates (CSS pixels — shaders apply DPR internally) ──
    useEffect(() => {
        const worker = workerRef.current;
        if (!worker) return;

        const dpr = window.devicePixelRatio || 1;
        const playheadX = playheadBeat !== undefined && playheadBeat >= 0 && playheadBeat < clipBeats
            ? playheadBeat * pixelsPerBeat
            : -1;

        worker.postMessage({
            type: 'updateView',
            view: {
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
            },
        } satisfies WorkerInMessage);
    }, [pixelsPerBeat, noteHeight, scrollX, scrollY, canvasWidth, canvasHeight,
        beatsPerBar, gridInterval, totalBeats, totalPitches,
        highlightScale, scaleRoot, scaleNotes, playheadBeat, clipBeats]);

    // ── Style (color) updates ──
    useEffect(() => {
        const worker = workerRef.current;
        if (!worker) return;
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

        worker.postMessage({
            type: 'updateStyle',
            style: { noteColor, rootRowColor, scaleRowColor, outScaleRowColor },
        } satisfies WorkerInMessage);
    }, [color]);

    return {
        gpuCanvasRef: canvasRef,
        gpuAvailable,
    };
}
