import { memo, useEffect, useState } from 'react';
import * as engineApi from '@/shared/api/engine';
import { downsamplePeaks, selectFinestMipLevel } from '@/shared/lib/waveformUtils';

export const PadWaveform = memo(function PadWaveform({ samplePath }: { samplePath: string }) {
    const [peaks, setPeaks] = useState<engineApi.PeakPair[] | null>(null);

    useEffect(() => {
        if (!samplePath) {
            let cancelled = false;
            const rafId = requestAnimationFrame(() => {
                if (!cancelled) setPeaks(null);
            });
            return () => {
                cancelled = true;
                cancelAnimationFrame(rafId);
            };
        }

        let cancelled = false;
        engineApi.getWaveformPeaksBinary(samplePath)
            .then((wf) => {
                if (cancelled) return;
                const rawPeaks = selectFinestMipLevel(wf.mip_levels);
                setPeaks(downsamplePeaks(rawPeaks, 20));
            })
            .catch((err) => {
                // BUG-R4-035b FIX: Log instead of silently swallowing.
                console.warn('[Dream] waveform peaks load failed:', err);
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
                return <rect key={i} x={i * barW} y={yMax} width={Math.max(0.8, barW - 0.3)} height={barH} fill="var(--token-color-hex-5ce0a6)" rx={0.3} />;
            })}
        </svg>
    );
});
