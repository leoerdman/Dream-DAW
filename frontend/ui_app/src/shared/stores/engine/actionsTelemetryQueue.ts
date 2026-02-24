import type { StoreApi } from 'zustand';
import type { EngineStore } from '@/shared/stores/useEngineStore';

let pendingUpdate: Partial<EngineStore> = {};
let rafPending = false;

function flushPendingStoreUpdate(set: StoreApi<EngineStore>['setState']): void {
    rafPending = false;
    const update = pendingUpdate;
    pendingUpdate = {};
    if (Object.keys(update).length > 0) set(update);
}

export function enqueuePendingStoreUpdate(
    set: StoreApi<EngineStore>['setState'],
    partial: Partial<EngineStore>,
): void {
    pendingUpdate = { ...pendingUpdate, ...partial };
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
