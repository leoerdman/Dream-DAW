import { useState } from 'react';

interface TrackRowResizeHandleProps {
    isResizing: boolean;
    onResizeStart?: (startY: number) => void;
}

export function TrackRowResizeHandle({ isResizing, onResizeStart }: TrackRowResizeHandleProps) {
    const [resizeHot, setResizeHot] = useState(false);

    return (
        <>
            <div
                role="presentation"
                onPointerEnter={() => setResizeHot(true)}
                onPointerLeave={() => setResizeHot(false)}
                onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onResizeStart?.(e.clientY);
                }}
                style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: -3,
                    height: 7,
                    cursor: 'ns-resize',
                    zIndex: 'var(--z-local)' as unknown as number,
                }}
            />
            {(resizeHot || isResizing) && (
                <div
                    aria-hidden
                    style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        bottom: 0,
                        height: 1,
                        background: 'color-mix(in srgb, var(--color-accent-primary) 76%, white)',
                        boxShadow: '0 0 var(--space-1-5) color-mix(in srgb, var(--color-accent-primary) 35%, transparent)',
                        pointerEvents: 'none',
                        zIndex: 'var(--z-local)' as unknown as number,
                    }}
                />
            )}
        </>
    );
}
