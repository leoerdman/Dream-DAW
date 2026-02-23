import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';

const INTERNAL_CARD_WIDTH: Partial<Record<DeviceSlot['effectType'], number>> = {
    waveSynth: 980,
    eq: 540,
};

export function resolveDeviceCardWidth(
    source: DeviceSlot['source'],
    effectType: DeviceSlot['effectType'],
    manifestWidth: number,
): number {
    if (source === 'internal') {
        return INTERNAL_CARD_WIDTH[effectType] ?? manifestWidth;
    }
    return manifestWidth;
}

