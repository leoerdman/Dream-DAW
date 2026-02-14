// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — PluginWindow (Detachable Floating Plugin GUI)
// ═══════════════════════════════════════════════════════════════════════════
//
// LEVIATHAN Epic 4: Floating window for plugin GUIs.
// Renders as a draggable, resizable overlay above the DAW shell.
//
// Features:
//   - Draggable title bar
//   - Close button (returns to inline view)
//   - Bypass toggle
//   - Plugin parameter view (knobs/sliders)
//   - Preset navigation
//
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useCallback, useRef, memo, type ReactNode } from 'react';

// ── Types ────────────────────────────────────────────────────────────────

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
    /** Callback for preset navigation. */
    onNextPreset?: () => void;
    onPrevPreset?: () => void;
    /** Optional custom plugin UI content. */
    children?: ReactNode;
}

// ── Constants ────────────────────────────────────────────────────────────

const TITLE_BAR_HEIGHT = 32;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 200;

// ── Component ────────────────────────────────────────────────────────────

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
    onNextPreset,
    onPrevPreset,
    children,
}: PluginWindowProps) {
    const [position, setPosition] = useState({ x: initialX, y: initialY });
    const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

    // ── Dragging ─────────────────────────────────────────────────────

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

    // ── Header colors ────────────────────────────────────────────────

    const headerGradient = pluginType === 'instrument'
        ? 'linear-gradient(135deg, #2d1b69 0%, #1a1036 100%)'
        : 'linear-gradient(135deg, #1b3a2d 0%, #0f2218 100%)';

    const accentColor = pluginType === 'instrument' ? '#9b59b6' : '#2ecc71';

    return (
        <div
            data-plugin-id={pluginId}
            style={{
                position: 'fixed',
                left: position.x,
                top: position.y,
                width: Math.max(MIN_WIDTH, width),
                height: Math.max(MIN_HEIGHT, height),
                zIndex: 9000,
                display: 'flex',
                flexDirection: 'column',
                background: '#111111',
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.08)',
                boxShadow: '0 16px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.05)',
                overflow: 'hidden',
            }}
        >
            {/* ── Title Bar ── */}
            <div
                onMouseDown={handleDragStart}
                style={{
                    height: TITLE_BAR_HEIGHT,
                    background: headerGradient,
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0 8px',
                    gap: 8,
                    cursor: 'grab',
                    flexShrink: 0,
                    borderBottom: `1px solid ${accentColor}33`,
                    userSelect: 'none',
                }}
            >
                {/* Plugin type indicator */}
                <div style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: isBypassed ? '#666' : accentColor,
                    boxShadow: isBypassed ? 'none' : `0 0 6px ${accentColor}`,
                    transition: 'all 0.2s ease',
                }} />

                {/* Plugin name */}
                <span style={{
                    flex: 1,
                    fontSize: 11,
                    fontWeight: 600,
                    color: isBypassed ? '#666' : '#fff',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                }}>
                    {pluginName}
                </span>

                {/* Preset navigation */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <button
                        onClick={(e) => { e.stopPropagation(); onPrevPreset?.(); }}
                        style={presetBtnStyle}
                    >
                        ◀
                    </button>
                    <span style={{
                        fontSize: 9,
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

                {/* Bypass toggle */}
                <button
                    onClick={(e) => { e.stopPropagation(); onToggleBypass(); }}
                    title={isBypassed ? 'Enable Plugin' : 'Bypass Plugin'}
                    style={{
                        width: 20,
                        height: 20,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: isBypassed ? '#e74c3c33' : 'transparent',
                        color: isBypassed ? '#e74c3c' : 'var(--color-text-tertiary)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: 3,
                        fontSize: 10,
                        cursor: 'pointer',
                    }}
                >
                    ⏻
                </button>

                {/* Close button */}
                <button
                    onClick={(e) => { e.stopPropagation(); onClose(); }}
                    title="Close Plugin Window"
                    style={{
                        width: 20,
                        height: 20,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'transparent',
                        color: 'var(--color-text-tertiary)',
                        border: 'none',
                        borderRadius: 3,
                        fontSize: 12,
                        cursor: 'pointer',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = '#e74c3c'; e.currentTarget.style.color = '#fff'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--color-text-tertiary)'; }}
                >
                    ✕
                </button>
            </div>

            {/* ── Plugin Body ── */}
            <div style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                opacity: isBypassed ? 0.4 : 1,
                transition: 'opacity 0.2s ease',
                overflow: 'auto',
            }}>
                {children ? (
                    <div style={{ padding: 12, height: '100%' }}>{children}</div>
                ) : (
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(4, 1fr)',
                        gap: 12,
                        padding: 16,
                        alignContent: 'start',
                    }}>
                        {['Gain', 'Frequency', 'Resonance', 'Mix', 'Attack', 'Release', 'Threshold', 'Ratio'].map(param => (
                            <div key={param} style={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                gap: 4,
                            }}>
                                <div style={{
                                    width: 48,
                                    height: 48,
                                    borderRadius: '50%',
                                    background: `conic-gradient(${accentColor} 0deg, ${accentColor} 200deg, #2a2a2a 200deg, #2a2a2a 360deg)`,
                                    border: '2px solid rgba(255,255,255,0.08)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                }}>
                                    <div style={{
                                        width: 40,
                                        height: 40,
                                        borderRadius: '50%',
                                        background: '#1a1a1a',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        fontSize: 10,
                                        fontWeight: 600,
                                        color: 'var(--color-text-secondary)',
                                    }}>
                                        0.55
                                    </div>
                                </div>
                                <span style={{
                                    fontSize: 9,
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
        </div>
    );
});

// ── Shared styles ────────────────────────────────────────────────────────

const presetBtnStyle: React.CSSProperties = {
    width: 16,
    height: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    color: 'var(--color-text-tertiary)',
    border: 'none',
    fontSize: 6,
    cursor: 'pointer',
};

export default PluginWindow;
