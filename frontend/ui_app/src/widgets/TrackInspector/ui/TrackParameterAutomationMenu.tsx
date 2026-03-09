import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import type { TrackInspectorLogicState } from '@/widgets/TrackInspector/model/useTrackInspectorLogic';

const autoCtxMenuItemStyle: React.CSSProperties = {
    display: 'block',
    width: '100%',
    padding: 'var(--token-size-px-6) var(--space-2-5)',
    border: 'none',
    background: 'transparent',
    color: 'var(--color-text-primary)',
    fontSize: 'var(--font-size-sm)',
    fontWeight: 500,
    textAlign: 'left',
    cursor: 'pointer',
    borderRadius: 'var(--radius-sm)',
    transition: 'all var(--transition-fast)',
};

interface TrackParameterAutomationMenuProps {
    logic: TrackInspectorLogicState;
}

export function TrackParameterAutomationMenu({ logic }: TrackParameterAutomationMenuProps) {
    const { autoCtxMenu, setAutoCtxMenu } = logic;
    const menuRef = useRef<HTMLDivElement>(null);
    const [coords, setCoords] = useState<{ x: number; y: number; opacity: number; pointerEvents: 'none' | 'auto' }>({
        x: -9999,
        y: -9999,
        opacity: 0,
        pointerEvents: 'none',
    });

    useEffect(() => {
        if (!autoCtxMenu) {
            setCoords({ x: -9999, y: -9999, opacity: 0, pointerEvents: 'none' });
            return;
        }

        // Measure layout to bound it to screen correctly
        const measureId = requestAnimationFrame(() => {
            if (!menuRef.current) return;
            const rect = menuRef.current.getBoundingClientRect();
            const margin = 8;
            const finalX = Math.max(margin, Math.min(autoCtxMenu.x, window.innerWidth - rect.width - margin));
            const finalY = Math.max(margin, Math.min(autoCtxMenu.y, window.innerHeight - rect.height - margin));
            setCoords({ x: finalX, y: finalY, opacity: 1, pointerEvents: 'auto' });
        });

        const handleClick = (e: PointerEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setAutoCtxMenu(null);
            }
        };

        // Prevent immediate close from the very same click that opened it
        const timerId = setTimeout(() => {
            document.addEventListener('pointerdown', handleClick);
        }, 10);

        // Context menu close on escape
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setAutoCtxMenu(null);
            }
        };
        document.addEventListener('keydown', handleKey);

        return () => {
            cancelAnimationFrame(measureId);
            clearTimeout(timerId);
            document.removeEventListener('pointerdown', handleClick);
            document.removeEventListener('keydown', handleKey);
        };
    }, [autoCtxMenu, setAutoCtxMenu]);

    if (!autoCtxMenu) return null;

    // BUG-FIX: Use lowercased paramName to match Rust backend matchers ('volume', 'pan')
    // and AutomationOverlay auto-creation. Old format 'Track:Volume' didn't match anything.
    const normalizedParamKey = autoCtxMenu.paramName.toLowerCase();
    const existingLane = Object.values(useAutomationStore.getState().lanes).find(
        (lane) =>
            lane.trackId === autoCtxMenu.trackId &&
            lane.paramKey === normalizedParamKey,
    );

    return (
        <div
            ref={menuRef}
            onPointerDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
            style={{
                position: 'fixed',
                left: coords.x,
                top: coords.y,
                opacity: coords.opacity,
                pointerEvents: coords.pointerEvents,
                zIndex: 'var(--z-menu)',
                background: 'color-mix(in srgb, var(--color-bg-elevated) 98%, transparent)',
                backdropFilter: 'blur(16px)',
                WebkitBackdropFilter: 'blur(16px)',
                border: 'var(--space-px) solid color-mix(in srgb, var(--token-color-rgba-255-255-255-0d2) 100%, transparent)',
                borderRadius: 'var(--radius-lg)',
                padding: 'var(--space-1-5)',
                minWidth: 220,
                boxShadow: '0 var(--space-4) var(--space-8) var(--color-overlay-dark), 0 0 0 var(--space-px) var(--token-color-rgba-0-0-0-0d5)',
                transition: 'opacity 0.1s ease',
            }}
        >
            <div
                style={{
                    fontSize: 'var(--font-size-xs)',
                    color: 'var(--color-text-tertiary)',
                    padding: 'var(--space-1) var(--space-2) var(--space-2)',
                    fontWeight: 'var(--font-weight-semibold)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                }}
            >
                <span style={{ color: 'var(--color-text-secondary)' }}>Track {autoCtxMenu.paramName}</span>
            </div>
            {existingLane ? (
                <button
                    onClick={() => {
                        useAutomationStore.getState().removeLane(existingLane.id);
                        setAutoCtxMenu(null);
                    }}
                    style={autoCtxMenuItemStyle}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'color-mix(in srgb, var(--color-status-error) 20%, transparent)';
                        e.currentTarget.style.color = 'var(--color-status-error)';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                        e.currentTarget.style.color = 'var(--color-text-primary)';
                    }}
                >
                    <span style={{ marginRight: 8, opacity: 0.8 }}>✕</span> Remove Automation
                </button>
            ) : (
                <button
                    onClick={() => {
                        useAutomationStore.getState().addLane(
                            autoCtxMenu.trackId,
                            autoCtxMenu.paramName,
                            normalizedParamKey,
                        );
                        useAutomationStore.setState((s) => {
                            const nextExpanded = new Set(s.expandedTracks);
                            nextExpanded.add(autoCtxMenu.trackId);
                            return { expandedTracks: nextExpanded, globalVisible: true };
                        });
                        setAutoCtxMenu(null);
                    }}
                    style={autoCtxMenuItemStyle}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'var(--color-accent-primary)';
                        e.currentTarget.style.color = 'var(--color-bg-base)';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                        e.currentTarget.style.color = 'var(--color-text-primary)';
                    }}
                >
                    <span style={{ marginRight: 8, opacity: 0.8 }}>⊕</span> Add Automation
                </button>
            )}
            <button
                onClick={() => {
                    if (autoCtxMenu.paramName === 'Volume') {
                        logic.engineSetTrackVolume(logic.getTrackIndex(autoCtxMenu.trackId), 1.0);
                        void useEngineStore.getState().flushTrackControlFinals();
                    } else if (autoCtxMenu.paramName === 'Pan') {
                        logic.engineSetTrackPan(logic.getTrackIndex(autoCtxMenu.trackId), 0.0);
                        void useEngineStore.getState().flushTrackControlFinals();
                    }
                    setAutoCtxMenu(null);
                }}
                style={{ ...autoCtxMenuItemStyle, marginTop: 4 }}
                onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--color-bg-hover)';
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                }}
            >
                <span style={{ marginRight: 8, opacity: 0.5 }}>⟲</span> Set to Default
            </button>
        </div>
    );
}
