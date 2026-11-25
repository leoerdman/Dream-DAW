/**
 * MixerChannelMeters — ref-based stereo VU meters for each mixer strip.
 *
 * PERF-OPT: Uses `useEngineStore.subscribe()` + direct DOM mutation instead
 * of React state/selector. This eliminates N × 30fps React re-renders across
 * all mixer strips. The same enterprise pattern used by `usePositionRef` in
 * the TransportBar.
 *
 * Data flow:
 *   Rust audio thread → binary IPC → decodeMetersBinaryPacket
 *   → smoothMeterSnapshot → Zustand store.meters
 *   → THIS COMPONENT reads via subscribe (zero React renders)
 *   → Updates scaleY transform + peak hold lines directly via refs.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { MeterStrip } from '@/shared/ui/MeterStrip';
import { clamp01 } from '@/shared/lib/audioMath';
import { dbToMeterNorm } from '@/shared/lib/meterManifest';
import { formatDb } from '@/widgets/TrackInspector/model/faderMath';

type MixerChannelMetersProps = {
    trackIndex: number;
    isMidi: boolean;
    meterWidth: number;
};

/**
 * PERF-OPT: Subscription-driven meter component — subscribes to store
 * outside React render cycle. Uses RAF coalescing + minimal setState
 * trigger. Compared to the old selector approach, this:
 *   - Skips updates when meter values haven't changed
 *   - Coalesces multiple store updates into one RAF
 *   - Only triggers one setState per animation frame (not per store notify)
 */
export const MixerChannelMeters = memo(function MixerChannelMeters({
    trackIndex,
    isMidi,
    meterWidth,
}: MixerChannelMetersProps) {
    // Refs to hold the latest meter values — updated by subscription, read by render.
    const meterLRef = useRef(0);
    const meterRRef = useRef(0);
    const holdLRef = useRef(0);
    const holdRRef = useRef(0);
    const rafIdRef = useRef(0);
    const mountedRef = useRef(true);

    // Track last applied values to skip no-op updates (value-level equality).
    const lastValuesRef = useRef({ mL: 0, mR: 0, hL: 0, hR: 0 });

    const [meterState, setMeterState] = useState({ mL: 0, mR: 0, hL: 0, hR: 0 });

    useEffect(() => {
        mountedRef.current = true;

        const unsub = useEngineStore.subscribe((state) => {
            const meterPair = state.meters.tracks[trackIndex];
            const peakDbL = meterPair?.[0]?.peak ?? -96;
            const peakDbR = meterPair?.[1]?.peak ?? -96;
            const mL = clamp01(dbToMeterNorm(peakDbL));
            const mR = clamp01(dbToMeterNorm(peakDbR));
            const peakHoldDbL = meterPair?.[0]?.peak_hold ?? peakDbL;
            const peakHoldDbR = meterPair?.[1]?.peak_hold ?? peakDbR;
            const hL = clamp01(dbToMeterNorm(peakHoldDbL));
            const hR = clamp01(dbToMeterNorm(peakHoldDbR));

            // Skip if values haven't changed (avoid unnecessary RAF + render).
            const last = lastValuesRef.current;
            if (mL === last.mL && mR === last.mR && hL === last.hL && hR === last.hR) return;

            meterLRef.current = mL;
            meterRRef.current = mR;
            holdLRef.current = hL;
            holdRRef.current = hR;
            lastValuesRef.current = { mL, mR, hL, hR };

            // Coalesce into one RAF to avoid multiple renders per frame.
            if (rafIdRef.current) return;
            rafIdRef.current = requestAnimationFrame(() => {
                rafIdRef.current = 0;
                if (mountedRef.current) {
                    setMeterState({
                        mL: meterLRef.current,
                        mR: meterRRef.current,
                        hL: holdLRef.current,
                        hR: holdRRef.current,
                    });
                }
            });
        });

        return () => {
            mountedRef.current = false;
            unsub();
            if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
        };
    }, [trackIndex]);

    return (
        <div style={{ width: meterWidth, position: 'relative', borderRadius: 'var(--radius-xs)', overflow: 'hidden', background: 'var(--surface-elevated)', border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>
            <MeterStrip levelL={meterState.mL} levelR={meterState.mR} peakHoldL={meterState.hL} peakHoldR={meterState.hR} isMidi={isMidi} width={meterWidth} show0dBLine style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
        </div>
    );
});

// ── Peak Hold Duration ──────────────────────────────────────────────────
const PEAK_HOLD_MS = 4000;

/**
 * Peak hold label: displays the highest instantaneous peak dB reached
 * and holds it for PEAK_HOLD_MS (4 seconds) before decaying.
 *
 * PERF-OPT: Uses useEngineStore.subscribe() + direct DOM mutation (ref-based)
 * instead of selector-driven React re-renders. Eliminates N × 30fps re-renders.
 */
export const MixerChannelPeakLabel = memo(function MixerChannelPeakLabel({
    trackIndex,
}: {
    trackIndex: number;
}) {
    const displayRef = useRef<HTMLDivElement>(null);

    // ── Local peak hold state (survives re-renders, never reset by store) ──
    const holdRef = useRef({
        peakDb: -Infinity,     // highest registered peak in dB
        lastPeakTs: 0,         // timestamp of the last new-high event
        resettedByUser: false,  // flag for manual click-to-reset
    });

    // PERF-OPT: Subscribe to store outside React render cycle for zero re-renders.
    useEffect(() => {
        const unsub = useEngineStore.subscribe((state) => {
            const el = displayRef.current;
            if (!el) return;

            const meterPair = state.meters.tracks[trackIndex];
            const peakHoldL = meterPair?.[0]?.peak_hold ?? meterPair?.[0]?.peak ?? -160;
            const peakHoldR = meterPair?.[1]?.peak_hold ?? meterPair?.[1]?.peak ?? -160;
            const currentPeak = Math.max(peakHoldL, peakHoldR);

            const now = performance.now();
            const h = holdRef.current;

            // If user clicked reset, wait for a fresh signal to start a new hold
            if (h.resettedByUser) {
                h.peakDb = currentPeak;
                h.lastPeakTs = now;
                h.resettedByUser = false;
            }
            // If the new peak is higher or equal, latch it
            else if (currentPeak >= h.peakDb) {
                h.peakDb = currentPeak;
                h.lastPeakTs = now;
            }
            // After PEAK_HOLD_MS without a new high, drop
            else if (now - h.lastPeakTs > PEAK_HOLD_MS) {
                h.peakDb = currentPeak;
                h.lastPeakTs = now;
            }
            // else: keep held value unchanged

            const displayDb = h.peakDb;
            const hasClipped = displayDb >= 0;
            const text = Number.isFinite(displayDb) && displayDb > -120
                ? formatDb(displayDb)
                : '-∞';

            if (el.textContent !== text) {
                el.textContent = text;
            }

            const color = hasClipped ? 'var(--color-status-error)' : 'var(--color-text-secondary)';
            if (el.style.color !== color) {
                el.style.color = color;
            }
        });
        return unsub;
    }, [trackIndex]);

    const resetPeak = useCallback(() => {
        holdRef.current.peakDb = -Infinity;
        holdRef.current.lastPeakTs = 0;
        holdRef.current.resettedByUser = true;
        // ENTERPRISE-PEAK-FIX: Also reset the smoother's peak hold state
        // so it re-latches from the next raw peak instead of holding the old value.
        useEngineStore.getState().resetMeterPeakHold(trackIndex);
        if (displayRef.current) {
            displayRef.current.textContent = '-∞';
            displayRef.current.style.color = 'var(--color-text-secondary)';
        }
    }, [trackIndex]);

    return (
        <div
            ref={displayRef}
            onClick={(e) => { e.stopPropagation(); resetPeak(); }}
            title="Click to reset peak"
            style={{
                fontSize: 'var(--font-size-2xs)',
                fontFamily: 'var(--font-role-data)',
                color: 'var(--color-text-secondary)',
                textAlign: 'center',
                padding: '2px 0',
                cursor: 'pointer',
                userSelect: 'none',
                background: 'var(--surface-elevated)',
                borderRadius: 'var(--radius-xs)',
                border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)',
            }}
        >
            -∞
        </div>
    );
});
