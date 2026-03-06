import { memo, useRef, useEffect } from 'react';
import { viewportProxy } from '../lib/ViewportProxy';

interface CanvasGridProps {
    showOrigin?: boolean;
}

const SNAP_GRID = 20;

/**
 * CanvasGrid — ENTERPRISE: SVG pattern-based grid with viewport transform.
 *
 * WHY SVG PATTERN instead of CSS radial-gradient:
 * CSS backgroundPosition + backgroundSize both change during zoom.
 * The modulo wrapping of backgroundPosition creates DISCONTINUOUS jumps
 * when backgroundSize changes continuously — visible as grid jitter.
 * This is mathematically unfixable with CSS backgrounds.
 *
 * SVG <pattern patternUnits="userSpaceOnUse"> tiles in local coordinates.
 * The viewport transform (translate + scale) is applied to the ENTIRE SVG
 * via the same mechanism used by NodesLayer and ConnectionsLayer.
 * This makes jitter physically impossible — all layers use one transform.
 *
 * The browser only rasterizes visible pattern tiles, so the large rect
 * has zero GPU memory overhead.
 */
export const CanvasGrid = memo(({ showOrigin = true }: CanvasGridProps) => {
    const svgRef = useRef<SVGSVGElement>(null);
    const originRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        return viewportProxy.subscribe((vp) => {
            if (svgRef.current) {
                svgRef.current.style.transform =
                    `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;

                // Fade out at very low zoom to reduce visual noise
                const baseOpacity = 0.22;
                const fadeStart = 0.5;
                const fadeEnd = 0.15;
                let opacity = baseOpacity;
                if (vp.zoom < fadeStart) {
                    const t = Math.min(1, (fadeStart - vp.zoom) / (fadeStart - fadeEnd));
                    opacity = baseOpacity * (1 - t);
                }
                svgRef.current.style.opacity = String(opacity);
            }

            if (originRef.current) {
                originRef.current.style.transform =
                    `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
            }
        });
    }, []);

    return (
        <>
            {/* Grid dots — SVG pattern in world coordinates */}
            <svg
                ref={svgRef}
                style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    overflow: 'visible',
                    transformOrigin: '0 0',
                    pointerEvents: 'none',
                    willChange: 'transform',
                    zIndex: 0,
                    opacity: 0.22,
                }}
            >
                <defs>
                    <pattern
                        id="flow-grid-pattern"
                        width={SNAP_GRID}
                        height={SNAP_GRID}
                        patternUnits="userSpaceOnUse"
                    >
                        <circle
                            cx={SNAP_GRID / 2}
                            cy={SNAP_GRID / 2}
                            r={1}
                            fill="var(--color-text-secondary)"
                        />
                    </pattern>
                </defs>
                <rect
                    x={-50000}
                    y={-50000}
                    width={100000}
                    height={100000}
                    fill="url(#flow-grid-pattern)"
                />
            </svg>

            {/* Origin crosshair — same viewport transform */}
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
