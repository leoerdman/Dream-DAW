import { useEngineStore } from '@/shared/stores/useEngineStore';
import { resolveBpm, DEFAULT_TIME_SIG_NUMERATOR } from '@/shared/lib/audioMath';
import { useShallow } from 'zustand/react/shallow';
import { selectAllClips } from '@/shared/stores/entitySelectors';

/**
 * PERF-OPT: Removed `positionBeats` from the selector — it changes every
 * telemetry tick (~30fps) during playback, causing the entire StatusBar tree
 * to re-render 30× per second. Position is now displayed via ref-based DOM
 * mutation in StatusBar.tsx (zero React re-renders).
 */
export const useStatusEngineSlice = () =>
    useEngineStore(useShallow((s) => {
        const h = s.projectHistory;
        return {
            isPlaying: s.transport.is_playing,
            bpm: resolveBpm(s.transport.bpm),
            timeSigNumerator: s.transport.time_sig_numerator || DEFAULT_TIME_SIG_NUMERATOR,
            timelineClips: selectAllClips(s),
            connected: s.connected,
            projectSampleRate: s.projectSampleRate,
            trackCount: s.tracks.allIds.length,
            latestHistory: h.length > 0 ? h[h.length - 1] : undefined,
            projectHistory: h,
            pluginSandbox: s.pluginSandbox,
            reloadCrashedSandboxPlugins: s.reloadCrashedSandboxPlugins,
        };
    }));
