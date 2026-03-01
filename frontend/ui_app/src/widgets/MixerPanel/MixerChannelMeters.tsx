import { memo, useCallback, useLayoutEffect, useRef } from 'react';
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

export const MixerChannelMeters = memo(function MixerChannelMeters({
    trackIndex,
    isMidi,
    meterWidth,
}: MixerChannelMetersProps) {
    const meterPair = useEngineStore((s) => s.meters.tracks[trackIndex]);
    const peakDbL = meterPair?.[0]?.peak ?? -96;
    const peakDbR = meterPair?.[1]?.peak ?? -96;
    const rmsDbL = meterPair?.[0]?.rms ?? -96;
    const rmsDbR = meterPair?.[1]?.rms ?? -96;
    const meterL = clamp01(dbToMeterNorm((peakDbL * 0.7) + (rmsDbL * 0.3)));
    const meterR = clamp01(dbToMeterNorm((peakDbR * 0.7) + (rmsDbR * 0.3)));

    return (
        <>
            <div style={{ width: meterWidth, position: 'relative', borderRadius: 'var(--radius-xs)', overflow: 'hidden', background: 'var(--surface-elevated)', border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>
                <MeterStrip levelL={meterL} levelR={meterL} isMidi={isMidi} width={meterWidth} show0dBLine style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
            </div>
            <div style={{ width: meterWidth, position: 'relative', borderRadius: 'var(--radius-xs)', overflow: 'hidden', background: 'var(--surface-elevated)', border: '1px solid color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>
                <MeterStrip levelL={meterR} levelR={meterR} isMidi={isMidi} width={meterWidth} show0dBLine style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
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

    // Read instantaneous peaks from the smoothed meter store
    const peakL = meterPair?.[0]?.peak ?? -160;
    const peakR = meterPair?.[1]?.peak ?? -160;
    const currentPeak = Math.max(peakL, peakR);

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
        if (displayRef.current) {
            displayRef.current.textContent = '-∞';
            displayRef.current.style.color = 'var(--color-text-secondary)';
        }
    }, []);

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
