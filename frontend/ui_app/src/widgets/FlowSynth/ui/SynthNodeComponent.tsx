import React from 'react';
import { useFlowSynthStore } from '../model/useFlowSynthStore';
import type { SynthNode } from '../model/useFlowSynthStore';
import {
    PORT_REGISTRY,
    FLOW_PORT_ROW_HEIGHT,
    FLOW_NODE_HEADER_HEIGHT,
    FLOW_NODE_BODY_PADDING,
    // BUG-032/054 FIX: Import layout constants from SSOT instead of defining locally.
    FLOW_NODE_WIDTH,
    FLOW_GRID_SNAP,
    portCenterY,
    type PortDefinition,
    type SynthNodeType,
} from '../model/portRegistry';
// BUG-032 FIX: Re-export for backward compatibility with existing consumers.
export { FLOW_NODE_WIDTH } from '../model/portRegistry';
import { viewportProxy } from '../lib/ViewportProxy';
import {
    FLOW_PORT_DOT_SIZE,
    signalColor,
    nodeShellStyle,
    selectionOverlayStyle,
    nodeHeaderStyle,
    nodeTypeDotStyle,
    nodeTitleStyle,
    portLabelStyle,
} from './FlowNodeStyles';
import { OscillatorControls } from './nodes/OscillatorControls';
import { FilterControls } from './nodes/FilterControls';
import { EnvelopeControls } from './nodes/EnvelopeControls';
import { EqControls } from './nodes/EqControls';
import { AutoFilterControls } from './nodes/AutoFilterControls';
import { ReverseControls } from './nodes/ReverseControls';
import { OutputControls } from './nodes/OutputControls';
import { MidiInControls } from './nodes/MidiInControls';
import { nodeMotionProxy } from '../lib/NodeMotionProxy';
import { LfoControls } from './nodes/LfoControls';
import { NoiseControls } from './nodes/NoiseControls';
import { UtilityControls } from './nodes/UtilityControls';
import { DelayControls } from './nodes/DelayControls';
import { DistortionControls } from './nodes/DistortionControls';
import { Vst3Controls } from './nodes/Vst3Controls';

import { PortRowFader } from './nodes/PortRowFader';

interface Props {
    node: SynthNode;
    interactionDisabled?: boolean;
}

// ── ENTERPRISE: Named constants ────────────────────────────────────────────
/** Port dot hover scale factors. */
const PORT_DOT_HOVER_SCALE = 'scale(1.35)';
const PORT_DOT_TARGET_SCALE = 'scale(1.15)';
/** Port dot box-shadow radii. */
const PORT_DOT_HOVER_SHADOW_PX = 14;
const PORT_DOT_TARGET_SHADOW_PX = 10;
const PORT_DOT_DEFAULT_SHADOW_PX = 5;
const PORT_DOT_BORDER_WIDTH = 2;
/** Port label offset from dot edge. */
const PORT_LABEL_OFFSET = 6;
const PORT_LABEL_VERTICAL_OFFSET = 7;
/** Inline fader inset from dot edges. */
const PORT_FADER_INSET = 10;
const PORT_FADER_HEIGHT = 20;
const PORT_FADER_LABEL_GAP = 4;
const PORT_FADER_LABEL_MIN_WIDTH = 22;

// ── Per-type controls renderer ─────────────────────────────────
// Only renders non-port controls (dropdowns, visualizers).
// Slider parameters are now inline port faders in the port row zone.
function NodeControlsBody({ node }: { node: SynthNode }) {
    switch (node.type) {
        case 'oscillator':
            return <OscillatorControls node={node} />;
        case 'filter':
            return <FilterControls node={node} />;
        case 'envelope':
            return <EnvelopeControls node={node} />;
        case 'eq':
            return <EqControls node={node} />;
        case 'autofilter':
            return <AutoFilterControls node={node} />;
        case 'reverse':
            return <ReverseControls node={node} />;
        case 'output':
            return <OutputControls node={node} />;
        case 'midiIn':
            return <MidiInControls node={node} />;
        case 'lfo':
            return <LfoControls node={node} />;
        case 'noise':
            return <NoiseControls node={node} />;
        case 'delay':
            return <DelayControls node={node} />;
        case 'mixer':
        case 'vca':
        case 'multiply':
            return null;
        case 'utility':
            return <UtilityControls node={node} />;
        case 'distortion':
            return <DistortionControls node={node} />;
        case 'vst3':
            return <Vst3Controls node={node} />;
        // Stateless nodes with no additional controls:
        case 'add':
        case 'sampleHold':
        case 'audioIn':
        case 'pitch':
        default:
            return null;
    }
}

// ── Single Port Dot ────────────────────────────────────────────
function PortDot({
    port,
    side,
    index,
    nodeId,
    interactionDisabled,
}: {
    port: PortDefinition;
    side: 'in' | 'out';
    index: number;
    nodeId: string;
    interactionDisabled: boolean;
}) {
    // BUG-022 FIX: Single merged selector instead of 4 separate subscriptions.
    // Reduces subscription overhead from 4 per PortDot × M ports × N nodes to 1 per PortDot.
    const { startConnectionDrag, commitConnection, isDragging, dragType } = useFlowSynthStore((s) => ({
        startConnectionDrag: s.startConnectionDrag,
        commitConnection: s.commitConnection,
        isDragging: s.pendingConnection !== null,
        dragType: s.pendingConnection?.signalType,
    }));


    const cy = portCenterY(index);
    // ENTERPRISE: Pass actual port type as signalType — enables per-type cable colors (Bitwig Grid pattern)
    const signalType = port.type as 'audio' | 'midi' | 'control' | 'gate' | 'phase';

    const dotColor = signalColor(port.type);

    const dotSize = FLOW_PORT_DOT_SIZE;

    const handlePointerDown = (e: React.PointerEvent) => {
        if (side !== 'out' || interactionDisabled) return;
        e.stopPropagation();
        e.preventDefault();

        const node = useFlowSynthStore.getState().nodes.find((n) => n.id === nodeId);
        if (!node) return;
        const px = node?.position?.x ?? 0;
        const py = node?.position?.y ?? 0;

        const startX = px + FLOW_NODE_WIDTH;
        const startY = py + FLOW_NODE_HEADER_HEIGHT + cy;

        startConnectionDrag({
            fromNode: nodeId,
            fromPort: port.id,
            signalType,
            startX,
            startY,
        });
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        if (side !== 'in' || !isDragging || interactionDisabled) return;
        e.stopPropagation();
        commitConnection(nodeId, port.id, signalType);
    };

    // ENTERPRISE: Port hover state for scale + glow effect (UDS FlowPort pattern)
    const [isHovered, setIsHovered] = React.useState(false);

    // ENTERPRISE FIX: Strict port matching. No exceptions.
    const isCompatibleTarget = isDragging && side === 'in' && dragType === signalType;
    const showTargetGlow = isCompatibleTarget && !isHovered;



    // ENTERPRISE: Filled circle = output (produces signal), outlined = input (receives signal)
    // Matches Bitwig Grid convention for intuitive I/O distinction.
    const isFilled = true;

    return (
        <div
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerEnter={() => setIsHovered(true)}
            onPointerLeave={() => setIsHovered(false)}
            style={{
                position: 'absolute',
                [side === 'in' ? 'left' : 'right']: -(dotSize / 2),
                top: cy - dotSize / 2,
                width: dotSize,
                height: dotSize,
                borderRadius: '50%',
                transform: isHovered
                    ? PORT_DOT_HOVER_SCALE
                    : showTargetGlow
                        ? PORT_DOT_TARGET_SCALE
                        : 'none',
                backgroundColor: isFilled ? dotColor : 'transparent',
                border: `${PORT_DOT_BORDER_WIDTH}px solid ${dotColor}`,
                cursor: interactionDisabled ? 'default' : 'crosshair',
                boxShadow: isHovered
                    ? `0 0 ${PORT_DOT_HOVER_SHADOW_PX}px ${dotColor}, 0 0 4px rgba(255,255,255,0.4)`
                    : showTargetGlow
                        ? `0 0 ${PORT_DOT_TARGET_SHADOW_PX}px ${dotColor}`
                        : `0 0 ${PORT_DOT_DEFAULT_SHADOW_PX}px ${dotColor}`,
                transition: 'transform var(--transition-fast) cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow var(--transition-fast)',
                zIndex: isHovered ? 10 : 5,
            }}
        />
    );
}

// ── Port Label ─────────────────────────────────────────────────
function PortLabel({
    port,
    side,
    index,
}: {
    port: PortDefinition;
    side: 'in' | 'out';
    index: number;
}) {
    // Skip label for input ports that have inline faders (fader occupies that space)
    if (side === 'in' && port.fader) return null;
    const cy = portCenterY(index);
    return (
        <span
            style={{
                ...portLabelStyle,
                [side === 'in' ? 'left' : 'right']: FLOW_PORT_DOT_SIZE / 2 + PORT_LABEL_OFFSET,
                top: cy - PORT_LABEL_VERTICAL_OFFSET,
            }}
        >
            {port.label}
        </span>
    );
}

// ── Inline Port Fader ──────────────────────────────────────────
function InlinePortFader({
    port,
    index,
    node,
}: {
    port: PortDefinition;
    index: number;
    node: SynthNode;
}) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);
    if (!port.fader) return null;

    const fader = port.fader;
    const value = Number(node.data?.[fader.dataKey] ?? fader.default ?? fader.min);
    const cy = portCenterY(index);

    return (
        <div
            style={{
                position: 'absolute',
                left: FLOW_PORT_DOT_SIZE / 2 + PORT_FADER_INSET,
                right: FLOW_PORT_DOT_SIZE / 2 + PORT_FADER_INSET,
                top: cy - PORT_FADER_HEIGHT / 2,
                height: PORT_FADER_HEIGHT,
                display: 'flex',
                alignItems: 'center',
            }}
        >
            <span style={{
                ...portLabelStyle,
                position: 'static',
                fontSize: 'var(--font-size-2xs)',
                marginRight: PORT_FADER_LABEL_GAP,
                flexShrink: 0,
                minWidth: PORT_FADER_LABEL_MIN_WIDTH,
            }}>
                {port.label}
            </span>
            <PortRowFader
                nodeId={node.id}
                portId={fader.dataKey}
                value={value}
                config={fader}
                onChange={(v) => updateNodeData(node.id, { [fader.dataKey]: v })}
            />
        </div>
    );
}

export const SynthNodeComponent = React.memo(function SynthNodeComponentBase({ node, interactionDisabled = false }: Props) {
    const updateNodePosition = useFlowSynthStore((s) => s.updateNodePosition);
    const selectNode = useFlowSynthStore((s) => s.selectNode);
    // ENTERPRISE FIX: Direct boolean selector prevents O(N) re-renders across all nodes when selection changes
    const isSelected = useFlowSynthStore((s) => s.selectedNodeIds.includes(node.id));
    const nodeRef = React.useRef<HTMLDivElement>(null);

    // ENTERPRISE: Sync proxy to React prop on mount/change, allowing proxy to take over during drag 
    React.useLayoutEffect(() => {
        const px = node.position?.x ?? 0;
        const py = node.position?.y ?? 0;
        nodeMotionProxy.syncInitial(node.id, px, py);
        if (nodeRef.current) {
            nodeRef.current.style.transform = `translate(${px}px, ${py}px)`;
        }
    }, [node.position?.x, node.position?.y, node.id]);

    const config = PORT_REGISTRY[node.type as SynthNodeType];
    if (!config) return null;

    const maxPorts = Math.max(config.inputs.length, config.outputs.length, 1);
    const portsHeight = maxPorts * FLOW_PORT_ROW_HEIGHT;

    const handlePointerDown = (e: React.PointerEvent) => {
        if (e.button !== 0 || interactionDisabled) return;
        e.stopPropagation();
        const handle = e.currentTarget as HTMLElement;
        handle.setPointerCapture?.(e.pointerId);
        handle.style.cursor = 'grabbing';

        const startX = e.clientX;
        const startY = e.clientY;
        const startNodeX = node.position?.x ?? 0;
        const startNodeY = node.position?.y ?? 0;
        const zoom = viewportProxy.getViewport().zoom;
        let raf = 0;
        let pendingX = startNodeX;
        let pendingY = startNodeY;

        // BUG-B FIX: Capture ALL selected nodes at drag start for multi-node drag.
        // If this node is selected, move ALL selected nodes together.
        const { selectedNodeIds: _selIds, nodes: allNodes } = useFlowSynthStore.getState();
        const isMultiDrag = _selIds.includes(node.id) && _selIds.length > 1;
        // Snapshot starting positions of ALL co-dragged nodes (excluding the primary dragged node)
        const coNodes = isMultiDrag
            ? _selIds
                .filter(id => id !== node.id)
                .map(id => {
                    const n = allNodes.find(nd => nd.id === id);
                    return n ? { id: n.id, startX: n.position?.x ?? 0, startY: n.position?.y ?? 0 } : null;
                })
                .filter(Boolean) as Array<{ id: string; startX: number; startY: number }>
            : [];

        const onMove = (me: PointerEvent) => {
            const dx = (me.clientX - startX) / zoom;
            const dy = (me.clientY - startY) / zoom;
            pendingX = startNodeX + dx;
            pendingY = startNodeY + dy;

            // Publish primary dragged node
            nodeMotionProxy.publish(node.id, pendingX, pendingY);

            // BUG-B FIX: Publish ALL co-selected nodes with same delta
            for (const co of coNodes) {
                nodeMotionProxy.publish(co.id, co.startX + dx, co.startY + dy);
            }

            if (raf !== 0) return;
            raf = requestAnimationFrame(() => {
                raf = 0;
                // Move primary node
                if (nodeRef.current) {
                    nodeRef.current.style.transform = `translate(${pendingX}px, ${pendingY}px)`;
                }
                // BUG-B FIX: Move all co-selected node DOM elements
                for (const co of coNodes) {
                    const coX = co.startX + (pendingX - startNodeX);
                    const coY = co.startY + (pendingY - startNodeY);
                    // Find co-node's DOM element via data attribute
                    const el = document.querySelector(`[data-flow-node-id="${co.id}"]`) as HTMLElement | null;
                    if (el) {
                        el.style.transform = `translate(${coX}px, ${coY}px)`;
                    }
                }
            });
        };

        const onUp = () => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onUp);
            handle.removeEventListener('lostpointercapture', onUp);
            handle.style.cursor = 'grab';
            if (raf !== 0) {
                cancelAnimationFrame(raf);
                raf = 0;
            }
            // Commit primary node with grid snap
            const snapX = Math.round(pendingX / FLOW_GRID_SNAP) * FLOW_GRID_SNAP;
            const snapY = Math.round(pendingY / FLOW_GRID_SNAP) * FLOW_GRID_SNAP;
            updateNodePosition(node.id, snapX, snapY);

            // BUG-B FIX: Commit ALL co-selected nodes with grid snap
            const dx = pendingX - startNodeX;
            const dy = pendingY - startNodeY;
            for (const co of coNodes) {
                const coSnapX = Math.round((co.startX + dx) / FLOW_GRID_SNAP) * FLOW_GRID_SNAP;
                const coSnapY = Math.round((co.startY + dy) / FLOW_GRID_SNAP) * FLOW_GRID_SNAP;
                updateNodePosition(co.id, coSnapX, coSnapY);
            }
        };

        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onUp);
        handle.addEventListener('lostpointercapture', onUp);
    };

    return (
        <div
            ref={nodeRef}
            data-flow-node-root="true"
            data-flow-node-id={node.id}
            onMouseDown={(e) => {
                if (interactionDisabled) return;
                e.stopPropagation();
                selectNode(node.id, e.metaKey || e.ctrlKey || e.shiftKey);
            }}
            style={{
                ...nodeShellStyle,
                width: FLOW_NODE_WIDTH,
                pointerEvents: interactionDisabled ? 'none' : 'auto',
                zIndex: isSelected ? 50 : 10,
            }}
        >
            {/* ── SELECTION OVERLAY (UDS ::after pattern) ── */}
            {isSelected && <div style={selectionOverlayStyle} />}

            {/* ── HEADER ── */}
            <div
                onPointerDown={handlePointerDown}
                style={{
                    ...nodeHeaderStyle,
                    cursor: interactionDisabled ? 'default' : 'grab',
                    height: FLOW_NODE_HEADER_HEIGHT,
                }}
            >
                <div style={{
                    ...nodeTypeDotStyle,
                    backgroundColor: config.color,
                    boxShadow: `0 0 8px ${config.color}`,
                }} />
                <span style={nodeTitleStyle}>
                    {config.title}
                </span>
            </div>

            {/* ── PORTS ZONE ── */}
            <div style={{
                position: 'relative',
                height: portsHeight,
                flexShrink: 0,
            }}>
                {/* Input ports (left) */}
                {config.inputs.map((port, idx) => (
                    <React.Fragment key={`in-${port.id}`}>
                        <PortDot port={port} side="in" index={idx} nodeId={node.id} interactionDisabled={interactionDisabled} />
                        <PortLabel port={port} side="in" index={idx} />
                        <InlinePortFader port={port} index={idx} node={node} />
                    </React.Fragment>
                ))}
                {/* Output ports (right) */}
                {config.outputs.map((port, idx) => (
                    <React.Fragment key={`out-${port.id}`}>
                        <PortDot port={port} side="out" index={idx} nodeId={node.id} interactionDisabled={interactionDisabled} />
                        <PortLabel port={port} side="out" index={idx} />
                    </React.Fragment>
                ))}
            </div>

            {/* ── CONTROLS ── */}
            <NodeControlsBody node={node} />

            {/* ── FOOTER PAD ── */}
            <div style={{ height: FLOW_NODE_BODY_PADDING }} />
        </div >
    );
});
