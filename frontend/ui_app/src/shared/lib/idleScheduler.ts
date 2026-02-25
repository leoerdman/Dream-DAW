export type IdleHandle = number;

type IdleWindow = Window & {
    requestIdleCallback?: (fn: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
};

export function scheduleIdle(
    cb: () => void,
    options?: { timeoutMs?: number; fallbackDelayMs?: number },
): IdleHandle {
    const timeoutMs = options?.timeoutMs ?? 900;
    const fallbackDelayMs = options?.fallbackDelayMs ?? 260;
    const win = window as IdleWindow;
    if (typeof win.requestIdleCallback === 'function') {
        return win.requestIdleCallback(cb, { timeout: timeoutMs }) as number;
    }
    return window.setTimeout(cb, fallbackDelayMs);
}

export function cancelIdle(handle: IdleHandle | null): void {
    if (handle == null) return;
    const win = window as IdleWindow;
    if (typeof win.cancelIdleCallback === 'function') {
        win.cancelIdleCallback(handle);
        return;
    }
    window.clearTimeout(handle);
}
