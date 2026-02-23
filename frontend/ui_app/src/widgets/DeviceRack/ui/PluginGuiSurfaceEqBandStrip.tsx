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
        <div style={{ ...metaStyle, alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, marginRight: 4, fontSize: 10 }}>{eqTitle}</span>
            {bands.filter((b) => b.enabled).map((band) => (
                <span
                    key={band.idx}
                    style={{
                        color: band.color,
                        cursor: 'pointer',
                        padding: 'var(--space-px) var(--token-size-px-5)',
                        borderRadius: 3,
                        background: (selectedEqBand === band.idx || dragEqBand === band.idx) ? 'var(--token-color-rgba-255-255-255-0d08)' : 'transparent',
                        fontSize: 10,
                        fontWeight: (selectedEqBand === band.idx || dragEqBand === band.idx) ? 700 : 400,
                        transition: 'all 0.15s ease',
                    }}
                    onClick={() => setSelectedEqBand(band.idx)}
                    onDoubleClick={() => onParamChange(`B${band.idx}En`, 0)}
                >
                    {band.freq >= 1000 ? `${(band.freq / 1000).toFixed(1)}k` : band.freq.toFixed(0)}
                </span>
            ))}
            <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.6 }}>Out {out > 0 ? '+' : ''}{out.toFixed(1)}dB</span>
        </div>
    );
}
