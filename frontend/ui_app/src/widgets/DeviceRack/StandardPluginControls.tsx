import type { CSSProperties } from 'react';

export interface PluginParam {
    name: string;
    value: number;
    min: number;
    max: number;
    suffix: string;
    step?: number;
}

const formatPluginParamValue = (param: PluginParam): string => {
    const precision = param.step && param.step < 1 ? 2 : 0;
    return `${param.value.toFixed(precision)}${param.suffix}`;
};

export const PluginSlider = ({
    param,
    onChange,
}: {
    param: PluginParam;
    onChange: (paramName: string, value: number) => void;
}) => (
    <label style={sliderLabelStyle}>
        <span style={sliderTextStyle}>
            {param.name} <span style={sliderValueStyle}>{formatPluginParamValue(param)}</span>
        </span>
        <input
            type="range"
            min={param.min}
            max={param.max}
            step={param.step ?? (param.max - param.min) / 100}
            value={param.value}
            onChange={(e) => onChange(param.name, Number(e.target.value))}
            style={sliderInputStyle}
        />
    </label>
);

export const PluginKnob = ({
    param,
    compact = false,
    onChange,
}: {
    param: PluginParam;
    compact?: boolean;
    onChange: (paramName: string, value: number) => void;
}) => {
    const pct = Math.max(0, Math.min(1, (param.value - param.min) / Math.max(1e-9, param.max - param.min)));
    const angle = -135 + pct * 270;
    const size = compact ? 34 : 42;
    const markerHeight = compact ? 11 : 14;
    const markerTopOffset = compact ? '-84%' : '-88%';

    return (
        <label style={knobLabelStyle(compact)}>
            <span style={knobParamNameStyle}>{param.name}</span>
            <div style={{ position: 'relative', width: size, height: size }}>
                <div style={knobDialStyle}>
                    <div
                        style={{
                            ...knobMarkerStyle,
                            height: markerHeight,
                            transform: `translate(-50%, ${markerTopOffset}) rotate(${angle}deg)`,
                        }}
                    />
                </div>
                <input
                    type="range"
                    min={param.min}
                    max={param.max}
                    step={param.step ?? (param.max - param.min) / 100}
                    value={param.value}
                    onChange={(e) => onChange(param.name, Number(e.target.value))}
                    style={knobInputOverlayStyle}
                />
            </div>
            <span style={knobValueStyle(compact)}>{formatPluginParamValue(param)}</span>
        </label>
    );
};

const sliderLabelStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 110,
};

const sliderTextStyle: CSSProperties = {
    fontSize: 10,
    color: 'var(--color-text-secondary)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
};

const sliderValueStyle: CSSProperties = {
    color: 'var(--color-text-primary)',
    fontFamily: 'var(--font-mono)',
};

const sliderInputStyle: CSSProperties = {
    width: '100%',
    accentColor: 'var(--color-accent-primary)',
    cursor: 'ew-resize',
    height: 14,
    borderRadius: 999,
    background: 'transparent',
};

const knobLabelStyle = (compact: boolean): CSSProperties => ({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: compact ? 3 : 5,
    minWidth: compact ? 56 : 86,
});

const knobParamNameStyle: CSSProperties = {
    fontSize: 10,
    color: 'var(--color-text-secondary)',
    textAlign: 'center',
    lineHeight: 1.1,
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
};

const knobDialStyle: CSSProperties = {
    width: '100%',
    height: '100%',
    borderRadius: '50%',
    background: 'radial-gradient(circle at 35% 28%, #3a3f47 0%, #232831 54%, #13171d 100%)',
    border: '1px solid color-mix(in srgb, var(--color-accent-primary) 24%, rgba(255,255,255,0.2))',
    boxShadow: 'inset 0 1px 2px rgba(255,255,255,0.09), inset 0 -2px 5px rgba(0,0,0,0.58), 0 0 0 1px rgba(10,14,18,0.6)',
    position: 'relative',
};

const knobMarkerStyle: CSSProperties = {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: 2,
    background: 'var(--color-accent-primary)',
    transformOrigin: '50% 90%',
    borderRadius: 999,
    boxShadow: '0 0 5px color-mix(in srgb, var(--color-accent-primary) 68%, transparent)',
};

const knobInputOverlayStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    opacity: 0,
    cursor: 'ns-resize',
};

const knobValueStyle = (compact: boolean): CSSProperties => ({
    fontSize: compact ? 9 : 10,
    color: 'var(--color-text-primary)',
    fontFamily: 'var(--font-mono)',
    opacity: 0.92,
});
