import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export function useMidiActivityLed() {
    const midiLedRef = useRef<HTMLSpanElement>(null);
    const midiLedTimerRef = useRef<number | null>(null);

    useEffect(() => {
        let unlisten: UnlistenFn | null = null;
        let cancelled = false;

        void listen<Record<string, unknown>>('midi_event_received', () => {
            const led = midiLedRef.current;
            if (!led) return;
            led.style.opacity = '1';
            if (midiLedTimerRef.current !== null) window.clearTimeout(midiLedTimerRef.current);
            midiLedTimerRef.current = window.setTimeout(() => {
                if (midiLedRef.current) midiLedRef.current.style.opacity = '0.35';
            }, 50);
        })
            .then((fn) => {
                if (cancelled) fn();
                else unlisten = fn;
            })
            .catch((err) => {
                console.error('[Dream] midi_event_received listener failed:', err);
            });

        return () => {
            cancelled = true;
            if (midiLedTimerRef.current !== null) {
                window.clearTimeout(midiLedTimerRef.current);
                midiLedTimerRef.current = null;
            }
            if (unlisten) unlisten();
        };
    }, []);

    return { midiLedRef };
}

