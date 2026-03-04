export type PluginFormat = 'INT' | 'VST2' | 'VST3' | 'AU';
export type PluginCategory = 'instrument' | 'effect' | 'midi-fx';
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
    | 'midiChord'
    | 'midiNoteLength'
    | 'midiCcControl'
    | 'midiExpressionControl'
    | 'midiArpeggiator'
    | 'midiVelocity'
    | 'midiRandom'
    | 'vst'
    | 'instrument'
    | 'sampler'
    | 'sample_rack'
    | 'saturator'
    | 'waveSynth'
    | 'rack'
    // ── Wave 3: Full effect processor support ─────────────────────
    | 'overdrive'
    | 'transientShaper'
    | 'drumBuss'
    | 'dynamicTube'
    | 'phaserFlanger'
    | 'amp'
    | 'cabinet'
    | 'hybridReverb'
    | 'erosion'
    | 'pedal'
    | 'roar'
    | 'multibandDynamics'
    | 'grainDelay'
    | 'corpus'
    | 'spectralTime'
    | 'glueCompressor'
    | 'filterDelay';

export interface PluginManifestEntry {
    id: string;
    name: string;
    category: PluginCategory;
    effectType: DeviceEffectType;
    format: PluginFormat;
    hasEditor: boolean;
    cardWidth: number;
    supportsSettings: boolean;
    supportsSidechain: boolean;
}

export interface ResolvedPlugin {
    effectType: DeviceEffectType;
    format: PluginFormat;
    hasEditor: boolean;
    cardWidth: number;
    supportsSettings: boolean;
    supportsSidechain: boolean;
    category: PluginCategory;
    displayName: string;
}
