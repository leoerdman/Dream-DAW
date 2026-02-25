import { useCallback, useEffect, useRef } from 'react';
import * as engineApi from '@/shared/api/engine';

export function usePianoRollAudition(trackIndex: number | undefined, enabled: boolean) {
    const auditionOffTimersRef = useRef<Map<number, number>>(new Map());
    const activePitchesRef = useRef<Set<number>>(new Set());

    const stopAudition = useCallback((pitch: number) => {
        if (trackIndex == null) return;
        const existing = auditionOffTimersRef.current.get(pitch);
        if (existing != null) {
            window.clearTimeout(existing);
            auditionOffTimersRef.current.delete(pitch);
        }
        activePitchesRef.current.delete(pitch);
        void engineApi.previewSamplerNoteOff(trackIndex, pitch).catch((err) => {
            console.warn('[PianoRoll] previewSamplerNoteOff failed:', err);
        });
    }, [trackIndex]);

    const auditionNote = useCallback((pitch: number, velocity = 100, durationMs = 140) => {
        if (!enabled || trackIndex == null) return;
        stopAudition(pitch);
        activePitchesRef.current.add(pitch);
        void engineApi.previewSamplerNoteOn(trackIndex, pitch, velocity).catch((err) => {
            console.warn('[PianoRoll] previewSamplerNoteOn failed:', err);
        });
        const timer = window.setTimeout(() => {
            // Fire two note-offs (small stagger) to avoid stuck audition voices
            // when one command is dropped during UI/buffer pressure.
            const sendOff = () => engineApi.previewSamplerNoteOff(trackIndex, pitch).catch((err) => {
                console.warn('[PianoRoll] previewSamplerNoteOff(timer) failed:', err);
            });
            void sendOff();
            window.setTimeout(() => { void sendOff(); }, 70);
            activePitchesRef.current.delete(pitch);
            auditionOffTimersRef.current.delete(pitch);
        }, Math.max(40, durationMs));
        auditionOffTimersRef.current.set(pitch, timer);
    }, [enabled, trackIndex, stopAudition]);

    useEffect(() => {
        const timers = auditionOffTimersRef.current;
        const activePitches = activePitchesRef.current;
        return () => {
            timers.forEach((timer) => window.clearTimeout(timer));
            timers.clear();
            if (trackIndex != null) {
                activePitches.forEach((pitch) => {
                    void engineApi.previewSamplerNoteOff(trackIndex, pitch).catch(() => { /* noop */ });
                });
            }
            activePitches.clear();
        };
    }, [trackIndex]);

    useEffect(() => {
        if (enabled || trackIndex == null) return;
        const timers = auditionOffTimersRef.current;
        timers.forEach((timer) => window.clearTimeout(timer));
        const pitches = Array.from(new Set([...timers.keys(), ...activePitchesRef.current.values()]));
        timers.clear();
        for (const pitch of pitches) {
            void engineApi.previewSamplerNoteOff(trackIndex, pitch).catch((err) => {
                console.warn('[PianoRoll] previewSamplerNoteOff(disable) failed:', err);
            });
        }
        activePitchesRef.current.clear();
    }, [enabled, trackIndex]);

    return { auditionNote };
}
