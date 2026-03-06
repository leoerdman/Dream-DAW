// lib/NodeMotionProxy.ts
// ENTERPRISE: Zero-React DOM Updates.
// This pub/sub proxy allows components (like ConnectionsLayer) to subscribe directly
// to node dragged coordinates bypassing React's render cycle entirely.
// This allows silky-smooth 120 FPS dragging without re-calculating the entire
// node graph inside Zustand on every frame.

type MotionSubscriber = (pos: { x: number; y: number }) => void;

class MotionProxy {
    private subscribers = new Map<string, Set<MotionSubscriber>>();
    private positions = new Map<string, { x: number; y: number }>();

    /**
     * Subscribe to a node's motion events.
     * @returns A cleanup function to unsubscribe.
     */
    subscribe(nodeId: string, callback: MotionSubscriber): () => void {
        if (!this.subscribers.has(nodeId)) {
            this.subscribers.set(nodeId, new Set());
        }
        this.subscribers.get(nodeId)!.add(callback);

        // Immediately fire with current known position if available
        const currentPos = this.positions.get(nodeId);
        if (currentPos) {
            callback(currentPos);
        }

        return () => {
            const subs = this.subscribers.get(nodeId);
            if (subs) {
                subs.delete(callback);
                if (subs.size === 0) {
                    this.subscribers.delete(nodeId);
                }
            }
        };
    }

    /**
     * Publish a new position. Called directly by the pointermove handler.
     */
    publish(nodeId: string, x: number, y: number) {
        const pos = { x, y };
        this.positions.set(nodeId, pos);
        const subs = this.subscribers.get(nodeId);
        if (subs) {
            subs.forEach(cb => cb(pos));
        }
    }

    /**
     * Get the current synchronous position without subscribing.
     */
    getPosition(nodeId: string): { x: number; y: number } | undefined {
        return this.positions.get(nodeId);
    }

    /**
     * Syncs an initial position (usually from React props on mount)
     * without triggering subscribers.
     */
    syncInitial(nodeId: string, x: number, y: number) {
        if (!this.positions.has(nodeId) ||
            this.positions.get(nodeId)?.x !== x ||
            this.positions.get(nodeId)?.y !== y) {
            this.positions.set(nodeId, { x, y });
        }
    }

    /**
     * ENTERPRISE FIX (#7): Remove a node's position and subscribers.
     * Called when a node is deleted to prevent unbounded Map growth.
     */
    removeNode(nodeId: string) {
        this.positions.delete(nodeId);
        this.subscribers.delete(nodeId);
    }
    /**
     * ENTERPRISE: Clear only position cache.
     * Subscribers (owned by mounted React components) must NOT be destroyed.
     * React manages subscriber lifecycle via useEffect cleanup.
     * Clearing subscribers kills connection drag-following for mounted connections.
     */
    clearPositions() {
        this.positions.clear();
    }

    /**
     * @deprecated Use clearPositions() instead.
     * clearAll() was destroying active subscribers, causing connections
     * to stop following node drags.
     */
    clearAll() {
        this.positions.clear();
        // DO NOT clear subscribers — they are managed by React useEffect cleanup.
        // Clearing them here destroys active FlowConnectionComponent subscriptions.
    }

    /**
     * BUG-058 FIX: Full cleanup for HMR / module reload.
     * Unlike clearAll(), this IS safe to call during hot reload since all
     * React components will re-mount and re-subscribe.
     */
    dispose() {
        this.positions.clear();
        this.subscribers.clear();
    }
}

export const nodeMotionProxy = new MotionProxy();

// BUG-058 FIX: Clean up on HMR to prevent subscriber accumulation in dev mode.
if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        nodeMotionProxy.dispose();
    });
}
