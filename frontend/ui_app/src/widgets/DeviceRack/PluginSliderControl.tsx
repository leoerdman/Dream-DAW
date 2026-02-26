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
    onGestureStart,
    onGestureEnd,
    onContextMenu: onRightClickFn,
}: {
    param: PluginParam;
    onChange: (paramName: string, value: number) => void;
    onGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onGestureEnd?: (paramName: string) => void;
    onContextMenu?: (e: React.MouseEvent, paramName: string) => void;
}) => (
    <label style={sliderLabelStyle} onContextMenu={(e) => onRightClickFn?.(e, param.name)}>
        <span style={sliderTextStyle}>
            {param.name} <span style={sliderValueStyle}>{formatPluginParamValue(param)}</span>
        </span>
        <input
            type="range"
            min={param.min}
            max={param.max}
            step={param.step ?? Math.max(0.001, (param.max - param.min) / 100)}
            value={param.value}
            onPointerDown={() => onGestureStart?.(param.name)}
            onPointerUp={() => onGestureEnd?.(param.name)}
            onChange={(e) => onChange(param.name, Number(e.target.value))}
            style={sliderInputStyle}
        />
    </label>
);
