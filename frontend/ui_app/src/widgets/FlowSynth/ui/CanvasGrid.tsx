import { memo, useRef, useEffect } from 'react';
import { viewportProxy } from '../lib/ViewportProxy';

interface CanvasGridProps {
    showOrigin?: boolean;
}

const SNAP_GRID = 20;

// P3 FIX: Named constants for grid extent and opacity.
/** The SVG pattern rect spans this half-width from origin in each direction. */
const GRID_EXTENT_HALF = 50000;
/** Base dot opacity before zoom fade. */
const GRID_BASE_OPACITY = 0.22;
/** Zoom level below which dots start fading. */
const GRID_FADE_START = 0.5;
/** Zoom level at which dots are fully invisible. */
const GRID_FADE_END = 0.15;

// P3 FIX: Named constants for origin crosshair.
const ORIGIN_ARM_LENGTH = 15;
const ORIGIN_ARM_THICKNESS = 2;
const ORIGIN_DOT_SIZE = 6;

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
                let opacity = GRID_BASE_OPACITY;
                if (vp.zoom < GRID_FADE_START) {
                    const t = Math.min(1, (GRID_FADE_START - vp.zoom) / (GRID_FADE_START - GRID_FADE_END));
                    opacity = GRID_BASE_OPACITY * (1 - t);
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
                    opacity: GRID_BASE_OPACITY,
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
                    x={-GRID_EXTENT_HALF}
                    y={-GRID_EXTENT_HALF}
                    width={GRID_EXTENT_HALF * 2}
                    height={GRID_EXTENT_HALF * 2}
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
                        left: -ORIGIN_ARM_LENGTH,
                        top: -(ORIGIN_ARM_THICKNESS / 2),
                        width: ORIGIN_ARM_LENGTH * 2,
                        height: ORIGIN_ARM_THICKNESS,
                        background: 'var(--color-accent-tertiary)',
                        borderRadius: ORIGIN_ARM_THICKNESS / 2,
                    }} />
                    <div style={{
                        position: 'absolute',
                        left: -(ORIGIN_ARM_THICKNESS / 2),
                        top: -ORIGIN_ARM_LENGTH,
                        width: ORIGIN_ARM_THICKNESS,
                        height: ORIGIN_ARM_LENGTH * 2,
                        background: 'var(--color-accent-tertiary)',
                        borderRadius: ORIGIN_ARM_THICKNESS / 2,
                    }} />
                    <div style={{
                        position: 'absolute',
                        left: -(ORIGIN_DOT_SIZE / 2),
                        top: -(ORIGIN_DOT_SIZE / 2),
                        width: ORIGIN_DOT_SIZE,
                        height: ORIGIN_DOT_SIZE,
                        background: 'var(--color-accent-tertiary)',
                        borderRadius: '50%',
                    }} />
                </div>
            )}
        </>
    );
});
