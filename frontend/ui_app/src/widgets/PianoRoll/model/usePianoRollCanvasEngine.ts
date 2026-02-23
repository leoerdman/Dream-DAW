import { useEffect, useRef } from 'react';
import type { MidiNote } from '@/widgets/PianoRoll/model/pianoRollConfig';

export interface UsePianoRollCanvasEngineProps {
    notes: MidiNote[];
    ghostNotes: MidiNote[];
    selectedNotes: Set<string>;
    canvasWidth: number;
    canvasHeight: number;
    pixelsPerBeat: number;
    noteHeight: number;
    color: string;
    pitchToY: (pitch: number) => number;
}

export function usePianoRollCanvasEngine({
    notes,
    ghostNotes,
    selectedNotes,
    canvasWidth,
    canvasHeight,
    pixelsPerBeat,
    noteHeight,
    color,
    pitchToY,
}: UsePianoRollCanvasEngineProps) {
    const noteCanvasRef = useRef<HTMLCanvasElement | null>(null);

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
            ctx.fillStyle = 'var(--token-color-hex-9db2d6)';
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
            ctx.fillStyle = 'var(--token-color-hex-ffffff)';
            ctx.fillRect(x + 1, y, w - 2, 1);

            // Selection outline
            if (selectedNotes.has(note.id)) {
                ctx.globalAlpha = 1;
                ctx.strokeStyle = 'var(--token-color-hex-ffffff)';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.roundRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1), r);
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;
    }, [notes, ghostNotes, selectedNotes, canvasWidth, canvasHeight, pixelsPerBeat, noteHeight, color, pitchToY]);

    return { noteCanvasRef };
}
