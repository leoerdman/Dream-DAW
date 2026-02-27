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
 * Decays after 4 seconds of inactivity. Click to reset.
 */
export const MixerChannelPeakLabel = memo(function MixerChannelPeakLabel({
    trackIndex,
}: {
    trackIndex: number;
}) {
    const meterPair = useEngineStore((s) => s.meters.tracks[trackIndex]);
    const resetMeterPeakHold = useEngineStore((s) => s.resetMeterPeakHold);
    const holdL = meterPair?.[0]?.peak_hold ?? -96;
    const holdR = meterPair?.[1]?.peak_hold ?? -96;

    const displayRef = useRef<HTMLDivElement>(null);

    // Direct DOM update — bypasses React render for 30Hz performance
    useEffect(() => {
        if (displayRef.current) {
            const maxDb = Math.max(holdL, holdR);
            const hasClipped = maxDb >= 0;
            const text = Number.isFinite(maxDb) && maxDb > -90
                ? formatDb(maxDb)
                : '-∞';

            if (displayRef.current.textContent !== text) {
                displayRef.current.textContent = text;
            }

            const color = hasClipped ? 'var(--color-status-error)' : 'var(--color-text-secondary)';
            if (displayRef.current.style.color !== color) {
                displayRef.current.style.color = color;
            }
        }
    });

    const resetPeak = useCallback(() => {
        resetMeterPeakHold(trackIndex);
        if (displayRef.current) {
            displayRef.current.textContent = '-∞';
            displayRef.current.style.color = 'var(--color-text-secondary)';
        }
    }, [resetMeterPeakHold, trackIndex]);

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
