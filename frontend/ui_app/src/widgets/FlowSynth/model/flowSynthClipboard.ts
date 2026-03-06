import type { SynthNode, SynthConnection } from './useFlowSynthStore';

export interface FlowClipboardData {
    nodes: SynthNode[];
    internalConnections: SynthConnection[];
    incomingConnections: SynthConnection[];
    anchorX: number;
    anchorY: number;
}

/**
 * ENTERPRISE: Module-level clipboard for Flow Synth.
 * Allows copying nodes from one track's synth and pasting them into another's,
 * matching the behavior of top-tier DAWs.
 */
export let flowModuleClipboard: FlowClipboardData | null = null;

export function setFlowModuleClipboard(data: FlowClipboardData | null) {
    flowModuleClipboard = data;
}
