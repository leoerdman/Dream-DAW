import {
    sliderInputStyle,
    sliderLabelStyle,
    sliderTextStyle,
    sliderValueStyle,
} from './StandardPluginControlStyles';
import { formatPluginParamValue } from './StandardPluginControlUtils';
import type { PluginParam } from './StandardPluginControlTypes';

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
            step={param.step ?? Math.max(0.001, (param.max - param.min) / 100)}
            value={param.value}
            onChange={(e) => onChange(param.name, Number(e.target.value))}
            style={sliderInputStyle}
        />
    </label>
);
