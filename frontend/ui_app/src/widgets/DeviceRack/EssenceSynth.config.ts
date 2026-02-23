export const WAVEFORMS = [
    { idx: 0, label: 'Sin', icon: '~' },
    { idx: 1, label: 'Tri', icon: '△' },
    { idx: 2, label: 'Saw', icon: '⬧' },
    { idx: 3, label: 'Sqr', icon: '□' },
] as const;

export const FILTER_TYPES = [
    { idx: 0, label: 'LP' },
    { idx: 1, label: 'HP' },
    { idx: 2, label: 'BP' },
    { idx: 3, label: 'NT' },
] as const;

export const LFO_TARGETS = [
    { idx: 0, label: 'Filter' },
    { idx: 1, label: 'Pitch' },
    { idx: 2, label: 'Volume' },
] as const;

export const PRESETS = [
    { id: 'init', label: 'INIT' },
    { id: 'bass', label: 'BASS' },
    { id: 'lead', label: 'LEAD' },
    { id: 'pad', label: 'PAD' },
    { id: 'pluck', label: 'PLUCK' },
] as const;

export const PRESET_VALUES: Record<string, Record<string, number>> = {
    init: {
        Osc1Wave: 0, Osc2Wave: 2, Mix: 0.35, Detune: 0, Sub: 0,
        Cutoff: 20000, Res: 0, FiltType: 0, Vol: 1,
        Attack: 0.01, Decay: 0.1, Sustain: 1, Release: 0.05,
        LfoRate: 1, LfoDepth: 0, LfoTarget: 0, PulseWidth: 0.5,
    },
    bass: {
        Osc1Wave: 2, Osc2Wave: 3, Mix: 0.58, Detune: -4.8, Sub: 0.42,
        Cutoff: 980, Res: 0.26, FiltType: 0, Vol: 1.18,
        Attack: 0.004, Decay: 0.2, Sustain: 0.62, Release: 0.16,
        LfoRate: 0.8, LfoDepth: 0.15, LfoTarget: 0, PulseWidth: 0.5,
    },
    lead: {
        Osc1Wave: 3, Osc2Wave: 2, Mix: 0.45, Detune: 8.5, Sub: 0.12,
        Cutoff: 5200, Res: 0.34, FiltType: 1, Vol: 1.05,
        Attack: 0.006, Decay: 0.22, Sustain: 0.7, Release: 0.28,
        LfoRate: 4.5, LfoDepth: 0.1, LfoTarget: 1, PulseWidth: 0.5,
    },
    pad: {
        Osc1Wave: 1, Osc2Wave: 0, Mix: 0.63, Detune: 13.2, Sub: 0.18,
        Cutoff: 2600, Res: 0.2, FiltType: 0, Vol: 0.92,
        Attack: 0.42, Decay: 0.72, Sustain: 0.84, Release: 1.6,
        LfoRate: 0.3, LfoDepth: 0.2, LfoTarget: 0, PulseWidth: 0.5,
    },
    pluck: {
        Osc1Wave: 2, Osc2Wave: 3, Mix: 0.2, Detune: 2.4, Sub: 0.06,
        Cutoff: 1800, Res: 0.62, FiltType: 0, Vol: 1.08,
        Attack: 0.001, Decay: 0.09, Sustain: 0.18, Release: 0.14,
        LfoRate: 1, LfoDepth: 0, LfoTarget: 0, PulseWidth: 0.5,
    },
};

export const wavePath = (waveIndex: number): string => {
    switch (waveIndex) {
        case 1: return 'M 0 50 L 12.5 20 L 37.5 80 L 62.5 20 L 87.5 80 L 100 50';
        case 2: return 'M 0 70 L 25 30 L 50 70 L 75 30 L 100 70';
        case 3: return 'M 0 70 L 0 30 L 25 30 L 25 70 L 50 70 L 50 30 L 75 30 L 75 70 L 100 70';
        default: return 'M 0 50 C 8 10, 17 10, 25 50 C 33 90, 42 90, 50 50 C 58 10, 67 10, 75 50 C 83 90, 92 90, 100 50';
    }
};

export function buildAdsrPath(a: number, d: number, s: number, r: number): string {
    const width = 120;
    const height = 28;
    const pad = 2;
    const usable = width - pad * 2;
    const top = pad + 2;
    const bottom = height - pad;
    const range = bottom - top;

    const totalTime = Math.max(0.01, a + d + r + 0.3);
    const aW = (a / totalTime) * usable * 0.8;
    const dW = (d / totalTime) * usable * 0.8;
    const sW = usable * 0.15;
    const rW = Math.min(usable - aW - dW - sW, (r / totalTime) * usable * 0.8);

    const x0 = pad;
    const x1 = x0 + aW;
    const x2 = x1 + dW;
    const x3 = x2 + sW;
    const x4 = x3 + rW;

    const yTop = top;
    const ySustain = bottom - s * range;
    const yBottom = bottom;

    return `M ${x0} ${yBottom} L ${x1} ${yTop} L ${x2} ${ySustain} L ${x3} ${ySustain} L ${x4} ${yBottom}`;
}
