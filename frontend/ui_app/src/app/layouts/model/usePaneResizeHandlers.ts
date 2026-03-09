import { useCallback } from 'react';
import {
    BOTTOM_PANEL_HEIGHT_MAX_PX,
    BOTTOM_PANEL_HEIGHT_MIN_PX,
    BROWSER_WIDTH_MAX_PX,
    BROWSER_WIDTH_MIN_PX,
} from '@/shared/config/layoutConstants';

type Args = {
    mainSplitRef: React.RefObject<HTMLElement | null>;
    setBrowserWidth: React.Dispatch<React.SetStateAction<number>>;
    setBottomPanelHeightPx: React.Dispatch<React.SetStateAction<number>>;
};

type Result = {
    beginBrowserResize: (e: React.PointerEvent<HTMLDivElement>) => void;
    beginBottomPanelResize: (e: React.PointerEvent<HTMLDivElement>) => void;
};

export function usePaneResizeHandlers({
    mainSplitRef,
    setBrowserWidth,
    setBottomPanelHeightPx,
}: Args): Result {
    const beginBrowserResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const splitRoot = mainSplitRef.current;
        if (!splitRoot) return;

        const rootRect = splitRoot.getBoundingClientRect();
        let rafId: number | null = null;
        let pendingWidth: number | null = null;
        let finished = false;

        const flushWidth = () => {
            rafId = null;
            if (pendingWidth === null) return;
            const nextWidth = pendingWidth;
            setBrowserWidth((prev) => (prev === nextWidth ? prev : nextWidth));
        };

        // ENTERPRISE FIX (Phase 33): Use pointer events exclusively.
        // Previously had BOTH mousemove AND pointer listeners — causing
        // onUp to fire twice per release (guarded by `finished` flag but wasteful).
        const onMove = (me: PointerEvent) => {
            const nextWidth = Math.max(BROWSER_WIDTH_MIN_PX, Math.min(BROWSER_WIDTH_MAX_PX, Math.round(me.clientX - rootRect.left)));
            pendingWidth = nextWidth;
            if (rafId === null) {
                rafId = window.requestAnimationFrame(flushWidth);
            }
        };

        const onUp = () => {
            if (finished) return;
            finished = true;
            if (rafId !== null) {
                window.cancelAnimationFrame(rafId);
                rafId = null;
            }
            flushWidth();
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            window.removeEventListener('blur', onUp);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };

        const onVisibilityChange = () => {
            if (document.visibilityState !== 'visible') {
                onUp();
            }
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        window.addEventListener('blur', onUp);
        document.addEventListener('visibilitychange', onVisibilityChange);
    }, [mainSplitRef, setBrowserWidth]);

    const beginBottomPanelResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const minHeight = BOTTOM_PANEL_HEIGHT_MIN_PX;
        const maxHeight = Math.min(BOTTOM_PANEL_HEIGHT_MAX_PX, Math.round(window.innerHeight * 0.72));

        let rafId: number | null = null;
        let pendingHeight: number | null = null;
        const root = document.documentElement;
        const prevCursor = document.body.style.cursor;
        document.body.style.cursor = 'ns-resize';
        window.dispatchEvent(new Event('dream:bottom-panel-resize-start'));

        const flushHeight = () => {
            rafId = null;
            if (pendingHeight == null) return;
            root.style.setProperty('--daw-bottom-panel-height', `${pendingHeight}px`);
        };

        const onMove = (me: PointerEvent) => {
            const nextHeight = Math.max(minHeight, Math.min(maxHeight, window.innerHeight - me.clientY));
            pendingHeight = nextHeight;
            if (rafId == null) {
                rafId = window.requestAnimationFrame(flushHeight);
            }
        };

        let finished = false;
        const onUp = () => {
            if (finished) return;
            finished = true;
            if (rafId != null) {
                window.cancelAnimationFrame(rafId);
                rafId = null;
            }
            flushHeight();
            const finalHeight = pendingHeight;
            if (finalHeight != null) {
                setBottomPanelHeightPx((prev) => (prev === finalHeight ? prev : finalHeight));
            }
            document.body.style.cursor = prevCursor;
            window.dispatchEvent(new Event('dream:bottom-panel-resize-end'));
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            window.removeEventListener('blur', onUp);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };

        const onVisibilityChange = () => {
            if (document.visibilityState !== 'visible') {
                onUp();
            }
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        window.addEventListener('blur', onUp);
        document.addEventListener('visibilitychange', onVisibilityChange);
    }, [setBottomPanelHeightPx]);

    return {
        beginBrowserResize,
        beginBottomPanelResize,
    };
}
