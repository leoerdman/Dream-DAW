import type { PluginParam } from './StandardPluginControlTypes';

const DRAG_SCALE_NORMAL_PX = 220;
const DRAG_SCALE_SHIFT_PX = 130;
const DRAG_SCALE_ALT_PX = 760;

export const formatPluginParamValue = (param: PluginParam): string => {
    const v = Number.isFinite(param.value) ? param.value : 0;
    const precision = param.step && param.step < 1 ? 2 : 0;
    return `${v.toFixed(precision)}${param.suffix ?? ''}`;
};

export const roundPluginParamForDisplay = (param: PluginParam, value: number): number => {
    const precision = param.step && param.step < 1 ? 2 : 0;
    const factor = 10 ** precision;
    return Math.round(value * factor) / factor;
};

export const formatPluginParamName = (raw: string): string => {
    const withSpaces = raw
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[._-]+/g, ' ')
        .trim();
    return withSpaces.length > 0 ? withSpaces.toUpperCase() : raw.toUpperCase();
};

export const defaultParamValue = (param: PluginParam): number => {
    if (Number.isFinite(param.defaultValue)) {
        return Math.max(param.min, Math.min(param.max, param.defaultValue as number));
    }
    const name = param.name.toLowerCase();
    if (param.min <= 0 && param.max >= 0) return 0;
    if (name.includes('mix') || name.includes('width') || name.includes('amount') || name.includes('depth')) {
        return (param.min + param.max) * 0.5;
    }
    if (name.includes('gain') || name.includes('volume') || name === 'vol') {
        return Math.min(param.max, Math.max(param.min, 0));
    }
    return Math.min(param.max, Math.max(param.min, (param.min + param.max) * 0.5));
};

export const resolveKnobDragScalePx = (shiftKey: boolean, altKey: boolean): number => {
    if (shiftKey) return DRAG_SCALE_SHIFT_PX;
    if (altKey) return DRAG_SCALE_ALT_PX;
    return DRAG_SCALE_NORMAL_PX;
};
