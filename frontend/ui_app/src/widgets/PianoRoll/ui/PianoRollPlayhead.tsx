import { memo } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { RULER_HEIGHT } from '@/widgets/PianoRoll/model/pianoRollConfig';

interface PianoRollPlayheadProps {
    clipStartBeat: number;
    clipBeats: number;
    pixelsPerBeat: number;
    canvasHeight: number;
}

export const PianoRollPlayhead = memo(function PianoRollPlayhead({
    clipStartBeat,
    clipBeats,
    pixelsPerBeat,
    canvasHeight,
}: PianoRollPlayheadProps) {
    const playheadBeat = useEngineStore((s) => (s.transport.position_beats ?? 0) - clipStartBeat);

    if (playheadBeat < 0 || playheadBeat >= clipBeats) return null;

    return (
        <div style={{
            position: 'absolute',
            left: playheadBeat * pixelsPerBeat,
            top: RULER_HEIGHT,
            width: 2,
            height: canvasHeight,
            background: 'var(--token-color-rgba-255-255-255-0d95)',
            zIndex: 'var(--z-header)',
            pointerEvents: 'none',
            boxShadow: 'none',
        }} />
    );
});
