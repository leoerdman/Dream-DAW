import { useCallback, useRef, useEffect } from 'react';
import { viewportProxy } from '../lib/ViewportProxy';

export function useViewport() {
    const viewportRef = useRef<HTMLDivElement>(null);
    const spaceKeyPressed = useRef(false);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            const isTypingTarget = !!target && (
                target.tagName === 'INPUT'
                || target.tagName === 'TEXTAREA'
                || target.isContentEditable
            );
            if (isTypingTarget) return;
            if (e.code === 'Space' && !e.repeat) spaceKeyPressed.current = true;
        };
        const handleKeyUp = (e: KeyboardEvent) => {
            if (e.code === 'Space') spaceKeyPressed.current = false;
        };
        const handleBlur = () => {
            spaceKeyPressed.current = false;
        };
        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        window.addEventListener('blur', handleBlur);
        document.addEventListener('visibilitychange', handleBlur);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            window.removeEventListener('blur', handleBlur);
            document.removeEventListener('visibilitychange', handleBlur);
        };
    }, []);

    const pan = useCallback((dx: number, dy: number) => {
        const vp = viewportProxy.getViewport();
        viewportProxy.setViewport({
            ...vp,
            x: vp.x + dx,
            y: vp.y + dy
        });
    }, []);

    const zoomToPoint = useCallback((zoomDelta: number, mouseX: number, mouseY: number) => {
        const vp = viewportProxy.getViewport();
        const MIN_ZOOM = 0.1;
        const MAX_ZOOM = 3.0;

        const newZoom = Math.min(Math.max(vp.zoom * zoomDelta, MIN_ZOOM), MAX_ZOOM);
        if (newZoom === vp.zoom) return;

        // Calculate how much the mouse position relative to origin changes with the new zoom
        const zoomRatio = newZoom / vp.zoom;
        const newX = mouseX - (mouseX - vp.x) * zoomRatio;
        const newY = mouseY - (mouseY - vp.y) * zoomRatio;

        viewportProxy.setViewport({ x: newX, y: newY, zoom: newZoom });
    }, []);

    const handleWheel = useCallback((e: WheelEvent) => {
        const eventTarget = e.target instanceof HTMLElement ? e.target : null;
        if (eventTarget?.closest('.flow-context-menu')) return;

        let target = eventTarget;
        let isScrollable = false;
        const isTextInput = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');

        if (!isTextInput) {
            while (target && target !== viewportRef.current && !target.classList.contains('flow-canvas')) {
                if (target.scrollHeight > target.clientHeight) {
                    const style = window.getComputedStyle(target);
                    if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                        isScrollable = true;
                        break;
                    }
                }
                target = target.parentElement;
            }
            if (isScrollable) return;
        }

        e.preventDefault();

        const isZoom = e.ctrlKey || e.metaKey;

        if (isZoom) {
            const zoomFactor = Math.exp(-e.deltaY * 0.0018);
            const element = viewportRef.current;
            if (!element) return;

            const rect = element.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            zoomToPoint(zoomFactor, mouseX, mouseY);
        } else {
            const dx = -e.deltaX;
            const dy = -e.deltaY;
            pan(dx, dy);
        }
    }, [pan, zoomToPoint]);

    return { viewportRef, handleWheel, pan, zoomToPoint };
}
