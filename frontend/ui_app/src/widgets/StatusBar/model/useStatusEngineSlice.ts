import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useShallow } from 'zustand/react/shallow';

export const useStatusEngineSlice = () =>
    useEngineStore(useShallow((s) => {
        const h = s.projectHistory;
        return {
            isPlaying: s.transport.is_playing,
            positionSeconds: s.transport.position_seconds,
            bpm: s.projectBpm || s.transport.bpm || 120,
            connected: s.connected,
            projectSampleRate: s.projectSampleRate,
            projectTracks: s.projectTracks,
            latestHistory: h.length > 0 ? h[h.length - 1] : undefined,
            projectHistory: h,
            pluginSandbox: s.pluginSandbox,
        };
    }));
