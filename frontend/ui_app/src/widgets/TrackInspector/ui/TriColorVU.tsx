import { MeterStrip } from '@/shared/ui/MeterStrip';
import { dbToMeterNorm } from '@/shared/lib/meterManifest';

export type TriColorVUProps = {
    peakDb: number;
    peakDbL?: number;
    peakDbR?: number;
    isMidi: boolean;
    compact?: boolean;
    isEnabled?: boolean;
    trackHeight?: number;
};

export const TriColorVU = ({
    peakDb,
    peakDbL,
    peakDbR,
    isMidi,
    compact = false,
    isEnabled = true,
    trackHeight,
}: TriColorVUProps) => {
    const lDb = peakDbL ?? peakDb;
    const rDb = peakDbR ?? peakDb;
    const normL = dbToMeterNorm(lDb);
    const normR = dbToMeterNorm(rDb);
    const meterHeight = trackHeight ? Math.max(14, trackHeight - 6) : (compact ? 28 : 32);

    return (
        <div
            style={{
                width: 9,
                height: meterHeight,
                flexShrink: 0,
                position: 'relative',
                filter: isEnabled ? 'none' : 'grayscale(1)',
                opacity: isEnabled ? 1 : 0.5,
                transition: 'filter var(--transition-fast), opacity var(--transition-fast)',
            }}
        >
            <MeterStrip
                levelL={normL}
                levelR={normR}
                isMidi={isMidi}
                width={9}
                style={{ position: 'absolute', inset: 0 }}
            />
        </div>
    );
};
