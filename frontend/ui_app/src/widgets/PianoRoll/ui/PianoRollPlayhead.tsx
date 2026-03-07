import { memo, useEffect, useRef } from 'react';
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
    const playheadRef = useRef<HTMLDivElement>(null);

    // ENTERPRISE PERF-OPT: Zero-render direct DOM mutation
    // Subscribing to position_beats via standard useEngineStore forces React to re-render at 60fps.
    // Instead, we subscribe manually and update the element'style.left directly.
    useEffect(() => {
        const unsub = useEngineStore.subscribe((state) => {
            const el = playheadRef.current;
            if (!el) return;
            const playheadBeat = (state.transport.position_beats ?? 0) - clipStartBeat;
            if (playheadBeat < 0 || playheadBeat >= clipBeats) {
                el.style.display = 'none';
            } else {
                el.style.display = 'block';
                el.style.left = `${playheadBeat * pixelsPerBeat}px`;
            }
        });
        return unsub;
    }, [clipStartBeat, clipBeats, pixelsPerBeat]);

    return (
        <div
            ref={playheadRef}
            style={{
                position: 'absolute',
                top: RULER_HEIGHT,
                width: 2,
                height: canvasHeight,
                background: 'var(--token-color-rgba-255-255-255-0d95)',
                zIndex: 'var(--z-header)',
                pointerEvents: 'none',
                boxShadow: 'none',
                display: 'none', // Initial state until first tick
            }}
        />
    );
});
