import { useCallback } from 'react';

const DEFAULT_BOTTOM_PANEL_HEIGHT = 220;

type Args = {
    mainSplitRef: React.RefObject<HTMLElement | null>;
    setBrowserWidth: React.Dispatch<React.SetStateAction<number>>;
    setBottomPanelHeightPx: React.Dispatch<React.SetStateAction<number>>;
};

type Result = {
    beginBrowserResize: (e: React.MouseEvent<HTMLDivElement>) => void;
    beginBottomPanelResize: (e: React.MouseEvent<HTMLDivElement>) => void;
};

export function usePaneResizeHandlers({
    mainSplitRef,
    setBrowserWidth,
    setBottomPanelHeightPx,
}: Args): Result {
    const beginBrowserResize = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        const splitRoot = mainSplitRef.current;
        if (!splitRoot) return;

        const rootRect = splitRoot.getBoundingClientRect();
        let rafId: number | null = null;
        let pendingWidth: number | null = null;

        const flushWidth = () => {
            rafId = null;
            if (pendingWidth === null) return;
            const nextWidth = pendingWidth;
            setBrowserWidth((prev) => (prev === nextWidth ? prev : nextWidth));
        };

        const onMove = (me: MouseEvent) => {
            const nextWidth = Math.max(240, Math.min(520, Math.round(me.clientX - rootRect.left)));
            pendingWidth = nextWidth;
            if (rafId === null) {
                rafId = window.requestAnimationFrame(flushWidth);
            }
        };

        const onUp = () => {
            if (rafId !== null) {
                window.cancelAnimationFrame(rafId);
                rafId = null;
            }
            flushWidth();
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [mainSplitRef, setBrowserWidth]);

    const beginBottomPanelResize = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        const minHeight = DEFAULT_BOTTOM_PANEL_HEIGHT;
        const maxHeight = Math.round(window.innerHeight * 0.72);

        let rafId: number | null = null;
        let pendingHeight: number | null = null;

        const flushHeight = () => {
            rafId = null;
            if (pendingHeight == null) return;
            const nextHeight = pendingHeight;
            setBottomPanelHeightPx((prev) => (prev === nextHeight ? prev : nextHeight));
        };

        const onMove = (me: MouseEvent) => {
            const nextHeight = Math.max(minHeight, Math.min(maxHeight, window.innerHeight - me.clientY));
            pendingHeight = nextHeight;
            if (rafId == null) {
                rafId = window.requestAnimationFrame(flushHeight);
            }
        };

        const onUp = () => {
            if (rafId != null) {
                window.cancelAnimationFrame(rafId);
                rafId = null;
            }
            flushHeight();
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [setBottomPanelHeightPx]);

    return {
        beginBrowserResize,
        beginBottomPanelResize,
    };
}
