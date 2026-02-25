import type { ProjectDelta } from '@/shared/api/engine';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const KNOWN_DELTA_KINDS = new Set<string>([
    'ClipMoved',
    'ClipAdded',
    'ClipResized',
    'ClipSplit',
    'ClipDeleted',
    'ClipDuplicated',
    'ClipsMerged',
    'ClipMuteChanged',
    'MidiClipNotesReplaced',
    'ClipSourceOffsetChanged',
    'ClipFadesChanged',
    'ClipWarpChanged',
    'ClipColorChanged',
    'ClipFilePathChanged',
    'ClipRenamed',
    'TrackVolumeChanged',
    'TrackPanChanged',
    'TrackDisabledChanged',
    'TrackSoloChanged',
    'TrackArmChanged',
    'TrackRoutingChanged',
    'TrackInputChanged',
    'TrackSamplerSampleChanged',
    'SampleRackPadSampleChanged',
    'SampleRackPadVolumeChanged',
    'SampleRackPadMuteChanged',
    'SampleRackPadSoloChanged',
    'SampleRackPadAdsrChanged',
    'SampleRackPadFilterCutoffChanged',
    'TrackColorChanged',
    'TrackAdded',
    'TrackRemoved',
    'TrackRenamed',
    'TrackMoved',
    'TrackParentChanged',
    'TrackHeightChanged',
    'TrackGroupExpandedChanged',
    'PluginAdded',
    'PluginRemoved',
    'PluginBypassChanged',
    'PluginMoved',
    'InternalPluginParamChanged',
    'ExternalPluginParamChanged',
    'PluginSidechainChanged',
    'AutomationPointsChanged',
    'TempoChanged',
    'TimeSignatureChanged',
    'ArrangementGridChanged',
    'KeySignatureChanged',
    'ProjectRenamed',
    'LoopRegionChanged',
    'ClipPitchChanged',
    'ProjectSnapshotReplaced',
]);

export function sanitizeProjectDeltas(raw: unknown): ProjectDelta[] {
    if (!Array.isArray(raw)) return [];
    const cleaned: ProjectDelta[] = [];
    for (const entry of raw) {
        if (!isRecord(entry)) continue;
        const kind = entry.kind;
        const data = entry.data;
        if (typeof kind !== 'string') continue;
        if (!KNOWN_DELTA_KINDS.has(kind)) continue;
        if (!isRecord(data)) continue;
        cleaned.push(entry as ProjectDelta);
    }
    return cleaned;
}
