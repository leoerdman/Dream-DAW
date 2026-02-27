import { memo, useCallback, useEffect, useRef } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { MeterStrip } from '@/shared/ui/MeterStrip';
import { vuNorm } from '@/shared/lib/audioMath';
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
    const meterL = Math.max(0, Math.min(1, vuNorm((peakDbL * 0.7) + (rmsDbL * 0.3))));
    const meterR = Math.max(0, Math.min(1, vuNorm((peakDbR * 0.7) + (rmsDbR * 0.3))));

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

/**
 * Peak hold label: shows the maximum peak dB reached.
 * Decays after PEAK_HOLD_MS of inactivity. Click to reset.
 */
const PEAK_HOLD_MS = 2000;

export const MixerChannelPeakLabel = memo(function MixerChannelPeakLabel({
    trackIndex,
}: {
    trackIndex: number;
}) {
    const meterPair = useEngineStore((s) => s.meters.tracks[trackIndex]);
    const liveL = meterPair?.[0]?.peak ?? -96;
    const liveR = meterPair?.[1]?.peak ?? -96;

    // Peak hold state (in refs to avoid re-renders on every meter tick)
    const holdL = useRef(-96);
    const holdR = useRef(-96);
    const holdTs = useRef(0);
    const displayRef = useRef<HTMLDivElement>(null);

    // Update hold values on every meter tick
    useEffect(() => {
        const now = performance.now();
        const elapsed = now - holdTs.current;

        // If new peak is higher, or hold expired → update
        if (liveL > holdL.current || liveR > holdR.current || elapsed > PEAK_HOLD_MS) {
            if (liveL > holdL.current) holdL.current = liveL;
            if (liveR > holdR.current) holdR.current = liveR;
            holdTs.current = now;
        }

        // Decay: if hold expired and live signal is lower, reset to live
        if (elapsed > PEAK_HOLD_MS) {
            holdL.current = liveL;
            holdR.current = liveR;
            holdTs.current = now;
        }

        // Direct DOM update — bypasses React render for 30Hz performance
        if (displayRef.current) {
            const maxDb = Math.max(holdL.current, holdR.current);
            const hasClipped = maxDb >= 0;
            const text = Number.isFinite(maxDb) && maxDb > -90
                ? formatDb(maxDb)
                : '-∞';
            displayRef.current.textContent = text;
            displayRef.current.style.color = hasClipped
                ? 'var(--color-status-error)'
                : 'var(--color-text-secondary)';
        }
    });

    const resetPeak = useCallback(() => {
        holdL.current = -96;
        holdR.current = -96;
        holdTs.current = performance.now();
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
