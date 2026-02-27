import { memo } from 'react';
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

export const MixerChannelPeakLabel = memo(function MixerChannelPeakLabel({
    trackIndex,
}: {
    trackIndex: number;
}) {
    const meterPair = useEngineStore((s) => s.meters.tracks[trackIndex]);
    const peakDbL = meterPair?.[0]?.peak ?? -96;
    const peakDbR = meterPair?.[1]?.peak ?? -96;

    return (
        <div style={{ display: 'flex', gap: 2, justifyContent: 'center', fontSize: 8, fontFamily: 'var(--font-role-data)', color: 'var(--color-text-tertiary)', padding: '1px 0 2px', flexShrink: 0 }}>
            <div style={{ width: 22, background: 'var(--surface-elevated)', borderRadius: 1, padding: '1px 0', textAlign: 'center', border: '1px solid color-mix(in srgb, var(--text-primary) 5%, transparent)' }}>
                {Number.isFinite(peakDbL) && peakDbL > -90 ? formatDb(peakDbL) : '-∞'}
            </div>
            <div style={{ width: 22, background: 'var(--surface-elevated)', borderRadius: 1, padding: '1px 0', textAlign: 'center', border: '1px solid color-mix(in srgb, var(--text-primary) 5%, transparent)' }}>
                {Number.isFinite(peakDbR) && peakDbR > -90 ? formatDb(peakDbR) : '-∞'}
            </div>
        </div>
    );
});
