export interface ViewportState {
    x: number;
    y: number;
    zoom: number;
    isZooming?: boolean;
}

type ViewportListener = (viewport: ViewportState) => void;

class ViewportProxy {
    private viewport: ViewportState = { x: 0, y: 0, zoom: 1 };
    private listeners: Set<ViewportListener> = new Set();

    getViewport(): ViewportState {
        return this.viewport;
    }

    setViewport(viewport: ViewportState): void {
        const safeZoom = Number.isFinite(viewport.zoom) ? Math.min(3, Math.max(0.1, viewport.zoom)) : this.viewport.zoom;
        const safeX = Number.isFinite(viewport.x) ? viewport.x : this.viewport.x;
        const safeY = Number.isFinite(viewport.y) ? viewport.y : this.viewport.y;
        this.viewport = { ...viewport, x: safeX, y: safeY, zoom: safeZoom };
        // ENTERPRISE: Immediate notification - no batching delay
        // All DOM updates happen in the same frame for perfect sync
        this.listeners.forEach((listener) => listener(this.viewport));
    }

    reset(): void {
        this.setViewport({ x: 0, y: 0, zoom: 1 });
    }

    subscribe(listener: ViewportListener): () => void {
        this.listeners.add(listener);
        // Initial call with current state
        listener(this.viewport);
        return () => {
            this.listeners.delete(listener);
        };
    }
}

export const viewportProxy = new ViewportProxy();
