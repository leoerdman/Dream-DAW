import type { AdaptiveSender } from './useDeviceParamGestureTypes';

const ADAPTIVE_INTERVAL_MIN_MS = 16;
const ADAPTIVE_INTERVAL_MAX_MS = 48;
const ADAPTIVE_INTERVAL_INITIAL_MS = 24;
const RUNTIME_BATCH_INTERVAL_MIN_MS = 24;
const RUNTIME_BATCH_INTERVAL_MAX_MS = 72;
const RUNTIME_BATCH_INTERVAL_INITIAL_MS = 32;
const RUNTIME_VALUE_EPSILON = 1e-4;

export function createAdaptiveParamSenderFactory(
): (emit: (value: number, pushUndoStep: boolean) => Promise<void> | void) => AdaptiveSender {
    return (emit: (value: number, pushUndoStep: boolean) => Promise<void> | void): AdaptiveSender => {
        let timer: number | null = null;
        let pending: { value: number; pushUndoStep: boolean } | null = null;
        let lastSentAt = 0;
        let adaptiveIntervalMs = ADAPTIVE_INTERVAL_INITIAL_MS;

        const schedule = () => {
            if (timer != null || !pending) return;
            const now = performance.now();
            const delay = Math.max(0, adaptiveIntervalMs - (now - lastSentAt));
            timer = window.setTimeout(() => {
                timer = null;
                const payload = pending;
                pending = null;
                if (!payload) return;

                const startedAt = performance.now();
                lastSentAt = startedAt;
                void Promise.resolve(emit(payload.value, payload.pushUndoStep))
                    .catch((err) => {
                        console.error('[DeviceRack] parameter send failed:', err);
                    })
                    .finally(() => {
                        const elapsed = Math.max(1, performance.now() - startedAt);
                        const target = Math.max(ADAPTIVE_INTERVAL_MIN_MS, Math.min(ADAPTIVE_INTERVAL_MAX_MS, elapsed * 1.25));
                        adaptiveIntervalMs = adaptiveIntervalMs * 0.7 + target * 0.3;
                        if (pending) schedule();
                    });
            }, delay);
        };

        return {
            send: (value: number, pushUndoStep: boolean) => {
                if (pushUndoStep) {
                    if (timer != null) { window.clearTimeout(timer); timer = null; }
                    pending = null;
                    const startedAt = performance.now();
                    lastSentAt = startedAt;
                    void Promise.resolve(emit(value, true))
                        .catch((err) => {
                            console.error('[DeviceRack] parameter send failed:', err);
                        })
                        .finally(() => {
                            const elapsed = Math.max(1, performance.now() - startedAt);
                            const target = Math.max(ADAPTIVE_INTERVAL_MIN_MS, Math.min(ADAPTIVE_INTERVAL_MAX_MS, elapsed * 1.25));
                            adaptiveIntervalMs = adaptiveIntervalMs * 0.7 + target * 0.3;
                        });
                    return;
                }
                pending = { value, pushUndoStep: pending?.pushUndoStep === true ? true : false };
                schedule();
            },
            cancel: () => {
                if (timer != null) { window.clearTimeout(timer); timer = null; }
                pending = null;
            },
        };
    };
}

export function createAdaptiveRuntimeBatchSenderFactory(
): (
    emit: (updates: Array<{ paramIndex: number; value: number }>) => Promise<void> | void,
) => { queue: (paramIndex: number, value: number) => void; cancel: () => void } {
    return (
        emit: (updates: Array<{ paramIndex: number; value: number }>) => Promise<void> | void,
    ): { queue: (paramIndex: number, value: number) => void; cancel: () => void } => {
        let timer: number | null = null;
        const pendingByParam = new Map<number, number>();
        let lastSentAt = 0;
        let adaptiveIntervalMs = RUNTIME_BATCH_INTERVAL_INITIAL_MS;

        const schedule = () => {
            if (timer != null || pendingByParam.size === 0) return;
            const now = performance.now();
            const delay = Math.max(0, adaptiveIntervalMs - (now - lastSentAt));
            timer = window.setTimeout(() => {
                timer = null;
                if (pendingByParam.size === 0) return;
                const payload = Array.from(pendingByParam.entries()).map(([paramIndex, value]) => ({
                    paramIndex,
                    value,
                }));
                pendingByParam.clear();
                const startedAt = performance.now();
                lastSentAt = startedAt;
                void Promise.resolve(emit(payload))
                    .catch((err) => {
                        // BUG-R4-030 FIX: Log error — caller cannot observe async rejections in this chain.
                        console.warn('[DeviceRack] runtime batch param send failed:', err);
                    })
                    .finally(() => {
                        const elapsed = Math.max(1, performance.now() - startedAt);
                        const target = Math.max(
                            RUNTIME_BATCH_INTERVAL_MIN_MS,
                            Math.min(RUNTIME_BATCH_INTERVAL_MAX_MS, elapsed * 1.25),
                        );
                        adaptiveIntervalMs = adaptiveIntervalMs * 0.7 + target * 0.3;
                        if (pendingByParam.size > 0) schedule();
                    });
            }, delay);
        };

        return {
            queue: (paramIndex: number, value: number) => {
                const prev = pendingByParam.get(paramIndex);
                if (prev != null && Math.abs(prev - value) < RUNTIME_VALUE_EPSILON) return;
                pendingByParam.set(paramIndex, value);
                schedule();
            },
            cancel: () => {
                if (timer != null) {
                    window.clearTimeout(timer);
                    timer = null;
                }
                pendingByParam.clear();
            },
        };
    };
}
