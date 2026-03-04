import type { PluginParam } from '@/widgets/DeviceRack/StandardPluginControls';
import type { RackInfo } from '@/shared/lib/trackAdapter';
export type { PluginParam } from '@/widgets/DeviceRack/StandardPluginControls';
export type { RackInfo } from '@/shared/lib/trackAdapter';

export type DeviceEffectType =
    | 'eq'
    | 'bandEq'
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
    // BUG-33/34/35/36/37 FIX: New MIDI effect types.
    | 'midiChord'
    | 'midiNoteLength'
    | 'midiCcControl'
    | 'midiExpressionControl'
    | 'midiArpeggiator'
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
    isBypassed?: boolean;
    isMissing?: boolean;
    params: PluginParam[];
    sampleRackConfig?: unknown;
    vuLevel?: number;
    vuLevelL?: number;
    vuLevelR?: number;
    pluginId: string;
    isVst: boolean;
    source: 'internal' | 'vst' | 'missing' | 'unknown';
    samplePath?: string;
    waveformIndex?: number;
    supportsSidechain?: boolean;
    sidechainSourceTrackId?: string | null;
    guiMode?: string;
    /** Present only when this slot represents a device rack. */
    rack?: RackInfo;
}

export type QuickPreset = {
    label: string;
    values: Record<string, number>;
};
