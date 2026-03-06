import { useState, useCallback, useRef, memo, type ReactNode } from 'react';

interface PluginWindowProps {
    /** Plugin instance ID. */
    pluginId: string;
    /** Plugin name (displayed in title bar). */
    pluginName: string;
    /** Whether the plugin is currently bypassed. */
    isBypassed: boolean;
    /** Callback to toggle bypass. */
    onToggleBypass: () => void;
    /** Callback to close the window. */
    onClose: () => void;
    /** Initial position. */
    initialX?: number;
    initialY?: number;
    /** Window dimensions. */
    width?: number;
    height?: number;
    /** Plugin type for header coloring. */
    pluginType?: 'instrument' | 'effect';
    /** Current preset name. */
    presetName?: string;
    /** Show preset section in header. */
    showPresetControls?: boolean;
    /** Show bypass toggle in header. */
    showBypassControl?: boolean;
    /** Optional custom header background. */
    headerBackground?: string;
    /** Optional custom header border color. */
    headerBorderColor?: string;
    /** Optional custom left status dot color. */
    leftDotColor?: string;
    /** Inner content padding. */
    contentPadding?: string;
    /** Callback for preset navigation. */
    onNextPreset?: () => void;
    onPrevPreset?: () => void;
    /** Callback for green traffic light button (e.g. snap to inline). */
    onMaximize?: () => void;
    /** Optional custom plugin UI content. */
    children?: ReactNode;
}

// ── ENTERPRISE: Named constants ────────────────────────────────────────────
const TITLE_BAR_HEIGHT = 32;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 200;
/** Traffic light button diameter. */
const TL_SIZE = 12;
/** Traffic light close icon font size. */
const TL_ICON_CLOSE_SIZE = 8;
/** Traffic light minimize icon font size. */
const TL_ICON_MIN_SIZE = 10;
/** Traffic light maximize icon font size. */
const TL_ICON_MAX_SIZE = 8;
/** Traffic light hover overlay color. */
const TL_HOVER_COLOR = 'rgba(0,0,0,0.5)';
/** Traffic light color constants (macOS standard). */
const TL_RED = 'var(--color-status-error)';
const TL_YELLOW = '#FFBD2E';
const TL_GREEN = '#28C840';
/** Resize handle widths. */
const RESIZE_EDGE_WIDTH = 5;
const RESIZE_EDGE_INSET = 6;
const RESIZE_CORNER_SIZE = 14;
const RESIZE_Z = 10;
const RESIZE_CORNER_Z = 11;
/** Window clamp margins. */
const WINDOW_CLAMP_MARGIN = 40;
/** Default fallback knob dimensions. */
const KNOB_OUTER_SIZE = 48;
const KNOB_INNER_SIZE = 40;
/** Bypass button size. */
const BYPASS_BTN_SIZE = 20;
/** Preset nav button size. */
const PRESET_NAV_SIZE = 16;


export const PluginWindow = memo(function PluginWindow({
    pluginId,
    pluginName,
    isBypassed,
    onToggleBypass,
    onClose,
    initialX = 200,
    initialY = 150,
    width = 480,
    height = 320,
    pluginType = 'effect',
    presetName = 'Default',
    showPresetControls = true,
    showBypassControl = true,
    headerBackground,
    headerBorderColor,
    // leftDotColor — deprecated, traffic lights replace the indicator dot
    contentPadding = 'var(--space-3)',
    onNextPreset,
    onPrevPreset,
    onMaximize,
    children,
}: PluginWindowProps) {
    const [position, setPosition] = useState({ x: initialX, y: initialY });
    const [size, setSize] = useState({ w: Math.max(MIN_WIDTH, width), h: Math.max(MIN_HEIGHT, height) });
    const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
    const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number; edge: string } | null>(null);

    const handleDragStart = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        const origX = position.x;
        const origY = position.y;
        dragRef.current = { startX, startY, origX, origY };

        const onMove = (ev: MouseEvent) => {
            if (!dragRef.current) return;
            setPosition({
                x: dragRef.current.origX + (ev.clientX - dragRef.current.startX),
                y: Math.max(0, dragRef.current.origY + (ev.clientY - dragRef.current.startY)),
            });
        };

        const onUp = () => {
            dragRef.current = null;
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [position]);

    const handleResizeStart = useCallback((e: React.PointerEvent, edge: string) => {
        e.preventDefault();
        e.stopPropagation();
        resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: size.w, origH: size.h, edge };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }, [size]);

    const handleResizeMove = useCallback((e: React.PointerEvent) => {
        if (!resizeRef.current) return;
        const { startX, startY, origW, origH, edge } = resizeRef.current;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const maxW = window.innerWidth - WINDOW_CLAMP_MARGIN;
        const maxH = window.innerHeight - WINDOW_CLAMP_MARGIN;
        setSize({
            w: edge.includes('e') ? Math.min(maxW, Math.max(MIN_WIDTH, origW + dx)) : origW,
            h: edge.includes('s') ? Math.min(maxH, Math.max(MIN_HEIGHT, origH + dy)) : origH,
        });
    }, []);

    const handleResizeEnd = useCallback(() => {
        resizeRef.current = null;
    }, []);

    const headerGradient = pluginType === 'instrument'
        ? 'var(--plugin-header-instrument)'
        : 'var(--plugin-header-effect)';
    const accentColor = pluginType === 'instrument'
        ? 'var(--plugin-accent-instrument)'
        : 'var(--plugin-accent-effect)';

    return (
        <div
            data-plugin-id={pluginId}
            style={{
                position: 'fixed',
                left: position.x,
                top: position.y,
                width: size.w,
                height: size.h,
                zIndex: 'var(--z-modal)',
                display: 'flex',
                flexDirection: 'column',
                background: 'var(--color-bg-elevated)',
                borderRadius: 'var(--radius-md)',
                border: 'var(--border-width-1) solid color-mix(in srgb, var(--color-text-primary) 8%, transparent)',
                boxShadow: '0 var(--space-4) var(--space-16) var(--color-overlay-dark), 0 0 0 var(--space-px) color-mix(in srgb, var(--color-text-primary) 5%, transparent)',
                overflow: 'hidden',
            }}
        >
            <div
                onMouseDown={handleDragStart}
                style={{
                    height: TITLE_BAR_HEIGHT,
                    background: headerBackground ?? headerGradient,
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0 var(--space-2)',
                    gap: 'var(--space-2)',
                    cursor: 'grab',
                    flexShrink: 0,
                    borderBottom: `var(--border-width-1) solid ${headerBorderColor ?? `color-mix(in srgb, ${accentColor} 20%, transparent)`}`,
                    userSelect: 'none',
                }}
            >
                {/* ── macOS Traffic Light Buttons (left) ── */}
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                    flexShrink: 0,
                    paddingLeft: 'var(--space-1)',
                }}>
                    {/* Close */}
                    <div
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); onClose(); }}
                        title="Close"
                        style={{
                            width: TL_SIZE,
                            height: TL_SIZE,
                            borderRadius: '50%',
                            background: TL_RED,
                            cursor: 'pointer',
                            transition: 'filter var(--transition-fast)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: TL_ICON_CLOSE_SIZE,
                            color: 'transparent',
                            lineHeight: 1,
                        }}
                        onMouseEnter={e => { e.currentTarget.style.color = TL_HOVER_COLOR; }}
                        onMouseLeave={e => { e.currentTarget.style.color = 'transparent'; }}
                    >
                        ✕
                    </div>
                    {/* Minimize (decorative) */}
                    <div
                        title="Minimize"
                        style={{
                            width: TL_SIZE,
                            height: TL_SIZE,
                            borderRadius: '50%',
                            background: TL_YELLOW,
                            cursor: 'default',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: TL_ICON_MIN_SIZE,
                            color: 'transparent',
                            lineHeight: 1,
                        }}
                        onMouseEnter={e => { e.currentTarget.style.color = TL_HOVER_COLOR; }}
                        onMouseLeave={e => { e.currentTarget.style.color = 'transparent'; }}
                    >
                        −
                    </div>
                    {/* Maximize / Snap inline */}
                    <div
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); onMaximize?.(); }}
                        title={onMaximize ? 'Snap to inline' : 'Maximize'}
                        style={{
                            width: TL_SIZE,
                            height: TL_SIZE,
                            borderRadius: '50%',
                            background: TL_GREEN,
                            cursor: onMaximize ? 'pointer' : 'default',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: TL_ICON_MAX_SIZE,
                            color: 'transparent',
                            lineHeight: 1,
                        }}
                        onMouseEnter={e => { e.currentTarget.style.color = TL_HOVER_COLOR; }}
                        onMouseLeave={e => { e.currentTarget.style.color = 'transparent'; }}
                    >
                        ⤢
                    </div>
                </div>

                {/* ── Title (centered) ── */}
                <span style={{
                    flex: 1,
                    fontSize: 'var(--font-size-sm)',
                    fontWeight: 'var(--font-weight-semibold)',
                    color: isBypassed ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    textAlign: 'center',
                }}>
                    {pluginName}
                </span>

                {/* ── Preset Controls (right) ── */}
                {showPresetControls && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-0-5)', flexShrink: 0 }}>
                        <button
                            onClick={(e) => { e.stopPropagation(); onPrevPreset?.(); }}
                            style={presetBtnStyle}
                        >
                            ◀
                        </button>
                        <span style={{
                            fontSize: 'var(--font-size-2xs)',
                            color: 'var(--color-text-secondary)',
                            minWidth: 60,
                            textAlign: 'center',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                        }}>
                            {presetName}
                        </span>
                        <button
                            onClick={(e) => { e.stopPropagation(); onNextPreset?.(); }}
                            style={presetBtnStyle}
                        >
                            ▶
                        </button>
                    </div>
                )}

                {showBypassControl && (
                    <button
                        onClick={(e) => { e.stopPropagation(); onToggleBypass(); }}
                        title={isBypassed ? 'Enable Plugin' : 'Bypass Plugin'}
                        style={{
                            width: BYPASS_BTN_SIZE,
                            height: BYPASS_BTN_SIZE,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: isBypassed ? 'color-mix(in srgb, var(--color-status-error) 20%, transparent)' : 'transparent',
                            color: isBypassed ? 'var(--color-status-error)' : 'var(--color-text-tertiary)',
                            border: 'var(--border-width-1) solid color-mix(in srgb, var(--color-text-primary) 10%, transparent)',
                            borderRadius: 'var(--radius-xs)',
                            fontSize: 'var(--font-size-2xs)',
                            cursor: 'pointer',
                        }}
                    >
                        ⏻
                    </button>
                )}
            </div>

            <div style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                opacity: isBypassed ? 0.4 : 1,
                transition: 'opacity var(--transition-fast)',
                overflow: 'auto',
            }}>
                {children ? (
                    <div style={{ padding: contentPadding, height: '100%' }}>{children}</div>
                ) : (
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(4, 1fr)',
                        gap: 'var(--space-3)',
                        padding: 'var(--space-4)',
                        alignContent: 'start',
                    }}>
                        {['Gain', 'Frequency', 'Resonance', 'Mix', 'Attack', 'Release', 'Threshold', 'Ratio'].map(param => (
                            <div key={param} style={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                gap: 'var(--space-1)',
                            }}>
                                <div style={{
                                    width: KNOB_OUTER_SIZE,
                                    height: KNOB_OUTER_SIZE,
                                    borderRadius: '50%',
                                    background: `conic-gradient(${accentColor} 0deg, ${accentColor} 200deg, var(--color-bg-tertiary) 200deg, var(--color-bg-tertiary) 360deg)`,
                                    border: 'var(--border-width-2) solid color-mix(in srgb, var(--color-text-primary) 8%, transparent)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                }}>
                                    <div style={{
                                        width: KNOB_INNER_SIZE,
                                        height: KNOB_INNER_SIZE,
                                        borderRadius: '50%',
                                        background: 'var(--color-bg-panel)',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        fontSize: 'var(--font-size-2xs)',
                                        fontWeight: 'var(--font-weight-semibold)',
                                        color: 'var(--color-text-secondary)',
                                    }}>
                                        0.55
                                    </div>
                                </div>
                                <span style={{
                                    fontSize: 'var(--font-size-2xs)',
                                    color: 'var(--color-text-tertiary)',
                                    textAlign: 'center',
                                }}>
                                    {param}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
            {/* ── Resize handles ── */}
            {/* Right edge */}
            <div
                onPointerDown={(e) => handleResizeStart(e, 'e')}
                onPointerMove={handleResizeMove}
                onPointerUp={handleResizeEnd}
                style={{ position: 'absolute', right: 0, top: TITLE_BAR_HEIGHT, bottom: RESIZE_EDGE_INSET, width: RESIZE_EDGE_WIDTH, cursor: 'ew-resize', zIndex: RESIZE_Z }}
            />
            {/* Bottom edge */}
            <div
                onPointerDown={(e) => handleResizeStart(e, 's')}
                onPointerMove={handleResizeMove}
                onPointerUp={handleResizeEnd}
                style={{ position: 'absolute', bottom: 0, left: RESIZE_EDGE_INSET, right: RESIZE_EDGE_INSET, height: RESIZE_EDGE_WIDTH, cursor: 'ns-resize', zIndex: RESIZE_Z }}
            />
            {/* Bottom-right corner */}
            <div
                onPointerDown={(e) => handleResizeStart(e, 'se')}
                onPointerMove={handleResizeMove}
                onPointerUp={handleResizeEnd}
                style={{ position: 'absolute', right: 0, bottom: 0, width: RESIZE_CORNER_SIZE, height: RESIZE_CORNER_SIZE, cursor: 'nwse-resize', zIndex: RESIZE_CORNER_Z }}
            />
        </div>
    );
});

const presetBtnStyle: React.CSSProperties = {
    width: PRESET_NAV_SIZE,
    height: PRESET_NAV_SIZE,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    color: 'var(--color-text-tertiary)',
    border: 'none',
    fontSize: 'var(--font-size-micro)',
    cursor: 'pointer',
    transition: `color var(--transition-fast)`,
};

export default PluginWindow;
