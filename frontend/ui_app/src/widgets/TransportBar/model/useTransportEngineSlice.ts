import { useCallback, useEffect, useRef } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useShallow } from 'zustand/react/shallow';
import { computeTransportPosition } from './transportBarDomain';

/**
 * Slice for TransportBar — excludes position_beats to avoid 30fps re-renders.
 *
 * PERF-FIX: transport.position_beats changes every telemetry tick (~30fps).
 * Including it in the selector caused the entire TransportBar tree to re-render
 * 30× per second during playback, creating main-thread contention with Canvas
 * scroll/render and intermittent UI freezes.
 *
 * Instead, position display is handled via `usePositionRef` below (ref-based
 * DOM mutation — zero React re-renders).
 */
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

/**
 * Ref-based position display hook — updates the position text via direct DOM
 * mutation (zero React re-renders). Subscribes to the Zustand store outside
 * the React render cycle.
 *
 * @param timeSigNum Beats per bar (e.g. 4 for 4/4 time)
 * @returns posRef — attach to the display element, posBeatsRef — imperative access
 */
export function usePositionRef(timeSigNum: number) {
    const posRef = useRef<HTMLSpanElement | null>(null);
    const posBeatsRef = useRef(0);
    const timeSigNumRef = useRef(timeSigNum);
    timeSigNumRef.current = timeSigNum;

    useEffect(() => {
        const unsub = useEngineStore.subscribe((state) => {
            const posBeats = state.transport.position_beats ?? 0;
            if (posBeats === posBeatsRef.current) return;
            posBeatsRef.current = posBeats;
            const el = posRef.current;
            if (!el) return;
            const pos = computeTransportPosition(posBeats, timeSigNumRef.current);
            el.textContent = `${pos.bar}.${pos.beat}.${pos.sub.toString().padStart(2, '0')}`;
        });
        return unsub;
    }, []);

    /** Read the latest position_beats imperatively (for loop toggle, etc). */
    const readPosBeats = useCallback(
        () => useEngineStore.getState().transport.position_beats ?? 0,
        [],
    );

    return { posRef, posBeatsRef, readPosBeats };
}

