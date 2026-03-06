import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Hand, MousePointer2 } from 'lucide-react';
import { CanvasGrid } from './CanvasGrid';
import { NodesLayer } from './NodesLayer';
import { ConnectionsLayer } from './ConnectionsLayer';
import { useViewport } from '../model/useViewport';
import {
    useFlowSynthStore,
    type SynthNodeType,
} from '../model/useFlowSynthStore';
import { FLOW_NODE_HEADER_HEIGHT, PORT_REGISTRY, portCenterY } from '../model/portRegistry';
import { viewportProxy } from '../lib/ViewportProxy';

const NODE_CATALOG: Array<{ type: SynthNodeType; label: string; keywords: string[]; category: string }> = [
    // ── I/O ──
    { type: 'midiIn', label: 'MIDI In', keywords: ['midi', 'input', 'source', 'note'], category: 'I/O' },
    { type: 'audioIn', label: 'Audio In', keywords: ['audio', 'input', 'source', 'sidechain'], category: 'I/O' },
    { type: 'output', label: 'Audio Out', keywords: ['master', 'sink', 'output', 'out'], category: 'I/O' },
    // ── Oscillator ──
    { type: 'oscillator', label: 'Oscillator', keywords: ['osc', 'synth', 'wave', 'sine', 'saw', 'square'], category: 'Oscillator' },
    // ── Filter ──
    { type: 'filter', label: 'Filter', keywords: ['lp', 'hp', 'bp', 'cutoff', 'svf'], category: 'Filter' },
    { type: 'autofilter', label: 'Auto Filter', keywords: ['auto', 'mod', 'filter', 'lfo'], category: 'Filter' },
    { type: 'eq', label: 'EQ', keywords: ['equalizer', 'tone', 'band'], category: 'Filter' },
    // ── Envelope ──
    { type: 'envelope', label: 'Envelope', keywords: ['env', 'adsr', 'mod', 'amplitude', 'gate'], category: 'Envelope' },
    // ── LFO ──
    { type: 'lfo', label: 'LFO', keywords: ['lfo', 'modulation', 'sine', 'rate', 'vibrato', 'tremolo', 'periodic'], category: 'LFO' },
    // ── Math ──
    { type: 'add', label: 'Add', keywords: ['add', 'sum', 'plus', 'combine', 'math'], category: 'Math' },
    { type: 'multiply', label: 'Multiply', keywords: ['mul', 'multiply', 'scale', 'ring', 'attenuvert', 'math', 'vca'], category: 'Math' },
    // ── Level ──
    { type: 'vca', label: 'VCA', keywords: ['vca', 'amplifier', 'amplitude', 'gain', 'cv', 'level'], category: 'Level' },
    { type: 'mixer', label: 'Mixer', keywords: ['mix', 'mixer', 'blend', 'combine', 'sum', 'bus'], category: 'Level' },
    // ── Random ──
    { type: 'noise', label: 'Noise', keywords: ['noise', 'white', 'pink', 'random', 'texture', 'hiss'], category: 'Random' },
    { type: 'sampleHold', label: 'Sample & Hold', keywords: ['s&h', 'sample', 'hold', 'trigger', 'step', 'random', 'quantize'], category: 'Random' },
    // ── Delay / FX ──
    { type: 'delay', label: 'Delay', keywords: ['delay', 'echo', 'repeat', 'time', 'feedback', 'comb'], category: 'Delay/FX' },
    { type: 'reverse', label: 'Reverse', keywords: ['fx', 'reverse', 'backwards'], category: 'Delay/FX' },
    { type: 'distortion', label: 'Distortion', keywords: ['distort', 'drive', 'clip', 'waveshaper', 'saturate', 'overdrive', 'crush'], category: 'Delay/FX' },
    // ── Pitch ──
    { type: 'pitch', label: 'Pitch', keywords: ['pitch', 'octave', 'transpose', 'tune', 'semitone'], category: 'Pitch' },
    // ── Utility ──
    { type: 'utility', label: 'Utility', keywords: ['utility', 'gain', 'pan', 'phase', 'invert', 'dc', 'trim', 'level', 'volume'], category: 'Utility' },
    // ── External ──
    { type: 'vst3', label: 'VST3 Plugin', keywords: ['vst', 'vst3', 'plugin', 'external', 'instrument', 'effect', 'serum', 'vital'], category: 'External' },
];



type SelectionBox = { startX: number; startY: number; currentX: number; currentY: number } | null;

function toWorld(clientX: number, clientY: number, canvas: HTMLElement) {
    const rect = canvas.getBoundingClientRect();
    const vp = viewportProxy.getViewport();
    return {
        x: (clientX - rect.left - vp.x) / vp.zoom,
        y: (clientY - rect.top - vp.y) / vp.zoom,
    };
}

export function FlowCanvas() {
    const { viewportRef, handleWheel } = useViewport();
    const nodes = useFlowSynthStore((state) => state.nodes);
    const connections = useFlowSynthStore((state) => state.connections);
    const pendingConnection = useFlowSynthStore((state) => state.pendingConnection);
    const selectedNodeIds = useFlowSynthStore((state) => state.selectedNodeIds);
    const selectedConnectionId = useFlowSynthStore((state) => state.selectedConnectionId);

    useEffect(() => {
        const canvas = viewportRef.current;
        if (!canvas) return;

        // Wheel handler needs to be non-passive for e.preventDefault()
        canvas.addEventListener('wheel', handleWheel, { passive: false });
        return () => canvas.removeEventListener('wheel', handleWheel);
    }, [handleWheel, viewportRef]);

    const [menuState, setMenuState] = useState<{ x: number; y: number; canvasX: number; canvasY: number } | null>(null);
    const [menuSearch, setMenuSearch] = useState('');
    const [menuIndex, setMenuIndex] = useState(0);
    const [selectionBox, setSelectionBoxUi] = useState<SelectionBox>(null);
    const addNode = useFlowSynthStore((state) => state.addNode);
    const updatePendingConnection = useFlowSynthStore((state) => state.updatePendingConnection);
    const cancelConnectionDrag = useFlowSynthStore((state) => state.cancelConnectionDrag);
    const commitConnection = useFlowSynthStore((state) => state.commitConnection);
    const clearSelection = useFlowSynthStore((state) => state.clearSelection);
    const setSelectionBox = useFlowSynthStore((state) => state.setSelectionBox);
    const deleteSelectedNodes = useFlowSynthStore((state) => state.deleteSelectedNodes);
    const deleteConnection = useFlowSynthStore((state) => state.deleteConnection);
    const hasOutputNode = nodes.some((node) => node.type === 'output');
    const menuInputRef = useRef<HTMLInputElement>(null);
    const spacePressedRef = useRef(false);
    const ctrlPressedRef = useRef(false);
    const [ctrlPressed, setCtrlPressed] = useState(false);
    const [tool, setTool] = useState<'cursor' | 'hand'>('cursor');
    const panStateRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

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
        setMenuSearch('');
        setMenuIndex(0);
    }, [viewportRef]);

    const openMenuAtPointer = useCallback((clientX: number, clientY: number) => {
        const canvas = viewportRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const vp = viewportProxy.getViewport();
        const canvasX = (clientX - rect.left - vp.x) / vp.zoom;
        const canvasY = (clientY - rect.top - vp.y) / vp.zoom;

        const MENU_WIDTH = 196;
        const MENU_HEIGHT = 248;
        const clampedX = Math.max(8, Math.min(clientX, window.innerWidth - MENU_WIDTH - 8));
        const clampedY = Math.max(8, Math.min(clientY, window.innerHeight - MENU_HEIGHT - 8));
        setMenuState({ x: clampedX, y: clampedY, canvasX, canvasY });
        setMenuSearch('');
        setMenuIndex(0);
    }, [viewportRef]);

    const handleAddNode = (type: SynthNodeType) => {
        if (!menuState) return;
        const nodeId = (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
            ? `node-${globalThis.crypto.randomUUID()}`
            : `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const labelByType: Record<SynthNodeType, string> = {
            midiIn: 'Track MIDI In',
            oscillator: 'Oscillator',
            filter: 'Filter',
            envelope: 'Envelope',
            output: 'Audio Out',
            eq: 'Parametric EQ',
            autofilter: 'AutoFilter',
            reverse: 'Reverse FX',
            audioIn: 'Audio Input',
            lfo: 'LFO',
            noise: 'Noise',
            add: 'Add',
            multiply: 'Multiply',
            sampleHold: 'Sample & Hold',
            delay: 'Delay',
            mixer: 'Mixer',
            vca: 'VCA',
            pitch: 'Pitch',
            utility: 'Utility',
            distortion: 'Distortion',
            vst3: 'VST3 Plugin',
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
            // ENTERPRISE: Do NOT capture Space key — it must propagate to DAW transport play/stop.
            // Canvas panning is handled via mouse middle button or Ctrl+drag.
            if (e.key === 'Control') {
                ctrlPressedRef.current = true;
                setCtrlPressed(true);
            }

            if (e.key === 'Escape') {
                if (menuState) {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenuState(null);
                    return;
                }
                if (pendingConnection) {
                    e.preventDefault();
                    e.stopPropagation();
                    cancelConnectionDrag();
                    return;
                }
                clearSelection();
                return;
            }

            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (selectedConnectionId) {
                    e.preventDefault();
                    deleteConnection(selectedConnectionId);
                    return;
                }
                if (selectedNodeIds.length > 0) {
                    e.preventDefault();
                    deleteSelectedNodes();
                }
                return;
            }

            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                const box = {
                    x: -100000,
                    y: -100000,
                    width: 200000,
                    height: 200000,
                };
                setSelectionBox(box);
            }

            if (menuState && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter')) {
                e.preventDefault();
                const list = filteredCatalog;
                if (e.key === 'ArrowDown') {
                    setMenuIndex((prev) => Math.min(list.length - 1, prev + 1));
                } else if (e.key === 'ArrowUp') {
                    setMenuIndex((prev) => Math.max(0, prev - 1));
                } else if (e.key === 'Enter') {
                    const item = list[menuIndex];
                    if (item) handleAddNode(item.type);
                }
            }
        };
        const onKeyUp = (e: KeyboardEvent) => {
            if (e.key === 'Control') {
                ctrlPressedRef.current = false;
                setCtrlPressed(false);
            }
        };
        const onBlur = () => {
            spacePressedRef.current = false;
            ctrlPressedRef.current = false;
            setCtrlPressed(false);
        };
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('keyup', onKeyUp, true);
        window.addEventListener('blur', onBlur);
        return () => {
            document.removeEventListener('keydown', onKeyDown, true);
            document.removeEventListener('keyup', onKeyUp, true);
            window.removeEventListener('blur', onBlur);
        };
    }, [menuState, pendingConnection, selectedNodeIds.length, selectedConnectionId, deleteSelectedNodes, deleteConnection, clearSelection, setSelectionBox, menuIndex]);

    useEffect(() => {
        if (!menuState) return;
        menuInputRef.current?.focus();
    }, [menuState]);

    useEffect(() => {
        if (!pendingConnection) return;
        const findSnapTarget = (worldX: number, worldY: number) => {
            const occupiedInputs = new Set(
                connections.map((conn) => `${conn.toNode}:${conn.toPort}`),
            );
            let best: { nodeId: string; signalType: 'audio' | 'midi' | 'control'; toPort: string; x: number; y: number; occupied: boolean } | null = null;
            let bestDist = Infinity;
            for (const node of nodes) {
                if (node.id === pendingConnection.fromNode) continue;
                if (!node.position) continue; // ENTERPRISE GUARD: skip corrupt nodes
                const config = PORT_REGISTRY[node.type as SynthNodeType];
                if (!config || config.inputs.length === 0) continue;
                // Check each input port
                for (let pi = 0; pi < config.inputs.length; pi++) {
                    const portDef = config.inputs[pi];
                    const signalType: 'audio' | 'midi' | 'control' = portDef.type === 'midi' ? 'midi' : portDef.type === 'control' ? 'control' : 'audio';
                    // ENTERPRISE FIX: Strict port matching. No exceptions allowed per user mandate.
                    // Yellow port ONLY to yellow port, blue port ONLY to blue port.
                    if (signalType !== pendingConnection.signalType) continue;
                    const toPort = portDef.id;
                    const x = node.position.x;
                    const y = node.position.y + FLOW_NODE_HEADER_HEIGHT + portCenterY(pi);
                    const dx = worldX - x;
                    const dy = worldY - y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist >= 24) continue;
                    const occupied = occupiedInputs.has(`${node.id}:${toPort}`);
                    if (!best ||
                        (best.occupied && !occupied) ||
                        (best.occupied === occupied && dist < bestDist)
                    ) {
                        bestDist = dist;
                        best = { nodeId: node.id, signalType, toPort, x, y, occupied };
                    }
                }
            }

            return best;
        };

        const onPointerMove = (e: PointerEvent) => {
            const canvas = viewportRef.current;
            if (!canvas) return;
            const world = toWorld(e.clientX, e.clientY, canvas);
            const snapTarget = findSnapTarget(world.x, world.y);
            if (snapTarget) updatePendingConnection(snapTarget.x, snapTarget.y);
            else updatePendingConnection(world.x, world.y);
        };
        const onPointerUp = (e: PointerEvent) => {
            const canvas = viewportRef.current;
            if (!canvas) return;
            const world = toWorld(e.clientX, e.clientY, canvas);
            const snapTarget = findSnapTarget(world.x, world.y);
            if (snapTarget) {
                commitConnection(snapTarget.nodeId, snapTarget.toPort, snapTarget.signalType);
                return;
            }
            cancelConnectionDrag();
        };
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp, { once: true });
        return () => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
        };
    }, [pendingConnection, updatePendingConnection, cancelConnectionDrag, commitConnection, viewportRef, nodes, connections]);

    const filteredCatalog = useMemo(() => {
        const q = menuSearch.trim().toLowerCase();
        const source = NODE_CATALOG.filter((item) => (item.type !== 'output' || !hasOutputNode));
        if (!q) return source;
        return source.filter((item) =>
            item.label.toLowerCase().includes(q)
            || item.type.toLowerCase().includes(q)
            || item.category.toLowerCase().includes(q)
            || item.keywords.some((k) => k.includes(q)),
        );
    }, [menuSearch, hasOutputNode]);

    useEffect(() => {
        setMenuIndex((idx) => Math.max(0, Math.min(idx, filteredCatalog.length - 1)));
    }, [filteredCatalog.length]);

    return (
        <div
            ref={viewportRef}
            className="flow-canvas"
            onContextMenu={handleContextMenu}
            onDoubleClick={(e) => {
                e.preventDefault();
                openMenuAtPointer(e.clientX, e.clientY);
            }}
            onPointerDown={(e) => {
                const target = e.target as HTMLElement;
                if (target.closest('[data-flow-connection-hit="true"]')) return;
                if (target.closest('.flow-context-menu') || target.closest('[data-flow-node-root]')) return;

                const panGesture = e.button === 1 || (e.button === 0 && (spacePressedRef.current || ctrlPressedRef.current || tool === 'hand'));
                if (panGesture) {
                    e.preventDefault();
                    const vp = viewportProxy.getViewport();
                    panStateRef.current = {
                        startX: e.clientX,
                        startY: e.clientY,
                        origX: vp.x,
                        origY: vp.y,
                    };
                    return;
                }

                if (e.button === 0) {
                    const canvas = viewportRef.current;
                    if (!canvas) return;
                    const world = toWorld(e.clientX, e.clientY, canvas);
                    setSelectionBoxUi({
                        startX: world.x,
                        startY: world.y,
                        currentX: world.x,
                        currentY: world.y,
                    });
                    clearSelection();
                }
            }}
            onPointerMove={(e) => {
                if (panStateRef.current) {
                    const st = panStateRef.current;
                    viewportProxy.setViewport({
                        ...viewportProxy.getViewport(),
                        x: st.origX + (e.clientX - st.startX),
                        y: st.origY + (e.clientY - st.startY),
                    });
                    return;
                }
                if (selectionBox) {
                    const canvas = viewportRef.current;
                    if (!canvas) return;
                    const world = toWorld(e.clientX, e.clientY, canvas);
                    setSelectionBoxUi((prev) => prev ? { ...prev, currentX: world.x, currentY: world.y } : prev);
                }
            }}
            onPointerUp={() => {
                if (panStateRef.current) {
                    panStateRef.current = null;
                }
                if (selectionBox) {
                    const x = Math.min(selectionBox.startX, selectionBox.currentX);
                    const y = Math.min(selectionBox.startY, selectionBox.currentY);
                    const width = Math.abs(selectionBox.currentX - selectionBox.startX);
                    const height = Math.abs(selectionBox.currentY - selectionBox.startY);
                    if (width > 4 || height > 4) {
                        setSelectionBox({ x, y, width, height });
                    }
                    setSelectionBoxUi(null);
                }
            }}
            onClick={(e) => {
                const target = e.target as HTMLElement;
                if (target.closest('[data-flow-connection-hit="true"]')) {
                    setMenuState(null);
                    return;
                }
                if (!target.closest('[data-flow-node-root]') && !target.closest('.flow-context-menu')) {
                    if (!selectionBox) clearSelection();
                }
                setMenuState(null);
            }}
            style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                overflow: 'hidden',
                backgroundColor: 'var(--color-bg-canvas)',
                cursor: panStateRef.current
                    ? 'grabbing'
                    : ((ctrlPressed || tool === 'hand') ? 'grab' : 'default'),
            }}
        >
            <CanvasGrid showOrigin={true} />
            <ConnectionsLayer />
            <NodesLayer interactionDisabled={ctrlPressed || tool === 'hand'} />
            {selectionBox && (
                <div
                    style={{
                        position: 'absolute',
                        left: Math.min(selectionBox.startX, selectionBox.currentX),
                        top: Math.min(selectionBox.startY, selectionBox.currentY),
                        width: Math.abs(selectionBox.currentX - selectionBox.startX),
                        height: Math.abs(selectionBox.currentY - selectionBox.startY),
                        transform: `translate(${viewportProxy.getViewport().x}px, ${viewportProxy.getViewport().y}px) scale(${viewportProxy.getViewport().zoom})`,
                        transformOrigin: '0 0',
                        background: 'color-mix(in srgb, var(--color-accent-primary) 18%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--color-accent-primary) 65%, transparent)',
                        pointerEvents: 'none',
                        zIndex: 9,
                    }}
                />
            )}
            <div
                style={{
                    position: 'absolute',
                    left: '50%',
                    bottom: 14,
                    transform: 'translateX(-50%)',
                    display: 'flex',
                    gap: 8,
                    padding: 6,
                    borderRadius: 10,
                    border: '1px solid color-mix(in srgb, var(--color-divider) 80%, transparent)',
                    background: 'color-mix(in srgb, var(--color-bg-panel) 92%, black 8%)',
                    zIndex: 20,
                    boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
                }}
            >
                <button
                    onClick={() => setTool('cursor')}
                    title="Cursor"
                    style={{
                        width: 32,
                        height: 28,
                        border: '1px solid color-mix(in srgb, var(--color-divider) 85%, transparent)',
                        borderRadius: 8,
                        background: tool === 'cursor' ? 'color-mix(in srgb, var(--color-accent-primary) 28%, transparent)' : 'transparent',
                        color: 'var(--color-text-primary)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                    }}
                >
                    <MousePointer2 size={14} />
                </button>
                <button
                    onClick={() => setTool('hand')}
                    title="Hand"
                    style={{
                        width: 32,
                        height: 28,
                        border: '1px solid color-mix(in srgb, var(--color-divider) 85%, transparent)',
                        borderRadius: 8,
                        background: tool === 'hand' ? 'color-mix(in srgb, var(--color-accent-primary) 28%, transparent)' : 'transparent',
                        color: 'var(--color-text-primary)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                    }}
                >
                    <Hand size={14} />
                </button>
            </div>

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
                    <div style={{ padding: 'var(--space-2) var(--space-3)', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-tertiary)', fontWeight: 'var(--font-weight-bold)', textTransform: 'uppercase', letterSpacing: 'var(--letter-spacing-wide)' }}>
                        Add Node
                    </div>
                    <input
                        ref={menuInputRef}
                        value={menuSearch}
                        onChange={(e) => { setMenuSearch(e.target.value); setMenuIndex(0); }}
                        placeholder="Search nodes..."
                        style={{
                            margin: '0 var(--space-2) var(--space-2)',
                            padding: 'var(--space-1-5) var(--space-2)',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid var(--color-divider)',
                            background: 'var(--color-bg-elevated)',
                            color: 'var(--color-text-primary)',
                            fontSize: 'var(--font-size-sm)',
                            outline: 'none',
                        }}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-0-5)', maxHeight: 360, overflowY: 'auto' }}>
                        {(() => {
                            // When searching, show flat list; otherwise group by category with headers
                            const isSearching = menuSearch.trim().length > 0;
                            const elements: React.ReactNode[] = [];
                            let lastCategory = '';
                            let globalIdx = 0;

                            for (const item of filteredCatalog) {
                                if (!isSearching && item.category !== lastCategory) {
                                    lastCategory = item.category;
                                    elements.push(
                                        <div
                                            key={`cat-${item.category}`}
                                            style={{
                                                padding: 'var(--space-1-5) var(--space-3)',
                                                fontSize: 'var(--font-size-xs)',
                                                color: 'var(--color-text-tertiary)',
                                                fontWeight: 'var(--font-weight-bold)',
                                                textTransform: 'uppercase',
                                                letterSpacing: 'var(--letter-spacing-wide)',
                                                fontFamily: 'var(--font-role-data)',
                                                borderTop: elements.length > 0 ? '1px solid var(--color-divider)' : 'none',
                                                marginTop: elements.length > 0 ? 'var(--space-1)' : '0',
                                                paddingTop: elements.length > 0 ? 'var(--space-2)' : 'var(--space-1-5)',
                                            }}
                                        >
                                            {item.category}
                                        </div>
                                    );
                                }
                                const currentIdx = globalIdx++;
                                elements.push(
                                    <button
                                        key={item.type}
                                        onClick={() => handleAddNode(item.type)}
                                        onMouseEnter={() => setMenuIndex(currentIdx)}
                                        style={{
                                            textAlign: 'left',
                                            padding: 'var(--space-2) var(--space-3)',
                                            background: currentIdx === menuIndex ? 'color-mix(in srgb, var(--color-accent-primary) 20%, transparent)' : 'transparent',
                                            border: 'none',
                                            color: 'var(--color-text-secondary)',
                                            cursor: 'pointer',
                                            borderRadius: 'var(--radius-lg)',
                                            transition: 'background var(--transition-fast), color var(--transition-fast)',
                                            fontWeight: 'var(--font-weight-medium)',
                                            fontSize: 'var(--font-size-md)',
                                        }}
                                    >
                                        {item.label}
                                    </button>
                                );
                            }
                            return elements;
                        })()}
                        {filteredCatalog.length === 0 && (
                            <div style={{ padding: 'var(--space-2) var(--space-3)', color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-sm)' }}>
                                No nodes found
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
