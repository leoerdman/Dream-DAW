import React from 'react';
import type { EqBand8 } from '@/widgets/DeviceRack/lib/eqMath';

type Props = {
    eqTitle: string;
    bands: EqBand8[];
    selectedEqBand: number | null;
    dragEqBand: number | null;
    out: number;
    setSelectedEqBand: React.Dispatch<React.SetStateAction<number | null>>;
    onParamChange: (paramName: string, value: number) => void;
    metaStyle: React.CSSProperties;
};

export function PluginGuiSurfaceEqBandStrip({
    eqTitle,
    bands,
    selectedEqBand,
    dragEqBand,
    out,
    setSelectedEqBand,
    onParamChange,
    metaStyle,
}: Props): React.ReactNode {
    return (
        <div style={{ ...metaStyle, alignItems: 'center', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, marginRight: 4, fontSize: 'var(--font-size-2xs)' }}>{eqTitle}</span>
            {bands.filter((b) => b.enabled).map((band) => (
                <span
                    key={band.idx}
                    style={{
                        color: (selectedEqBand === band.idx || dragEqBand === band.idx)
                            ? 'color-mix(in srgb, var(--color-text-primary) 94%, transparent)'
                            : 'color-mix(in srgb, var(--color-text-primary) 78%, transparent)',
                        cursor: 'pointer',
                        padding: 'var(--space-px) var(--token-size-px-5)',
                        borderRadius: 'var(--radius-xs)',
                        background: (selectedEqBand === band.idx || dragEqBand === band.idx)
                            ? 'color-mix(in srgb, var(--color-text-primary) 10%, transparent)'
                            : 'transparent',
                        fontSize: 'var(--font-size-2xs)',
                        fontWeight: (selectedEqBand === band.idx || dragEqBand === band.idx) ? 700 : 400,
                        transition: 'all 0.15s ease',
                    }}
                    onClick={() => setSelectedEqBand(band.idx)}
                    onDoubleClick={() => onParamChange(`B${band.idx}En`, 0)}
                >
                    {band.freq >= 1000 ? `${(band.freq / 1000).toFixed(1)}k` : band.freq.toFixed(0)}
                </span>
            ))}
            <span style={{ marginLeft: 'auto', fontSize: 'var(--font-size-2xs)', opacity: 0.6 }}>Out {Number.isFinite(out) ? `${out > 0 ? '+' : ''}${out.toFixed(1)}` : '0.0'}dB</span>
        </div>
    );
}
