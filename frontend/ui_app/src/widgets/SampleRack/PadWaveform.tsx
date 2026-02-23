import { memo, useEffect, useState } from 'react';
import * as engineApi from '@/shared/api/engine';

export const PadWaveform = memo(function PadWaveform({ samplePath }: { samplePath: string }) {
    const [peaks, setPeaks] = useState<engineApi.PeakPair[] | null>(null);

    useEffect(() => {
        if (!samplePath) {
            let cancelled = false;
            queueMicrotask(() => {
                if (!cancelled) setPeaks(null);
            });
            return () => {
                cancelled = true;
            };
        }

        let cancelled = false;
        engineApi.getWaveformPeaksBinary(samplePath)
            .then((wf) => {
                if (cancelled) return;
                const level = wf.mip_levels[0] ?? wf.mip_levels[wf.mip_levels.length - 1];
                const rawPeaks = level?.peaks ?? [];
                const target = 20;
                if (rawPeaks.length <= target) {
                    setPeaks(rawPeaks);
                    return;
                }
                const reduced: engineApi.PeakPair[] = [];
                const bucket = rawPeaks.length / target;
                for (let i = 0; i < target; i += 1) {
                    const s = Math.floor(i * bucket);
                    const e = Math.min(rawPeaks.length, Math.max(s + 1, Math.floor((i + 1) * bucket)));
                    let mn = 1;
                    let mx = -1;
                    for (let j = s; j < e; j += 1) {
                        if (rawPeaks[j].min < mn) mn = rawPeaks[j].min;
                        if (rawPeaks[j].max > mx) mx = rawPeaks[j].max;
                    }
                    reduced.push({ min: mn, max: mx });
                }
                setPeaks(reduced);
            })
            .catch(() => {
                if (!cancelled) setPeaks(null);
            });
        return () => {
            cancelled = true;
        };
    }, [samplePath]);

    if (!peaks || peaks.length === 0) return null;

    const w = 44;
    const h = 18;
    const barW = w / peaks.length;

    return (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ opacity: 0.6 }}>
            {peaks.map((p, i) => {
                const mid = h / 2;
                const yMax = mid - Math.max(-1, Math.min(1, p.max)) * mid;
                const yMin = mid - Math.max(-1, Math.min(1, p.min)) * mid;
                const barH = Math.max(1, yMin - yMax);
                return <rect key={i} x={i * barW} y={yMax} width={Math.max(0.8, barW - 0.3)} height={barH} fill="#5ce0a6" rx={0.3} />;
            })}
        </svg>
    );
});

