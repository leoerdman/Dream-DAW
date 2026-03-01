import type { StoreApi } from 'zustand';
import type { EngineStore } from '@/shared/stores/useEngineStore';

let pendingUpdate: Partial<EngineStore> = {};
let rafPending = false;

function hasKeys(obj: Record<string, unknown>): boolean {
    for (const _ in obj) return true;
    return false;
}

function flushPendingStoreUpdate(set: StoreApi<EngineStore>['setState']): void {
    rafPending = false;
    const update = pendingUpdate;
    pendingUpdate = {};
    // PERF FIX: avoid Object.keys() allocation — use fast `for...in` check.
    if (hasKeys(update as Record<string, unknown>)) set(update);
}

export function enqueuePendingStoreUpdate(
    set: StoreApi<EngineStore>['setState'],
    partial: Partial<EngineStore>,
): void {
    // PERF FIX: Object.assign() mutates in-place — avoids per-tick spread allocation.
    Object.assign(pendingUpdate, partial);
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => flushPendingStoreUpdate(set));
}

export function payloadToUint8Array(
    payload: number[] | Uint8Array | ArrayBuffer | null | undefined,
): Uint8Array {
    if (payload instanceof Uint8Array) return payload;
    if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
    return new Uint8Array(payload ?? []);
}
