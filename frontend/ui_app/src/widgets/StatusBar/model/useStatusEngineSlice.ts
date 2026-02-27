import { useEngineStore } from '@/shared/stores/useEngineStore';
import { resolveBpm } from '@/shared/lib/audioMath';
import { useShallow } from 'zustand/react/shallow';

export const useStatusEngineSlice = () =>
    useEngineStore(useShallow((s) => {
        const h = s.projectHistory;
        return {
            isPlaying: s.transport.is_playing,
            positionBeats: s.transport.position_beats ?? 0,
            bpm: resolveBpm(s.projectBpm, s.transport.bpm),
            timeSigNumerator: s.timeSigNumerator || s.transport.time_sig_numerator || 4,
            timelineClips: s.timelineClips,
            connected: s.connected,
            projectSampleRate: s.projectSampleRate,
            trackCount: s.tracks.allIds.length,
            latestHistory: h.length > 0 ? h[h.length - 1] : undefined,
            projectHistory: h,
            pluginSandbox: s.pluginSandbox,
            reloadCrashedSandboxPlugins: s.reloadCrashedSandboxPlugins,
        };
    }));
