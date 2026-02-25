import {
    cancelIdle as cancelIdleTask,
    scheduleIdle as scheduleIdleTask,
    type IdleHandle,
} from '@/shared/lib/idleScheduler';

export function scheduleIdle(cb: () => void): IdleHandle {
    return scheduleIdleTask(cb, { timeoutMs: 900, fallbackDelayMs: 260 });
}

export function cancelIdle(handle: IdleHandle): void {
    cancelIdleTask(handle);
}
