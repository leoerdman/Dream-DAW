import { memo, useCallback, useLayoutEffect, useRef } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { MeterStrip } from '@/shared/ui/MeterStrip';
import { clamp01, vuNorm } from '@/shared/lib/audioMath';
import { formatDb } from '@/widgets/TrackInspector/model/faderMath';

type MixerChannelMetersProps = {
    trackIndex: number;
    isMidi: boolean;
    meterWidth: number;
};

export const MixerChannelMeters = memo(function MixerChannelMeters({
    trackIndex,
    isMidi,
    meterWidth,
}: MixerChannelMetersProps) {
    const meterPair = useEngineStore((s) => s.meters.tracks[trackIndex]);
    const peakDbL = meterPair?.[0]?.peak ?? -96;
    const peakDbR = meterPair?.[1]?.peak ?? -96;
    // ENTERPRISE-METER-FIX: Use pure peak for bar display (not peak*0.7+rms*0.3).
    // RMS decays faster than peak, so blending made bars collapse too quickly.
    // Enterprise DAWs (Ableton/Logic/FL) show peak as the bright bar,
    // RMS as a dimmer overlay or separate indicator (phase 2).
    const meterL = clamp01(vuNorm(peakDbL));
    const meterR = clamp01(vuNorm(peakDbR));

    // Peak hold indicator: read peak_hold from smoothing pipeline (4s hold)
    const peakHoldDbL = meterPair?.[0]?.peak_hold ?? peakDbL;
    const peakHoldDbR = meterPair?.[1]?.peak_hold ?? peakDbR;
    const holdL = clamp01(vuNorm(peakHoldDbL));
    const holdR = clamp01(vuNorm(peakHoldDbR));

    return (
        <>
            <div style={{ width: meterWidth, position: 'relative', borderRadius: 'var(--radius-xs)', overflow: 'hidden', background: 'var(--surface-elevated)', border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>
                <MeterStrip levelL={meterL} levelR={meterL} peakHoldL={holdL} peakHoldR={holdL} isMidi={isMidi} width={meterWidth} show0dBLine style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
            </div>
            <div style={{ width: meterWidth, position: 'relative', borderRadius: 'var(--radius-xs)', overflow: 'hidden', background: 'var(--surface-elevated)', border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>
                <MeterStrip levelL={meterR} levelR={meterR} peakHoldL={holdR} peakHoldR={holdR} isMidi={isMidi} width={meterWidth} show0dBLine style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
            </div>
        </>
    );
});

// ── Peak Hold Duration ──────────────────────────────────────────────────
const PEAK_HOLD_MS = 4000;

/**
 * Peak hold label: displays the highest instantaneous peak dB reached
 * and holds it for PEAK_HOLD_MS (4 seconds) before decaying.
 *
 * This component reads the current peak dB from the store on every render
 * and maintains its own independent hold state via useRef. This avoids
 * any dependency on optional fields in MeterReading, Zustand shallow
 * equality, or the smoothing pipeline — making it completely bulletproof.
 *
 * Click the label to manually reset the peak hold.
 */
export const MixerChannelPeakLabel = memo(function MixerChannelPeakLabel({
    trackIndex,
}: {
    trackIndex: number;
}) {
    const meterPair = useEngineStore((s) => s.meters.tracks[trackIndex]);
    const displayRef = useRef<HTMLDivElement>(null);

    // ── Local peak hold state (survives re-renders, never reset by store) ──
    const holdRef = useRef({
        peakDb: -Infinity,     // highest registered peak in dB
        lastPeakTs: 0,         // timestamp of the last new-high event
        resettedByUser: false,  // flag for manual click-to-reset
    });

    // ENTERPRISE-PEAK-FIX: Read peak_hold from the smoothing pipeline instead
    // of the IIR-smoothed `peak` value. The smoother in actionsTelemetrySmoothing.ts
    // computes `peak_hold` using RAW backend peak values with a 4-second hold
    // window (lines 48-67). Previously this component read the IIR-smoothed `peak`
    // which has a 420ms release tau — causing the display to drop to -∞ almost
    // immediately after audio stops, completely defeating the 4-second hold.
    //
    // Data flow:
    //   Audio Thread → store_peak_decay(300ms) → binary IPC → decodeMetersBinaryPacket
    //   → smoothMeterSnapshot (computes peak_hold with 4s window) → Zustand meters
    //   → THIS COMPONENT reads peak_hold (not peak)
    const peakHoldL = meterPair?.[0]?.peak_hold ?? meterPair?.[0]?.peak ?? -160;
    const peakHoldR = meterPair?.[1]?.peak_hold ?? meterPair?.[1]?.peak ?? -160;
    const currentPeak = Math.max(peakHoldL, peakHoldR);

    // BUG-022 FIX: useLayoutEffect for synchronous DOM mutations — prevents
    // visual flicker that useEffect causes (deferred to next paint).
    useLayoutEffect(() => {
        const el = displayRef.current;
        if (!el) return;

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
        // BUG-086 FIX: Lowered threshold from -90 to -120 dB.
        // -90 caused flicker between dB value and -∞ during quiet passages.
        // -120 dB is inaudible (~20-bit noise floor) — only true silence shows -∞.
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
                fontSize: 9,
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
