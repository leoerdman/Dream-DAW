
interface MasterLaneGridStyle {
    backgroundColor: string;
}

export function snapPhysical(value: number): number {
    const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    return Math.round(value * dpr) / dpr;
}

export interface MasterLaneGridLines {
    barLines: number[];
    subLines: number[];
}

function fallbackGridStepBeats(pixelsPerBeat: number, beatsPerBar: number): number {
    if (pixelsPerBeat < 8) return beatsPerBar * 4;
    if (pixelsPerBeat < 15) return beatsPerBar;
    if (pixelsPerBeat < 40) return beatsPerBar;
    if (pixelsPerBeat < 80) return 1;
    return 0.5;
}

export function buildMasterLaneGridStyle(): MasterLaneGridStyle {
    return {
        backgroundColor: 'var(--color-timeline-track-default, var(--surface-1))',
    };
}

export function buildMasterLaneGridLines(
    pixelsPerBeat: number,
    beatsPerBar: number,
    snapBeats: number,
    scrollX: number,
    viewportWidth: number,
    alignmentOffsetPx = 0,
): MasterLaneGridLines {
    const ppb = Math.max(0.001, pixelsPerBeat);
    let gridStepBeats = snapBeats > 0
        ? snapBeats
        : fallbackGridStepBeats(ppb, beatsPerBar);

    // ═══════════════════════════════════════════════════════════════════
    // ENTERPRISE PERF: Adaptive density coarsening.
    //
    // Identical to the canvas _drawGrid approach: double the grid step
    // (power-of-2, preserving musical alignment) until lines are at
    // least MIN_GRID_PX pixels apart.
    //
    // Without this, 1/128 grid at full zoom out generates ~8,500 lines
    // that React renders as individual DOM <div> elements → severe lag.
    // ═══════════════════════════════════════════════════════════════════
    const MIN_GRID_PX = 3;
    while (gridStepBeats > 0 && (gridStepBeats * ppb) < MIN_GRID_PX) {
        gridStepBeats *= 2;
    }

    const startBeat = Math.floor((scrollX / ppb) / gridStepBeats) * gridStepBeats;
    const endBeat = Math.ceil(((scrollX + viewportWidth) / ppb) / gridStepBeats) * gridStepBeats;

    const barLines = new Set<number>();
    const subLines = new Set<number>();
    for (let beat = startBeat; beat <= endBeat; beat += gridStepBeats) {
        const barPhase = beat / beatsPerBar;
        const x = snapPhysical(beat * ppb - scrollX + alignmentOffsetPx);
        if (x < -1 || x > viewportWidth + 1) continue;
        if (!Number.isFinite(x)) continue;
        if (Math.abs(barPhase - Math.round(barPhase)) < 1e-6) {
            barLines.add(x);
            subLines.delete(x);
        } else if (!barLines.has(x)) {
            subLines.add(x);
        }
    }
    return {
        barLines: Array.from(barLines).sort((a, b) => a - b),
        subLines: Array.from(subLines).sort((a, b) => a - b),
    };
}
