import { memo, type RefObject } from 'react';
import {
    KEYBOARD_WIDTH,
    RULER_HEIGHT,
    VELOCITY_LANE_HEIGHT,
} from '@/widgets/PianoRoll/model/pianoRollConfig';

export interface PianoKeyItem {
    pitch: number;
    name: string;
    isBlack: boolean;
    y: number;
    inScale: boolean;
    isC: boolean;
    drumName?: string;
}

interface PianoKeyboardProps {
    keyboardScrollRef: RefObject<HTMLDivElement | null>;
    canvasHeight: number;
    pianoKeys: PianoKeyItem[];
    highlightScale: boolean;
    drumMode: boolean;
    noteHeight: number;
    auditionNote: (pitch: number, velocity?: number, durationMs?: number) => void;
    stopAudition?: (pitch: number) => void;
}

export const PianoKeyboard = memo(function PianoKeyboard({
    keyboardScrollRef,
    canvasHeight,
    pianoKeys,
    highlightScale,
    drumMode,
    noteHeight,
    auditionNote,
    stopAudition,
}: PianoKeyboardProps) {
    return (
        <div
            style={{
                width: KEYBOARD_WIDTH,
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
            }}
        >
            <div
                style={{
                    height: RULER_HEIGHT,
                    background: 'var(--color-bg-tertiary)',
                    borderBottom: 'var(--space-px) solid var(--color-divider)',
                    borderRight: 'var(--space-px) solid var(--color-divider)',
                    flexShrink: 0,
                }}
            />

            <div
                ref={keyboardScrollRef}
                style={{
                    flex: 1,
                    overflowY: 'hidden',
                    background: 'var(--color-bg-base)',
                    borderRight: 'var(--space-px) solid var(--color-divider)',
                }}
            >
                <div style={{ height: canvasHeight + VELOCITY_LANE_HEIGHT, position: 'relative' }}>
                    {pianoKeys.map((key) => {
                        let background: string;
                        if (highlightScale && key.inScale) {
                            background = key.isBlack ? 'var(--color-bg-hover)' : 'var(--color-meter-silent)';
                        } else if (highlightScale && !key.inScale) {
                            background = key.isBlack ? 'var(--color-bg-base)' : 'var(--color-bg-tertiary)';
                        } else {
                            background = key.isBlack ? 'var(--color-piano-black)' : 'var(--color-piano-white)';
                        }

                        return (
                            <div
                                key={key.pitch}
                                onMouseDown={() => auditionNote(key.pitch, 110, 220)}
                                onMouseUp={() => stopAudition?.(key.pitch)}
                                onMouseLeave={() => stopAudition?.(key.pitch)}
                                style={{
                                    position: 'absolute',
                                    top: key.y,
                                    left: 0,
                                    width: KEYBOARD_WIDTH,
                                    height: noteHeight,
                                    background,
                                    borderBottom: 'var(--space-px) solid var(--color-border-subtle)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'flex-end',
                                    paddingRight: 4,
                                    zIndex: key.isBlack ? 2 : 1,
                                    transition: 'background var(--transition-fast)',
                                    cursor: 'pointer',
                                }}
                            >
                                {(drumMode || key.isC) && noteHeight >= 8 && (
                                    <span
                                        style={{
                                            fontSize: Math.min(9, noteHeight - 2),
                                            color: 'var(--color-text-secondary)',
                                            fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                                            fontFamily: 'var(--font-role-data)',
                                            letterSpacing: '-0.02em',
                                        }}
                                    >
                                        {drumMode ? (key.drumName ?? key.name) : key.name}
                                    </span>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
});
