import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveKnobDragScalePx } from './StandardPluginControlUtils';

type UsePluginKnobDragArgs = {
    paramName: string;
    value: number;
    quantizeValue: (raw: number) => number;
    valueToUnit: (value: number) => number;
    unitToValue: (unit: number) => number;
    onChange: (paramName: string, value: number) => void;
    onGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onGestureEnd?: (paramName: string) => void;
};

export function usePluginKnobDrag(args: UsePluginKnobDragArgs) {
    const {
        paramName,
        value,
        quantizeValue,
        valueToUnit,
        unitToValue,
        onChange,
        onGestureStart,
        onGestureEnd,
    } = args;

    const [isDragging, setIsDragging] = useState(false);
    const dragPointerIdRef = useRef<number | null>(null);

    const dragStartYRef = useRef(0);
    const dragStartUnitRef = useRef(0);
    const dialRef = useRef<HTMLDivElement | null>(null);

    const onKnobPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        dragPointerIdRef.current = e.pointerId;
        dragStartYRef.current = e.clientY;
        dragStartUnitRef.current = valueToUnit(value);
        try {
            dialRef.current?.setPointerCapture(e.pointerId);
        } catch {
            // Some embedded WebView builds may throw on pointer capture.
        }
        setIsDragging(true);
        onGestureStart?.(paramName);
    }, [onGestureStart, paramName, value, valueToUnit]);

    const onKnobPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (dragPointerIdRef.current !== e.pointerId) return;
        e.preventDefault();
        const dy = e.clientY - dragStartYRef.current;
        const dragScalePx = resolveKnobDragScalePx(e.shiftKey, e.altKey);
        const nextUnit = dragStartUnitRef.current + ((-dy) / dragScalePx);
        onChange(paramName, quantizeValue(unitToValue(nextUnit)));
    }, [onChange, paramName, quantizeValue, unitToValue]);

    const endKnobDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (dragPointerIdRef.current !== e.pointerId) return;
        dragPointerIdRef.current = null;
        try {
            dialRef.current?.releasePointerCapture(e.pointerId);
        } catch {
            // Ignore release failures from unsupported pointer capture implementations.
        }
        setIsDragging(false);
        onGestureEnd?.(paramName);
    }, [onGestureEnd, paramName]);



    useEffect(() => {
        if (!isDragging || dragPointerIdRef.current === null) return;
        const onWindowPointerMove = (e: PointerEvent) => {
            if (dragPointerIdRef.current !== e.pointerId) return;
            const dy = e.clientY - dragStartYRef.current;
            const dragScalePx = resolveKnobDragScalePx(e.shiftKey, e.altKey);
            const nextUnit = dragStartUnitRef.current + ((-dy) / dragScalePx);
            onChange(paramName, quantizeValue(unitToValue(nextUnit)));
        };

        const onWindowPointerUp = (e: PointerEvent) => {
            if (dragPointerIdRef.current !== e.pointerId) return;
            dragPointerIdRef.current = null;
            setIsDragging(false);
            onGestureEnd?.(paramName);
        };

        window.addEventListener('pointermove', onWindowPointerMove);
        window.addEventListener('pointerup', onWindowPointerUp);
        window.addEventListener('pointercancel', onWindowPointerUp);
        return () => {
            window.removeEventListener('pointermove', onWindowPointerMove);
            window.removeEventListener('pointerup', onWindowPointerUp);
            window.removeEventListener('pointercancel', onWindowPointerUp);
        };
    }, [isDragging, onChange, onGestureEnd, paramName, quantizeValue, unitToValue]);



    return {
        isDragging,
        dialRef,
        onKnobPointerDown,
        onKnobPointerMove,
        endKnobDrag,
    };
}
