import { memo, useRef, useEffect } from 'react';
import { viewportProxy } from '../lib/ViewportProxy';

interface CanvasGridProps {
    showOrigin?: boolean;
}

const SNAP_GRID = 20;

/**
 * CanvasGrid — ENTERPRISE: Viewport-transformed dot pattern.
 *
 * Uses the SAME `translate + scale` transform as nodes and connections.
 * This ensures the grid is perfectly in sync — no jitter, no drift.
 *
 * The div covers a large world-space area (-50000 to +50000 in each axis)
 * with a fixed 20px CSS background tile. The browser only rasterizes
 * the visible portion, so this is GPU-efficient.
 */
export const CanvasGrid = memo(({ showOrigin = true }: CanvasGridProps) => {
    const gridRef = useRef<HTMLDivElement>(null);
    const originRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        return viewportProxy.subscribe((vp) => {
            if (gridRef.current) {
                // ENTERPRISE: Identical transform to NodesLayer / ConnectionsLayer.
                // A single GPU-composited transform is jitter-free — no manual
                // backgroundPosition / backgroundSize recomputation needed.
                gridRef.current.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;

                // Fade out at very low zoom to reduce visual noise
                const baseOpacity = 0.22;
                const fadeStart = 0.6;
                const fadeEnd = 0.1;
                let opacity = baseOpacity;
                if (vp.zoom < fadeStart) {
                    const fadeProgress = Math.min(1, (fadeStart - vp.zoom) / (fadeStart - fadeEnd));
                    opacity = baseOpacity * (1 - fadeProgress);
                }
                gridRef.current.style.opacity = String(opacity);
            }

            if (originRef.current) {
                originRef.current.style.transform =
                    `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
            }
        });
    }, []);

    return (
        <>
            <div
                ref={gridRef}
                style={{
                    position: 'absolute',
                    // Cover a large world-space area. The browser only renders
                    // the visible portion, so the large size is free.
                    left: -50000,
                    top: -50000,
                    width: 100000,
                    height: 100000,
                    transformOrigin: '0 0',
                    pointerEvents: 'none',
                    zIndex: 0,
                    willChange: 'transform',
                    // Fixed-size pattern — zoom is handled entirely by the transform.
                    backgroundImage: `radial-gradient(circle, var(--color-text-secondary) 1px, transparent 1px)`,
                    backgroundSize: `${SNAP_GRID}px ${SNAP_GRID}px`,
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
