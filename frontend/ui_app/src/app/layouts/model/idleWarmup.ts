type IdleHandle = number;

export function scheduleIdle(cb: () => void): IdleHandle {
    const win = window as Window & {
        requestIdleCallback?: (fn: () => void, options?: { timeout: number }) => number;
    };
    if (typeof win.requestIdleCallback === 'function') {
        return win.requestIdleCallback(cb, { timeout: 900 }) as number;
    }
    return window.setTimeout(cb, 260);
}

export function cancelIdle(handle: IdleHandle): void {
    const win = window as Window & {
        cancelIdleCallback?: (id: number) => void;
    };
    if (typeof win.cancelIdleCallback === 'function') {
        win.cancelIdleCallback(handle);
        return;
    }
    window.clearTimeout(handle);
}
