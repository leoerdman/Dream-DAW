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
    /** Callback for preset navigation. */
    onNextPreset?: () => void;
    onPrevPreset?: () => void;
    /** Optional custom plugin UI content. */
    children?: ReactNode;
}


const TITLE_BAR_HEIGHT = 32;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 200;


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
    presetName = 'Default',
    onNextPreset,
    onPrevPreset,
    children,
}: PluginWindowProps) {
    const [position, setPosition] = useState({ x: initialX, y: initialY });
    const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

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

    const headerGradient = 'var(--plugin-header-effect)'; // Unified dark header
    const accentColor = 'var(--color-accent-primary)';    // Unified blue accent

    return (
        <div
            data-plugin-id={pluginId}
            style={{
                position: 'fixed',
                left: position.x,
                top: position.y,
                width: Math.max(MIN_WIDTH, width),
                height: Math.max(MIN_HEIGHT, height),
                zIndex: 'var(--z-modal)' as unknown as number,
                display: 'flex',
                flexDirection: 'column',
                background: 'var(--color-bg-elevated)',
                borderRadius: 'var(--radius-md)',
                border: 'var(--border-width-1) solid color-mix(in srgb, var(--color-text-primary) 8%, transparent)',
                boxShadow: '0 16px 64px var(--color-overlay-dark), 0 0 0 1px color-mix(in srgb, var(--color-text-primary) 5%, transparent)',
                overflow: 'hidden',
            }}
        >
            <div
                onMouseDown={handleDragStart}
                style={{
                    height: TITLE_BAR_HEIGHT,
                    background: headerGradient,
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0 var(--space-2)',
                    gap: 'var(--space-2)',
                    cursor: 'grab',
                    flexShrink: 0,
                    borderBottom: `var(--border-width-1) solid color-mix(in srgb, ${accentColor} 20%, transparent)`,
                    userSelect: 'none',
                }}
            >
                <div style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: isBypassed ? 'var(--color-text-tertiary)' : 'var(--color-accent-primary)',
                    boxShadow: isBypassed ? 'none' : '0 0 6px var(--color-accent-primary)',
                    transition: 'all var(--transition-fast)',
                }} />

                <span style={{
                    flex: 1,
                    fontSize: 'var(--font-size-sm)',
                    fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                    color: isBypassed ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                }}>
                    {pluginName}
                </span>

                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-0-5)' }}>
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

                <button
                    onClick={(e) => { e.stopPropagation(); onToggleBypass(); }}
                    title={isBypassed ? 'Enable Plugin' : 'Bypass Plugin'}
                    style={{
                        width: 20,
                        height: 20,
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
                        borderRadius: 'var(--radius-xs)',
                        fontSize: 'var(--font-size-xs)',
                        cursor: 'pointer',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-status-error)'; e.currentTarget.style.color = 'var(--color-text-on-accent)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--color-text-tertiary)'; }}
                >
                    ✕
                </button>
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
                    <div style={{ padding: 'var(--space-3)', height: '100%' }}>{children}</div>
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
                                    width: 48,
                                    height: 48,
                                    borderRadius: '50%',
                                    background: `conic-gradient(${accentColor} 0deg, ${accentColor} 200deg, var(--color-bg-tertiary) 200deg, var(--color-bg-tertiary) 360deg)`,
                                    border: 'var(--border-width-2) solid color-mix(in srgb, var(--color-text-primary) 8%, transparent)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                }}>
                                    <div style={{
                                        width: 40,
                                        height: 40,
                                        borderRadius: '50%',
                                        background: 'var(--color-bg-panel)',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        fontSize: 'var(--font-size-2xs)',
                                        fontWeight: 'var(--font-weight-semibold)' as unknown as number,
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
        </div>
    );
});

const presetBtnStyle: React.CSSProperties = {
    width: 16,
    height: 16,
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
