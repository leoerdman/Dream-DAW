import { safeStorage } from '@/shared/lib/safeStorage';

export function readAssistantOpenPref(): boolean {
    return safeStorage.getItem('dream-daw:assistant-open') === '1';
}

export function writeAssistantOpenPref(open: boolean): void {
    safeStorage.setItem('dream-daw:assistant-open', open ? '1' : '0');
}
