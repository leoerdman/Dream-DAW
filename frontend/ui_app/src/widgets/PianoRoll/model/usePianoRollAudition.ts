import { useCallback, useEffect, useRef } from 'react';
import * as engineApi from '@/shared/api/engine';

export function usePianoRollAudition(trackIndex?: number) {
    const auditionOffTimersRef = useRef<Map<number, number>>(new Map());

    const stopAudition = useCallback((pitch: number) => {
        if (trackIndex == null) return;
        const existing = auditionOffTimersRef.current.get(pitch);
        if (existing != null) {
            window.clearTimeout(existing);
            auditionOffTimersRef.current.delete(pitch);
        }
        void engineApi.previewSamplerNoteOff(trackIndex, pitch).catch((err) => {
            console.warn('[PianoRoll] previewSamplerNoteOff failed:', err);
        });
    }, [trackIndex]);

    const auditionNote = useCallback((pitch: number, velocity = 100, durationMs = 140) => {
        if (trackIndex == null) return;
        stopAudition(pitch);
        void engineApi.previewSamplerNoteOn(trackIndex, pitch, velocity).catch((err) => {
            console.warn('[PianoRoll] previewSamplerNoteOn failed:', err);
        });
        const timer = window.setTimeout(() => {
            void engineApi.previewSamplerNoteOff(trackIndex, pitch).catch((err) => {
                console.warn('[PianoRoll] previewSamplerNoteOff(timer) failed:', err);
            });
            auditionOffTimersRef.current.delete(pitch);
        }, durationMs);
        auditionOffTimersRef.current.set(pitch, timer);
    }, [trackIndex, stopAudition]);

    useEffect(() => {
        const timers = auditionOffTimersRef.current;
        return () => {
            timers.forEach((timer) => window.clearTimeout(timer));
            timers.clear();
        };
    }, []);

    return { auditionNote };
}
