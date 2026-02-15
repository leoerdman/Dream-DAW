import type { BrowserDragItem } from '@/shared/lib/arrangementTypes';

export type DropZoneType = 'timeline-track' | 'device-rack' | 'sampler-surface';

export interface DropAcceptance {
    allowed: boolean;
    reason?: string;
}

/**
 * Single source of truth for browser drag/drop routing.
 * Keeps rules explicit and shared across Timeline + DeviceRack.
 */
export function canDropInZone(item: BrowserDragItem, zone: DropZoneType): DropAcceptance {
    switch (zone) {
        case 'timeline-track':
            if (item.type === 'audio' || item.type === 'midi' || item.type === 'plugin') {
                return { allowed: Boolean(item.path), reason: item.path ? undefined : 'Missing source path.' };
            }
            return { allowed: false, reason: `Unsupported item type '${item.type}' for timeline.` };
        case 'device-rack':
            if (item.type === 'plugin') {
                return { allowed: Boolean(item.path), reason: item.path ? undefined : 'Missing plugin path.' };
            }
            return { allowed: false, reason: 'Only plugins can be dropped on device rack.' };
        case 'sampler-surface':
            if (item.type === 'audio') {
                return { allowed: Boolean(item.path), reason: item.path ? undefined : 'Missing audio path.' };
            }
            return { allowed: false, reason: 'Only audio files can be dropped on sampler.' };
        default:
            return { allowed: false, reason: 'Unknown drop zone.' };
    }
}

