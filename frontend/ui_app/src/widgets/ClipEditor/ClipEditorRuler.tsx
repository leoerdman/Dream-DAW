import { memo, type CSSProperties } from 'react';

/**
 * Shared beat/bar ruler for both MIDI and Audio clip editors.
 * Renders beat labels, grid tick marks, a colored clip-length bar, and end marker.
 * Single Source of Truth for ruler visuals across all clip editor types.
 */

/** Default ruler height in px. Matches RULER_HEIGHT from pianoRollConfig. */
export const CLIP_EDITOR_RULER_HEIGHT = 24;

interface RulerLabel {
    x: number;
    text: string;
    isBarStart: boolean;
}

interface GridLine {
    x: number;
    isBar: boolean;
    isMainBeat: boolean;
}

interface ClipEditorRulerProps {
    /** Total width of the ruler area in px */
    width: number;
    /** Clip duration in beats */
    clipBeats: number;
    /** Pixels per beat for positioning */
    pixelsPerBeat: number;
    /** Clip accent color */
    color: string;
    /** Pre-computed ruler labels (bar/beat text) */
    rulerBeatLabels?: RulerLabel[];
    /** Pre-computed grid lines (major/minor tick positions) */
    gridLines?: GridLine[];
    /** Grid step in beats for auto-generation when labels/lines not provided */
    gridStep?: number;
    /** Beats per bar for auto-generation */
    beatsPerBar?: number;
    /** Optional style overrides */
    style?: CSSProperties;
}

export const ClipEditorRuler = memo(function ClipEditorRuler({
    width,
    clipBeats,
    pixelsPerBeat,
    color,
    rulerBeatLabels,
    gridLines,
    gridStep = 1,
    beatsPerBar = 4,
    style,
}: ClipEditorRulerProps) {
    // Auto-generate labels/lines if not provided (used by Sample Editor)
    const labels = rulerBeatLabels ?? generateRulerLabels(clipBeats, pixelsPerBeat, beatsPerBar);
    const lines = gridLines ?? generateGridLines(clipBeats, pixelsPerBeat, gridStep, beatsPerBar);

    return (
        <div style={{
            position: 'sticky',
            top: 0,
            left: 0,
            width,
            height: CLIP_EDITOR_RULER_HEIGHT,
            zIndex: 'var(--z-sticky)',
            background: 'var(--color-bg-tertiary)',
            borderBottom: 'var(--space-px) solid var(--color-divider)',
            overflow: 'hidden',
            ...style,
        }}>
            {/* Color bar showing clip extent */}
            <div style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: clipBeats * pixelsPerBeat,
                height: 3,
                background: color,
                opacity: 0.65,
            }} />

            {/* Beat/bar labels */}
            {labels.map((label) => (
                <span
                    key={`ruler-label-${Math.round(label.x)}`}
                    style={{
                        position: 'absolute',
                        left: label.x + 5,
                        top: 6,
                        fontSize: 'var(--font-size-2xs)',
                        color: label.isBarStart ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                        fontWeight: label.isBarStart ? 700 : 500,
                        fontFamily: 'var(--font-role-data)',
                        pointerEvents: 'none',
                        userSelect: 'none',
                    }}
                >
                    {label.text}
                </span>
            ))}

            {/* Grid tick marks */}
            {lines.map((gl) => (
                <div
                    key={`ruler-tick-${Math.round(gl.x)}`}
                    style={{
                        position: 'absolute',
                        left: gl.x,
                        bottom: 0,
                        width: 1,
                        height: gl.isBar ? 10 : 5,
                        background: gl.isBar ? 'var(--color-grid-line-major)' : 'var(--color-grid-line)',
                    }}
                />
            ))}

            {/* Clip end marker */}
            <div style={{
                position: 'absolute',
                top: 0,
                left: clipBeats * pixelsPerBeat - 2,
                width: 2,
                height: CLIP_EDITOR_RULER_HEIGHT,
                background: color,
                opacity: 0.85,
            }} />
        </div>
    );
});

// ── Auto-generation helpers (for Sample Editor which doesn't pre-compute labels) ──

function generateRulerLabels(
    totalBeats: number,
    pixelsPerBeat: number,
    beatsPerBar: number,
): RulerLabel[] {
    const labels: RulerLabel[] = [];
    const labelStrideBeats = Math.max(1, Math.ceil(48 / Math.max(1, pixelsPerBeat)));
    const maxBeat = Math.ceil(totalBeats + 1e-6);
    for (let beat = 0; beat <= maxBeat; beat += labelStrideBeats) {
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
}

function generateGridLines(
    totalBeats: number,
    pixelsPerBeat: number,
    gridStep: number,
    beatsPerBar: number,
): GridLine[] {
    const lines: GridLine[] = [];
    const epsilon = 1e-6;
    const visualStep = gridStep > 0 ? gridStep : 0.25;
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
        });
    }
    return lines;
}
