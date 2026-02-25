import type { ProjectTrack } from '@/shared/stores/useEngineStore';

export interface TrackData {
    id: string;
    name: string;
    type: 'audio' | 'midi' | 'group' | 'master';
    color: string;
    volume: number;
    pan: number;
    isDisabled: boolean;
    isSoloed: boolean;
    isArmed: boolean;
    vuLevel: number;
    vuLevelL: number;
    vuLevelR: number;
    routing: string;
    groupId?: string;
    sends: { name: string; amount: number; color: string }[];
    input?: string;
    output?: string;
    height: number;
}

export interface TrackRowLayoutMetrics {
    headerColWidth: number;
    routingColWidth: number;
    groupStripeWidthPx: number;
    indentStepPx: number;
    maxIndentPx: number;
    muteSoloColWidth: number;
    faderColWidth: number;
    armColWidth: number;
    meterColWidth: number;
    mixerColumnGapPx: number;
    mixerPaddingX: number;
    mixerPaddingY: number;
    mixerSectionWidthPx: number;
}

/** Convert a ProjectTrack from the engine store to the UI TrackData shape. */
export function mapProjectTrack(
    pt: ProjectTrack,
    _index: number,
    meterPair?: [{ peak: number }, { peak: number }],
): TrackData {
    const vuLevelL = meterPair ? meterPair[0].peak : -Infinity;
    const vuLevelR = meterPair ? meterPair[1].peak : -Infinity;
    const vuLevel = Math.max(vuLevelL, vuLevelR);
    const typeMap: Record<string, TrackData['type']> = {
        audio: 'audio', Audio: 'audio',
        midi: 'midi', Midi: 'midi',
        group: 'group', Group: 'group',
        master: 'master', Master: 'master',
    };
    return {
        id: pt.id,
        name: pt.name,
        type: typeMap[pt.track_type] || 'audio',
        color: pt.color,
        volume: pt.volume,
        pan: pt.pan,
        isDisabled: pt.is_disabled,
        isSoloed: pt.is_solo,
        isArmed: pt.is_armed,
        vuLevel,
        vuLevelL,
        vuLevelR,
        routing: pt.output || 'master',
        sends: [],
        input: pt.input || 'none',
        output: pt.output || 'master',
        height: Number.isFinite(pt.height) ? pt.height : 48,
        groupId: pt.parent_track_id ?? undefined,
    };
}
