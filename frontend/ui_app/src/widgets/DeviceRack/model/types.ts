import type { PluginParam } from '@/widgets/DeviceRack/StandardPluginControls';

export type DeviceEffectType =
    | 'eq'
    | 'compressor'
    | 'delay'
    | 'reverb'
    | 'chorus'
    | 'utility'
    | 'limiter'
    | 'gate'
    | 'autoFilter'
    | 'autoPan'
    | 'phaser'
    | 'flanger'
    | 'distortion'
    | 'bitcrusher'
    | 'noiseMachine'
    | 'analyzer'
    | 'spectrum'
    | 'midiPitch'
    | 'midiScale'
    | 'midiVelocity'
    | 'midiRandom'
    | 'vst'
    | 'instrument'
    | 'sampler'
    | 'saturator'
    | 'waveSynth'
    | 'sample_rack'
    | 'rack';

export interface DeviceSlot {
    id: string;
    name: string;
    effectType: DeviceEffectType;
    isEnabled: boolean;
    params: PluginParam[];
    sampleRackConfig?: unknown;
    vuLevel: number;
    vuLevelL: number;
    vuLevelR: number;
    pluginId: string;
    isVst: boolean;
    source: 'internal' | 'vst' | 'unknown';
    samplePath?: string;
    supportsSidechain?: boolean;
    sidechainSourceTrackId?: string | null;
    guiMode?: string;
}

export type QuickPreset = {
    label: string;
    values: Record<string, number>;
};
