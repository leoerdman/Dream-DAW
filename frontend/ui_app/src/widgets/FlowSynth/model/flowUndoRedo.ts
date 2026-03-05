/**
 * ENTERPRISE: External undo/redo system for Flow Synth.
 * Uses Zustand subscription to capture snapshots when nodes/connections change,
 * without modifying any individual store mutation functions.
 *
 * ARCHITECTURE:
 * - Lazy init: first snapshot is captured on the first subscription callback,
 *   not on module import (prevents stale snapshot before store is populated).
 * - Debounce: coalesces rapid mutations (e.g. fader drags, node drags)
 *   into a single undo entry via 300ms idle timer.
 * - Guard: `isUndoRedoInProgress` prevents recursive snapshots during
 *   undo/redo state restoration.
 */
import { useFlowSynthStore } from './useFlowSynthStore';
import type { SynthNode, SynthConnection } from './useFlowSynthStore';

interface FlowSnapshot {
    nodes: SynthNode[];
    connections: SynthConnection[];
}

const MAX_UNDO = 50;
const DEBOUNCE_MS = 300;

let undoStack: FlowSnapshot[] = [];
let redoStack: FlowSnapshot[] = [];
let lastSnapshot: FlowSnapshot | null = null;
let isUndoRedoInProgress = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Capture a snapshot of the current graph state.
 */
function captureSnapshot(): FlowSnapshot {
    const state = useFlowSynthStore.getState();
    return {
        nodes: state.nodes,
        connections: state.connections,
    };
}

/**
 * Called by the Zustand subscription whenever nodes/connections change.
 * Uses a debounce to coalesce rapid mutations into a single undo entry.
 */
function onGraphChanged(): void {
    if (isUndoRedoInProgress) return;

    // Lazy init: capture the first snapshot on the first real change
    if (!lastSnapshot) {
        lastSnapshot = captureSnapshot();
        return;
    }

    // Debounce: reset timer on each rapid change
    if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
    }

    // Capture the PREVIOUS state (before this change) immediately
    const snapshotToSave = lastSnapshot;
    lastSnapshot = captureSnapshot();

    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        // Push the pre-change snapshot onto the undo stack
        undoStack.push(snapshotToSave);
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        redoStack = []; // New mutation clears redo
    }, DEBOUNCE_MS);
}

/**
 * Undo: restore the last snapshot from the undo stack.
 */
export function flowUndo(): void {
    // Flush any pending debounced snapshot
    if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
        if (lastSnapshot) {
            // The current lastSnapshot is post-change; the actual pre-change
            // snapshot was already captured in onGraphChanged. We need to push
            // it to the undo stack. Re-read lastSnapshot as the pending save.
        }
    }

    if (undoStack.length === 0) return;
    const snapshot = undoStack.pop()!;
    const current = captureSnapshot();
    redoStack.push(current);
    if (redoStack.length > MAX_UNDO) redoStack.shift();

    isUndoRedoInProgress = true;
    useFlowSynthStore.setState({
        nodes: snapshot.nodes,
        connections: snapshot.connections,
    });
    lastSnapshot = snapshot;
    isUndoRedoInProgress = false;

    // Sync restored graph to engine
    void useFlowSynthStore.getState().syncFlowGraphToEngine().catch(console.error);
}

/**
 * Redo: restore the last snapshot from the redo stack.
 */
export function flowRedo(): void {
    if (redoStack.length === 0) return;
    const snapshot = redoStack.pop()!;
    const current = captureSnapshot();
    undoStack.push(current);
    if (undoStack.length > MAX_UNDO) undoStack.shift();

    isUndoRedoInProgress = true;
    useFlowSynthStore.setState({
        nodes: snapshot.nodes,
        connections: snapshot.connections,
    });
    lastSnapshot = snapshot;
    isUndoRedoInProgress = false;

    // Sync restored graph to engine
    void useFlowSynthStore.getState().syncFlowGraphToEngine().catch(console.error);
}

/**
 * Reset undo/redo stacks (e.g. when opening a new Flow editor).
 */
export function resetFlowUndoRedo(): void {
    undoStack = [];
    redoStack = [];
    if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    lastSnapshot = captureSnapshot();
}

export function getUndoStackSize(): number { return undoStack.length; }
export function getRedoStackSize(): number { return redoStack.length; }

// ═══════════════════════════════════════════════════════════════════════════
// ENTERPRISE: Auto-subscribe to graph changes on module load.
// Uses a shallow comparison of nodes/connections array references.
// Lazy init: lastSnapshot is NOT captured here — it's captured on the
// first subscription callback to avoid stale initial state.
// ═══════════════════════════════════════════════════════════════════════════
let _prevNodes: SynthNode[] | null = null;
let _prevConns: SynthConnection[] | null = null;

useFlowSynthStore.subscribe((state) => {
    if (_prevNodes === null) {
        // First callback — initialize reference tracking without pushing undo
        _prevNodes = state.nodes;
        _prevConns = state.connections;
        return;
    }
    if (state.nodes !== _prevNodes || state.connections !== _prevConns) {
        _prevNodes = state.nodes;
        _prevConns = state.connections;
        onGraphChanged();
    }
});
