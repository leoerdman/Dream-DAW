import { useCallback, useEffect, useRef } from 'react';
import * as engineApi from '@/shared/api/engine';

export function usePianoRollAudition(trackIndex: number | undefined, enabled: boolean) {
    const auditionOffTimersRef = useRef<Map<number, number>>(new Map());
    const activePitchesRef = useRef<Set<number>>(new Set());

    /** Send note-off for a single pitch and clean up tracking state. */
    const stopAudition = useCallback((pitch: number) => {
        if (trackIndex == null) return;
        const existing = auditionOffTimersRef.current.get(pitch);
        if (existing != null) {
            window.clearTimeout(existing);
            auditionOffTimersRef.current.delete(pitch);
        }
        if (!activePitchesRef.current.has(pitch)) return;
        activePitchesRef.current.delete(pitch);
        void engineApi.previewSamplerNoteOff(trackIndex, pitch).catch((err) => {
            console.warn('[PianoRoll] previewSamplerNoteOff failed:', err);
        });
    }, [trackIndex]);

    /** Send note-off for ALL currently-active preview pitches. */
    const stopAllAudition = useCallback(() => {
        const timers = auditionOffTimersRef.current;
        timers.forEach((timer) => window.clearTimeout(timer));
        timers.clear();
        const pitches = activePitchesRef.current;
        if (trackIndex == null) {
            pitches.clear();
            return;
        }
        pitches.forEach((pitch) => {
            void engineApi.previewSamplerNoteOff(trackIndex, pitch).catch(() => { /* noop */ });
        });
        pitches.clear();
    }, [trackIndex]);

    const auditionNote = useCallback((pitch: number, velocity = 100, durationMs = 120) => {
        if (!enabled || trackIndex == null) return;
        const existingTimer = auditionOffTimersRef.current.get(pitch);
        if (existingTimer != null) {
            window.clearTimeout(existingTimer);
            auditionOffTimersRef.current.delete(pitch);
        }
        if (activePitchesRef.current.has(pitch)) {
            activePitchesRef.current.delete(pitch);
            void engineApi.previewSamplerNoteOff(trackIndex, pitch).catch(() => { /* noop */ });
        }

        activePitchesRef.current.add(pitch);
        void engineApi.previewSamplerNoteOn(trackIndex, pitch, velocity).catch((err) => {
            console.warn('[PianoRoll] previewSamplerNoteOn failed:', err);
        });

        if (durationMs <= 0) return;
        const timer = window.setTimeout(() => {
            auditionOffTimersRef.current.delete(pitch);
            if (!activePitchesRef.current.has(pitch)) return;
            activePitchesRef.current.delete(pitch);
            void engineApi.previewSamplerNoteOff(trackIndex, pitch).catch((err) => {
                console.warn('[PianoRoll] previewSamplerNoteOff(timer) failed:', err);
            });
        }, Math.max(40, durationMs));
        auditionOffTimersRef.current.set(pitch, timer);
    }, [enabled, trackIndex]);

    // Cleanup on track change
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

    // Cleanup when audition is disabled
    useEffect(() => {
        if (enabled || trackIndex == null) return;
        stopAllAudition();
    }, [enabled, trackIndex, stopAllAudition]);

    return { auditionNote, stopAudition, stopAllAudition };
}
