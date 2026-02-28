import { memo, useRef, useEffect } from 'react';
import { viewportProxy } from '../lib/ViewportProxy';

interface CanvasGridProps {
    showOrigin?: boolean;
}

const SNAP_GRID = 20;

/**
 * CanvasGrid - ENTERPRISE: CSS Background-based Grid
 * 
 * Uses CSS radial-gradient instead of massive SVG for grid background.
 */
export const CanvasGrid = memo(({ showOrigin = true }: CanvasGridProps) => {
    const gridRef = useRef<HTMLDivElement>(null);
    const originRef = useRef<HTMLDivElement>(null);

    const gridSize = SNAP_GRID;

    useEffect(() => {
        return viewportProxy.subscribe((vp) => {
            if (!gridRef.current) return;

            const scaledMinor = Math.max(8, Math.round(gridSize * vp.zoom));
            const scaledMajor = scaledMinor * 4;
            // ENTERPRISE FIX: Grid must align so lines pass through origin (0,0)
            // Gradient places line at CENTER of tile, so offset by half tile size
            const halfMinor = scaledMinor / 2;
            const halfMajor = scaledMajor / 2;
            const minorOffsetX = (((vp.x - halfMinor) % scaledMinor) + scaledMinor) % scaledMinor;
            const minorOffsetY = (((vp.y - halfMinor) % scaledMinor) + scaledMinor) % scaledMinor;
            const majorOffsetX = (((vp.x - halfMajor) % scaledMajor) + scaledMajor) % scaledMajor;
            const majorOffsetY = (((vp.y - halfMajor) % scaledMajor) + scaledMajor) % scaledMajor;

            gridRef.current.style.backgroundSize = `${scaledMinor}px ${scaledMinor}px, ${scaledMinor}px ${scaledMinor}px, ${scaledMajor}px ${scaledMajor}px, ${scaledMajor}px ${scaledMajor}px`;
            gridRef.current.style.backgroundPosition = `${minorOffsetX}px ${minorOffsetY}px, ${minorOffsetX}px ${minorOffsetY}px, ${majorOffsetX}px ${majorOffsetY}px, ${majorOffsetX}px ${majorOffsetY}px`;

            const baseOpacity = 0.2;
            const fadeStart = 0.6;
            const fadeEnd = 0.1;
            let opacity = baseOpacity;
            if (vp.zoom < fadeStart) {
                const fadeProgress = Math.min(1, (fadeStart - vp.zoom) / (fadeStart - fadeEnd));
                opacity = baseOpacity * (1 - fadeProgress);
            }
            gridRef.current.style.opacity = String(opacity);

            if (originRef.current) {
                originRef.current.style.transform =
                    `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
            }
        });
    }, [gridSize]);

    const initial = viewportProxy.getViewport();
    const initialScaledMinor = Math.max(8, Math.round(gridSize * initial.zoom));
    const initialScaledMajor = initialScaledMinor * 4;
    // ENTERPRISE FIX: Same fix for initial offset - account for center line
    const initialHalfMinor = initialScaledMinor / 2;
    const initialHalfMajor = initialScaledMajor / 2;
    const initialMinorOffsetX = (((initial.x - initialHalfMinor) % initialScaledMinor) + initialScaledMinor) % initialScaledMinor;
    const initialMinorOffsetY = (((initial.y - initialHalfMinor) % initialScaledMinor) + initialScaledMinor) % initialScaledMinor;
    const initialMajorOffsetX = (((initial.x - initialHalfMajor) % initialScaledMajor) + initialScaledMajor) % initialScaledMajor;
    const initialMajorOffsetY = (((initial.y - initialHalfMajor) % initialScaledMajor) + initialScaledMajor) % initialScaledMajor;

    return (
        <>
            <div
                ref={gridRef}
                style={{
                    position: 'absolute',
                    inset: 0,
                    pointerEvents: 'none',
                    zIndex: 0,
                    backgroundImage: `
                        linear-gradient(to right, color-mix(in srgb, var(--color-text-tertiary) 24%, transparent) 1px, transparent 1px),
                        linear-gradient(to bottom, color-mix(in srgb, var(--color-text-tertiary) 24%, transparent) 1px, transparent 1px),
                        linear-gradient(to right, color-mix(in srgb, var(--color-text-primary) 20%, transparent) 1px, transparent 1px),
                        linear-gradient(to bottom, color-mix(in srgb, var(--color-text-primary) 20%, transparent) 1px, transparent 1px)
                    `,
                    backgroundSize: `${initialScaledMinor}px ${initialScaledMinor}px, ${initialScaledMinor}px ${initialScaledMinor}px, ${initialScaledMajor}px ${initialScaledMajor}px, ${initialScaledMajor}px ${initialScaledMajor}px`,
                    backgroundPosition: `${initialMinorOffsetX}px ${initialMinorOffsetY}px, ${initialMinorOffsetX}px ${initialMinorOffsetY}px, ${initialMajorOffsetX}px ${initialMajorOffsetY}px, ${initialMajorOffsetX}px ${initialMajorOffsetY}px`,
                    opacity: 0.22,
                }}
            />

            {showOrigin && (
                <div
                    ref={originRef}
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: 0,
                        height: 0,
                        pointerEvents: 'none',
                        zIndex: 0,
                        transformOrigin: '0 0',
                        transform: `translate(${initial.x}px, ${initial.y}px) scale(${initial.zoom})`,
                    }}
                >
                    <div style={{
                        position: 'absolute',
                        left: -15,
                        top: -1,
                        width: 30,
                        height: 2,
                        background: 'var(--color-accent-tertiary)',
                        borderRadius: 1,
                    }} />
                    <div style={{
                        position: 'absolute',
                        left: -1,
                        top: -15,
                        width: 2,
                        height: 30,
                        background: 'var(--color-accent-tertiary)',
                        borderRadius: 1,
                    }} />
                    <div style={{
                        position: 'absolute',
                        left: -3,
                        top: -3,
                        width: 6,
                        height: 6,
                        background: 'var(--color-accent-tertiary)',
                        borderRadius: '50%',
                    }} />
                </div>
            )}
        </>
    );
});
