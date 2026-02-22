import { memo, type MouseEvent } from 'react';
import { PluginKnob, type PluginParam } from '@/widgets/DeviceRack/StandardPluginControls';

type MacroKnobProps = {
    param: PluginParam;
    compact?: boolean;
    label?: string;
    onChange: (paramName: string, value: number) => void;
    onContextMenu?: (e: MouseEvent, paramName: string) => void;
    onGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onGestureEnd?: (paramName: string) => void;
};

const areEqual = (prev: MacroKnobProps, next: MacroKnobProps): boolean => (
    prev.compact === next.compact
    && prev.label === next.label
    && prev.onChange === next.onChange
    && prev.onContextMenu === next.onContextMenu
    && prev.onGestureStart === next.onGestureStart
    && prev.onGestureEnd === next.onGestureEnd
    && prev.param.name === next.param.name
    && prev.param.value === next.param.value
    && prev.param.min === next.param.min
    && prev.param.max === next.param.max
    && prev.param.step === next.param.step
    && prev.param.suffix === next.param.suffix
    && prev.param.defaultValue === next.param.defaultValue
);

export const MacroKnob = memo((props: MacroKnobProps) => (
    <PluginKnob {...props} />
), areEqual);

MacroKnob.displayName = 'MacroKnob';
