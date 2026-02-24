import { PRESET_VALUES } from './EssenceSynth.config';

type ParamSetter = (paramName: string, value: number) => void;
type ClampFn = (name: string, value: number) => number;

export const applyEssencePreset = (
    presetId: string,
    onParamChange: ParamSetter,
    clampToParam: ClampFn,
): void => {
    const values = PRESET_VALUES[presetId];
    if (!values) return;
    for (const [name, value] of Object.entries(values)) {
        onParamChange(name, clampToParam(name, value));
    }
    onParamChange('Osc1Enabled', 1);
    onParamChange('Osc2Enabled', 1);
    if (values.Osc1Vol !== undefined) onParamChange('Osc1Vol', values.Osc1Vol);
    if (values.Osc2Vol !== undefined) onParamChange('Osc2Vol', values.Osc2Vol);
};

export const randomizeEssenceSynth = (
    onParamChange: ParamSetter,
    clampToParam: ClampFn,
): void => {
    const r = (min: number, max: number, step = 0.01) => {
        const raw = min + Math.random() * (max - min);
        return Math.round(raw / step) * step;
    };
    onParamChange('Osc1Enabled', 1);
    onParamChange('Osc2Enabled', Math.random() > 0.3 ? 1 : 0);
    onParamChange('Osc1Wave', clampToParam('Osc1Wave', Math.floor(Math.random() * 4)));
    onParamChange('Osc2Wave', clampToParam('Osc2Wave', Math.floor(Math.random() * 4)));
    onParamChange('Osc1Vol', clampToParam('Osc1Vol', r(0.5, 1.0)));
    onParamChange('Osc2Vol', clampToParam('Osc2Vol', r(0.3, 0.9)));
    onParamChange('Detune', clampToParam('Detune', r(-18, 18, 0.1)));
    onParamChange('Sub', clampToParam('Sub', r(0, 0.5)));
    onParamChange('Cutoff', clampToParam('Cutoff', r(200, 8000, 1)));
    onParamChange('Res', clampToParam('Res', r(0, 0.8)));
    onParamChange('FiltType', clampToParam('FiltType', Math.floor(Math.random() * 4)));
    onParamChange('Vol', clampToParam('Vol', r(0.7, 1.0)));
    onParamChange('Attack', clampToParam('Attack', r(0.001, 0.18, 0.001)));
    onParamChange('Decay', clampToParam('Decay', r(0.03, 1.8, 0.001)));
    onParamChange('Sustain', clampToParam('Sustain', r(0.25, 1.0)));
    onParamChange('Release', clampToParam('Release', r(0.02, 2.2, 0.001)));
    onParamChange('LfoRate', clampToParam('LfoRate', r(0.1, 12, 0.1)));
    onParamChange('LfoDepth', clampToParam('LfoDepth', r(0, 0.6)));
    onParamChange('LfoTarget', clampToParam('LfoTarget', Math.floor(Math.random() * 3)));
    onParamChange('PulseWidth', clampToParam('PulseWidth', r(0.1, 0.9, 0.01)));
};
