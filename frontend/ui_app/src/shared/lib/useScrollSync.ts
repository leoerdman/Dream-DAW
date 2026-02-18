/**
 * ═══════════════════════════════════════════════════════════════════════
 * Enterprise Scroll Sync — Zero React Re-render Synchronization
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Synchronizes vertical scroll between Timeline (canvas), TrackInspector
 * (DOM scrollable), and any other panel that needs scroll alignment.
 *
 * **KEY DESIGN**: Uses vanilla JS event emitter + refs. NO React state,
 * NO React re-renders. Listeners directly manipulate DOM scrollTop /
 * canvas viewport. This keeps scroll at native 60fps+ performance.
 *
 * Usage:
 *   scrollSync.setScrollY(100, 'timeline');  // from Timeline
 *   scrollSync.subscribe('inspector', (y) => { el.scrollTop = y; });
 */

export type ScrollSource = 'timeline' | 'inspector' | 'mixer' | 'external';

type ScrollListener = (scrollY: number) => void;

interface Subscription {
    source: ScrollSource;
    listener: ScrollListener;
}

class ScrollSyncManager {
    private _scrollY = 0;
    private _subscribers: Subscription[] = [];

    /** Current scroll position (read without triggering React). */
    get scrollY(): number {
        return this._scrollY;
    }

    /**
     * Update scroll position and notify all listeners EXCEPT the source.
     * This prevents echo loops: if Timeline scrolls, it notifies Inspector
     * but not itself.
     */
    setScrollY(value: number, source: ScrollSource): void {
        if (Math.abs(value - this._scrollY) < 0.5) return; // dead-zone
        this._scrollY = value;
        for (const sub of this._subscribers) {
            if (sub.source !== source) {
                sub.listener(value);
            }
        }
    }

    /**
     * Subscribe to scroll changes. Returns an unsubscribe function.
     * @param source — identifies this subscriber. Events from the same
     *                 source are suppressed (echo prevention).
     * @param listener — called with the new scrollY value.
     */
    subscribe(source: ScrollSource, listener: ScrollListener): () => void {
        const sub: Subscription = { source, listener };
        this._subscribers.push(sub);
        return () => {
            const idx = this._subscribers.indexOf(sub);
            if (idx >= 0) this._subscribers.splice(idx, 1);
        };
    }
}

/** Singleton scroll sync manager — shared across all panels. */
export const scrollSync = new ScrollSyncManager();
