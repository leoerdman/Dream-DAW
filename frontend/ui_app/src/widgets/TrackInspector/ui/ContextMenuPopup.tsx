import { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

export type ContextMenuPopupProps = {
    x: number;
    y: number;
    showTrackActions: boolean;
    onAddAudioTrack: () => void;
    onAddMidiTrack: () => void;
    onRename: () => void;
    onDuplicate: () => void;
    onGroup: () => void;
    onUngroup: () => void;
    canUngroup: boolean;
    canBounceGroup: boolean;
    onDelete: () => void;
    onChangeColor: () => void;
    onPaintClips: () => void;
    onBounceTrack: () => void;
    onBounceGroup: () => void;
    onPaintGroupColor: () => void;
    onSplitToStems: () => void;
    onDismiss: () => void;
};

export const ContextMenuPopup = ({
    x,
    y,
    showTrackActions,
    onAddAudioTrack,
    onAddMidiTrack,
    onRename,
    onDuplicate,
    onGroup,
    onUngroup,
    canUngroup,
    canBounceGroup,
    onDelete,
    onChangeColor,
    onPaintClips,
    onBounceTrack,
    onBounceGroup,
    onPaintGroupColor,
    onSplitToStems,
    onDismiss,
}: ContextMenuPopupProps) => {
    const ref = useRef<HTMLDivElement>(null);
    const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const colorHoverFiredRef = useRef(false);

    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
        };
        const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
        document.addEventListener('mousedown', handleClick);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('keydown', handleKey);
            if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        };
    }, [onDismiss]);

    const handleColorHoverEnter = useCallback(() => {
        if (colorHoverFiredRef.current) return; // Already showing
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = setTimeout(() => {
            colorHoverFiredRef.current = true;
            onChangeColor();
        }, 200);
    }, [onChangeColor]);

    const handleColorHoverLeave = useCallback(() => {
        if (hoverTimerRef.current) {
            clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
        }
        // Don't hide color picker on leave — keep it open for interaction
    }, []);

    const clampedX = Math.min(x, window.innerWidth - 196);
    const menuHeight = showTrackActions
        ? (canBounceGroup ? 414 : 346)
        : 82;
    const clampedY = Math.min(y, window.innerHeight - menuHeight);

    const itemStyle: React.CSSProperties = {
        width: '100%', padding: 'var(--space-1-5) var(--space-3)',
        background: 'none', border: 'none',
        color: 'var(--color-text-primary)', fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-regular)',
        textAlign: 'left', cursor: 'pointer', borderRadius: 'var(--radius-md)',
        display: 'flex', alignItems: 'center', gap: 8,
    };

    const node = (
        <div ref={ref} style={{
            position: 'fixed', left: clampedX, top: clampedY, width: 188,
            background: 'var(--surface-2)', border: 'var(--space-px) solid var(--color-border-subtle)',
            borderRadius: 'var(--radius-xl)', padding: 4, zIndex: 'var(--z-menu)',
            boxShadow: 'var(--shadow-panel)',
        }}>
            <button style={itemStyle} onClick={onAddAudioTrack}
                onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>🎚</span> Add Audio Track
            </button>
            <button style={itemStyle} onClick={onAddMidiTrack}
                onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>🎹</span> Add MIDI Track
            </button>
            {!showTrackActions && null}
            {showTrackActions && (
                <>
                    <div style={{ height: 1, background: 'var(--color-divider)', margin: 'var(--space-0-5) var(--space-2)' }} />
                    <button style={itemStyle} onClick={onRename}
                        onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                        <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>✏️</span> Rename
                    </button>
                    <button style={itemStyle} onClick={onDuplicate}
                        onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                        <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>📋</span> Duplicate Track
                    </button>
                    <button style={itemStyle}
                        onMouseEnter={e => {
                            e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)';
                            handleColorHoverEnter();
                        }}
                        onMouseLeave={e => {
                            e.currentTarget.style.background = 'none';
                            handleColorHoverLeave();
                        }}>
                        <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>🎨</span> Change Color
                        <span style={{ marginLeft: 'auto', fontSize: 'var(--font-size-xs)', opacity: 0.5 }}>▸</span>
                    </button>
                    <button style={itemStyle} onClick={onPaintClips}
                        onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                        <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>🖌</span> Paint Clips As Track
                    </button>
                    <button style={itemStyle} onClick={onBounceTrack}
                        onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                        <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>📀</span> Bounce Track
                    </button>
                    {canBounceGroup && (
                        <button style={itemStyle} onClick={onBounceGroup}
                            onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                            <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>📦</span> Bounce Group
                        </button>
                    )}
                    {canBounceGroup && (
                        <button style={itemStyle} onClick={onPaintGroupColor}
                            onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                            <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>🎨</span> Paint Group Color
                        </button>
                    )}
                    <button style={itemStyle} onClick={onSplitToStems}
                        onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                        <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>🧪</span> Split To 4 Stems
                    </button>
                    <button style={itemStyle} onClick={onGroup}
                        onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                        <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>🧩</span> Group Track
                    </button>
                    {canUngroup && (
                        <button style={itemStyle} onClick={onUngroup}
                            onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                            <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>↗</span> Move To Top Level
                        </button>
                    )}
                    <div style={{ height: 1, background: 'var(--color-divider)', margin: 'var(--space-0-5) var(--space-2)' }} />
                    <button style={{ ...itemStyle, color: 'var(--color-status-error)' }} onClick={onDelete}
                        onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--color-status-error) 18%, transparent)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}>
                        <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>🗑</span> Delete Track
                    </button>
                </>
            )}
        </div>
    );

    // Render into <body> so it is never clipped by panel overflow/stacking contexts.
    if (typeof document !== 'undefined' && document.body) {
        return createPortal(node, document.body);
    }
    return node;
};
