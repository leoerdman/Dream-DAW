import { memo, type MouseEvent as ReactMouseEvent } from 'react';
import {
    VELOCITY_LANE_HEIGHT,
    type MidiNote,
    type PianoLaneType,
} from '@/widgets/PianoRoll/model/pianoRollConfig';

interface PianoControlLaneProps {
    topOffset: number;
    canvasWidth: number;
    canvasHeight: number;
    notes: MidiNote[];
    pixelsPerBeat: number;
    activeLane: PianoLaneType;
    selectedNotes: Set<string>;
    color: string;
    readLaneValue: (note: MidiNote, lane: PianoLaneType) => number;
    onLaneMouseDown: (noteId: string, e: ReactMouseEvent) => void;
}

export const PianoControlLane = memo(function PianoControlLane({
    topOffset,
    canvasWidth,
    canvasHeight,
    notes,
    pixelsPerBeat,
    activeLane,
    selectedNotes,
    color,
    readLaneValue,
    onLaneMouseDown,
}: PianoControlLaneProps) {
    const laneLabel =
        activeLane === 'velocity' ? 'Velocity' : activeLane === 'modWheel' ? 'CC1 Mod Wheel' : 'CC11 Expression';

    return (
        <div
            style={{
                position: 'absolute',
                top: topOffset + canvasHeight,
                left: 0,
                width: canvasWidth,
                height: VELOCITY_LANE_HEIGHT,
                background: 'var(--color-bg-base)',
                borderTop: 'var(--space-px) solid var(--color-divider)',
            }}
        >
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
                const width = Math.max(3, note.durationBeats * pixelsPerBeat * 0.4);
                const laneValue = readLaneValue(note, activeLane);
                const barHeight = (laneValue / 127) * (VELOCITY_LANE_HEIGHT - 4);
                const isSelected = selectedNotes.has(note.id);
                const laneColor = activeLane === 'velocity' ? color : activeLane === 'modWheel' ? 'var(--token-color-hex-b48cff)' : 'var(--token-color-hex-7fd7ff)';

                return (
                    <div
                        key={`vel-${note.id}`}
                        onMouseDown={(event) => onLaneMouseDown(note.id, event)}
                        style={{
                            position: 'absolute',
                            left: x,
                            bottom: 0,
                            width,
                            height: barHeight,
                            background: isSelected ? 'var(--color-text-bright)' : laneColor,
                            opacity: isSelected ? 0.9 : 0.6,
                            borderRadius: 'var(--space-px) var(--space-px) 0 0',
                            cursor: 'ns-resize',
                            transition: 'opacity var(--transition-micro)',
                        }}
                    />
                );
            })}

            <span
                style={{
                    position: 'absolute',
                    top: 4,
                    left: 4,
                    fontSize: 'var(--font-size-micro)',
                    color: 'var(--color-text-tertiary)',
                    fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                    textTransform: 'uppercase',
                    letterSpacing: 'var(--letter-spacing-wide)',
                    fontFamily: 'var(--font-family)',
                }}
            >
                {laneLabel}
            </span>
        </div>
    );
});
