import throttle from 'lodash.throttle';
import * as engine from '@/shared/api/engine';

export type ThrottledFn<T> = T & { cancel(): void; flush(): void };

export const throttledVolumeSends = new Map<number, ThrottledFn<(volume: number) => void>>();
export const throttledPanSends = new Map<number, ThrottledFn<(pan: number) => void>>();
export const pendingVolumeValues = new Map<number, number>();
export const pendingPanValues = new Map<number, number>();
export const throttledSendLevelSends = new Map<string, ThrottledFn<(value: number) => void>>();
// BUG-040 FIX: Track pending send level values so they can be flushed
// correctly in flushTrackControlFinals (was missing before).
export const pendingSendLevelValues = new Map<string, { trackIndex: number; send: 'A' | 'B'; value: number }>();

let pendingMasterVolume: number | null = null;

export const throttledMasterVolumeSend = throttle((volume: number) => {
    void engine.setMasterVolume(volume);
}, 16);

export function setPendingMasterVolume(value: number | null): void {
    pendingMasterVolume = value;
}

export function getPendingMasterVolume(): number | null {
    return pendingMasterVolume;
}

export function clearTrackControlCaches(): void {
    for (const fn of throttledVolumeSends.values()) fn.cancel();
    for (const fn of throttledPanSends.values()) fn.cancel();
    for (const fn of throttledSendLevelSends.values()) fn.cancel();
    throttledVolumeSends.clear();
    throttledPanSends.clear();
    throttledSendLevelSends.clear();
    pendingVolumeValues.clear();
    pendingPanValues.clear();
    // BUG-040 FIX: Clear pending send levels too.
    pendingSendLevelValues.clear();
    setPendingMasterVolume(null);
}
