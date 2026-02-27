import { useState, useCallback, useEffect } from 'react';
import { CanvasGrid } from './CanvasGrid';
import { NodesLayer } from './NodesLayer';
import { ConnectionsLayer } from './ConnectionsLayer';
import { useViewport } from '../model/useViewport';
import { useFlowSynthStore } from '../model/useFlowSynthStore';
import { viewportProxy } from '../lib/ViewportProxy';

export function FlowCanvas() {
    const { viewportRef, handleWheel } = useViewport();
    const nodes = useFlowSynthStore((state) => state.nodes);

    useEffect(() => {
        const canvas = viewportRef.current;
        if (!canvas) return;

        // Wheel handler needs to be non-passive for e.preventDefault()
        canvas.addEventListener('wheel', handleWheel, { passive: false });
        return () => canvas.removeEventListener('wheel', handleWheel);
    }, [handleWheel, viewportRef]);

    const [menuState, setMenuState] = useState<{ x: number; y: number; canvasX: number; canvasY: number } | null>(null);
    const addNode = useFlowSynthStore((state) => state.addNode);
    const hasOutputNode = nodes.some((node) => node.type === 'output');

    const handleContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        const canvas = viewportRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const vp = viewportProxy.getViewport();

        // Convert screen coordinates to canvas coordinates inverse-transform
        const canvasX = (e.clientX - rect.left - vp.x) / vp.zoom;
        const canvasY = (e.clientY - rect.top - vp.y) / vp.zoom;

        const MENU_WIDTH = 196;
        const MENU_HEIGHT = 248;
        const clampedX = Math.max(8, Math.min(e.clientX, window.innerWidth - MENU_WIDTH - 8));
        const clampedY = Math.max(8, Math.min(e.clientY, window.innerHeight - MENU_HEIGHT - 8));
        setMenuState({ x: clampedX, y: clampedY, canvasX, canvasY });
    }, [viewportRef]);

    const handleAddNode = (type: 'midiIn' | 'oscillator' | 'filter' | 'envelope' | 'output') => {
        if (!menuState) return;
        const nodeId = (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
            ? `node-${globalThis.crypto.randomUUID()}`
            : `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const labelByType: Record<typeof type, string> = {
            midiIn: 'Track MIDI In',
            oscillator: 'Oscillator',
            filter: 'Filter',
            envelope: 'Envelope',
            output: 'Audio Out',
        };
        addNode({
            id: nodeId,
            type,
            position: { x: menuState.canvasX, y: menuState.canvasY },
            data: { label: labelByType[type] }
        });
        setMenuState(null);
    };

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || !menuState) return;
            e.preventDefault();
            e.stopPropagation();
            setMenuState(null);
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
    }, [menuState]);

    return (
        <div
            ref={viewportRef}
            className="flow-canvas"
            onContextMenu={handleContextMenu}
            onClick={() => setMenuState(null)}
            style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                overflow: 'hidden',
                backgroundColor: 'var(--color-bg-canvas)',
            }}
        >
            <CanvasGrid showOrigin={true} />
            <ConnectionsLayer />
            <NodesLayer />

            {menuState && (
                <div
                    className="flow-context-menu"
                    style={{
                        position: 'fixed',
                        top: menuState.y,
                        left: menuState.x,
                        background: 'color-mix(in srgb, var(--color-bg-panel) 88%, transparent)',
                        backdropFilter: 'blur(var(--blur-lg))',
                        WebkitBackdropFilter: 'blur(var(--blur-lg))',
                        border: 'var(--space-px) solid var(--color-divider)',
                        borderRadius: 'var(--radius-xl)',
                        padding: 'var(--space-1-5)',
                        display: 'flex',
                        flexDirection: 'column',
                        zIndex: 'var(--z-dropdown)',
                        boxShadow: 'var(--shadow-xl)',
                        minWidth: 180,
                        fontFamily: 'var(--font-role-body)',
                    }}
                    onClick={e => e.stopPropagation()}
                >
                    <div style={{ padding: 'var(--space-2) var(--space-3)', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-tertiary)', fontWeight: 'var(--font-weight-bold)', textTransform: 'uppercase', letterSpacing: 'var(--letter-spacing-wide)' }}>Add Node</div>
                    <button
                        onClick={() => handleAddNode('midiIn')} style={{ textAlign: 'left', padding: 'var(--space-2) var(--space-3)', background: 'transparent', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', borderRadius: 'var(--radius-lg)', transition: 'background var(--transition-fast), color var(--transition-fast)', fontWeight: 'var(--font-weight-medium)', fontSize: 'var(--font-size-md)' }}>MIDI In</button>
                    <button
                        onClick={() => handleAddNode('oscillator')} style={{ textAlign: 'left', padding: 'var(--space-2) var(--space-3)', background: 'transparent', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', borderRadius: 'var(--radius-lg)', transition: 'background var(--transition-fast), color var(--transition-fast)', fontWeight: 'var(--font-weight-medium)', fontSize: 'var(--font-size-md)' }}>Oscillator</button>
                    <button
                        onClick={() => handleAddNode('filter')} style={{ textAlign: 'left', padding: 'var(--space-2) var(--space-3)', background: 'transparent', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', borderRadius: 'var(--radius-lg)', transition: 'background var(--transition-fast), color var(--transition-fast)', fontWeight: 'var(--font-weight-medium)', fontSize: 'var(--font-size-md)' }}>Filter</button>
                    <button
                        onClick={() => handleAddNode('envelope')} style={{ textAlign: 'left', padding: 'var(--space-2) var(--space-3)', background: 'transparent', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', borderRadius: 'var(--radius-lg)', transition: 'background var(--transition-fast), color var(--transition-fast)', fontWeight: 'var(--font-weight-medium)', fontSize: 'var(--font-size-md)' }}>Envelope</button>
                    {!hasOutputNode && (
                        <>
                            <div style={{ height: 'var(--space-px)', background: 'var(--color-divider)', margin: 'var(--space-1) 0' }} />
                            <button
                                onClick={() => handleAddNode('output')}
                                style={{ textAlign: 'left', padding: 'var(--space-2) var(--space-3)', background: 'transparent', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', borderRadius: 'var(--radius-lg)', transition: 'background var(--transition-fast), color var(--transition-fast)', fontWeight: 'var(--font-weight-medium)', fontSize: 'var(--font-size-md)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
                            >
                                <div style={{ width: 'var(--space-2)', height: 'var(--space-2)', borderRadius: 'var(--radius-full)', background: 'var(--color-status-error)', boxShadow: '0 0 8px color-mix(in srgb, var(--color-status-error) 60%, transparent)' }} />
                                Audio Out
                            </button>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
