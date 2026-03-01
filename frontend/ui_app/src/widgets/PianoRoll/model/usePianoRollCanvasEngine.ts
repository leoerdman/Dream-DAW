import { useEffect, useRef } from 'react';
import type { MidiNote } from '@/widgets/PianoRoll/model/pianoRollConfig';

function resolveCanvasColor(input: string, fallback: string): string {
    const raw = (input ?? '').trim();
    if (!raw) return fallback;
    if (!raw.startsWith('var(')) return raw;
    const varName = raw.slice(4, -1).trim();
    const resolved = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    if (resolved) return resolved;
    if (fallback.startsWith('var(')) {
        const fbName = fallback.slice(4, -1).trim();
        const fbResolved = getComputedStyle(document.documentElement).getPropertyValue(fbName).trim();
        if (fbResolved) return fbResolved;
    }
    return fallback;
}

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
    disabled?: boolean;
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
    disabled = false,
}: UsePianoRollCanvasEngineProps) {
    const noteCanvasRef = useRef<HTMLCanvasElement | null>(null);

    useEffect(() => {
        if (disabled) return;
        const canvas = noteCanvasRef.current;
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.ceil(canvasWidth * dpr));
        canvas.height = Math.max(1, Math.ceil(canvasHeight * dpr));
        canvas.style.width = `${canvasWidth}px`;
        canvas.style.height = `${canvasHeight}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const noteFillColor = resolveCanvasColor(color, 'var(--token-color-hex-4a9eff)');
        const noteStrokeSelectedColor = resolveCanvasColor('var(--color-text-on-accent)', 'var(--color-text-primary)');
        const noteStrokeDefaultColor = resolveCanvasColor('var(--color-text-secondary)', 'var(--color-text-tertiary)');
        const ghostFillColor = resolveCanvasColor('var(--color-text-secondary)', 'var(--color-text-tertiary)');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);

        // Ghost notes (same track, other clips) for harmony/rhythm context.
        for (const note of ghostNotes) {
            const x = note.startBeat * pixelsPerBeat;
            const rawY = pitchToY(note.pitch);
            if (rawY < 0) continue; // Bug #15: pitch not in visible row set
            const y = rawY;
            const w = Math.max(3, note.durationBeats * pixelsPerBeat);
            const h = noteHeight;
            if (x + w < 0 || x > canvasWidth) continue;
            ctx.globalAlpha = 0.17;
            ctx.fillStyle = ghostFillColor;
            ctx.fillRect(x, y, w, h);
        }

        for (const note of notes) {
            const x = note.startBeat * pixelsPerBeat;
            const rawY = pitchToY(note.pitch);
            if (rawY < 0) continue; // Bug #15: pitch not in visible row set
            const y = rawY;
            const w = Math.max(4, note.durationBeats * pixelsPerBeat);
            const h = noteHeight;

            // Note body — rounded rect with subtle gradient feel
            // Audit #48: expand alpha range from [0.4, 1.0] to [0.15, 1.0] for better
            // visual discrimination of low velocities.
            const alpha = 0.15 + (note.velocity / 127) * 0.85;
            ctx.globalAlpha = alpha;
            ctx.fillStyle = noteFillColor;
            ctx.beginPath();
            const r = Math.min(2, h / 4);
            ctx.roundRect(x, y, w, h, r);
            ctx.fill();

            // Top highlight edge (gives 3D feel)
            ctx.globalAlpha = 0.35;
            ctx.fillStyle = noteStrokeSelectedColor;
            ctx.fillRect(x + 1, y, w - 2, 1);

            // Always-visible outline: gray normally, white on selection.
            const isSelected = selectedNotes.has(note.id);
            ctx.globalAlpha = isSelected ? 0.98 : 0.72;
            ctx.strokeStyle = isSelected ? noteStrokeSelectedColor : noteStrokeDefaultColor;
            ctx.lineWidth = isSelected ? 1.6 : 1.0;
            ctx.beginPath();
            ctx.roundRect(x, y, Math.max(1, w - 1), Math.max(1, h - 1), r);
            ctx.stroke();

            // Selection outline
            if (isSelected) {
                ctx.globalAlpha = 1;
                ctx.strokeStyle = noteStrokeSelectedColor;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.roundRect(x, y, Math.max(1, w - 1), Math.max(1, h - 1), r);
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;
    }, [notes, ghostNotes, selectedNotes, canvasWidth, canvasHeight, pixelsPerBeat, noteHeight, color, pitchToY, disabled]);

    return { noteCanvasRef };
}
