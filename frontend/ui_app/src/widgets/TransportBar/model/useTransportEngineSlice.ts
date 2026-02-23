import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useShallow } from 'zustand/react/shallow';

export const useTransportEngineSlice = () =>
    useEngineStore(useShallow((s) => {
        let armedTrackIndex = -1;
        for (let i = 0; i < s.tracks.allIds.length; i += 1) {
            const track = s.tracks.byId[s.tracks.allIds[i]];
            if (track?.is_armed) {
                armedTrackIndex = i;
                break;
            }
        }
        return {
            isPlaying: s.transport.is_playing,
            bpm: s.projectBpm || s.transport.bpm || 120,
            isLooping: s.transport.loop_enabled,
            loopStartFrames: s.transport.loop_start,
            loopEndFrames: s.transport.loop_end,
            sampleRate: s.transport.sample_rate,
            posBeats: s.transport.position_beats ?? 0,
            togglePlay: s.togglePlay,
            engineStop: s.stop,
            engineSetBpm: s.setBpm,
            engineSetLoop: s.setLoop,
            trackCount: s.tracks.allIds.length,
            armedTrackIndex,
            telemetryRunning: s.telemetryRunning,
            engineConnected: s.connected,
            engineLastError: s.lastError,
            sandboxSnapshot: s.pluginSandbox,
            storeKeySigEnabled: s.keySigEnabled,
            storeKeySigTonic: s.keySigTonic,
            storeKeySigMode: s.keySigMode,
        };
    }));
