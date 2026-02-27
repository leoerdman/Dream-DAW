export type IdleHandle = number;

type IdleWindow = Window & {
    requestIdleCallback?: (fn: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
};

const DEFAULT_IDLE_TIMEOUT_MS = 900;
const DEFAULT_FALLBACK_DELAY_MS = 260;

export function scheduleIdle(
    cb: () => void,
    options?: { timeoutMs?: number; fallbackDelayMs?: number },
): IdleHandle {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const fallbackDelayMs = options?.fallbackDelayMs ?? DEFAULT_FALLBACK_DELAY_MS;
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
