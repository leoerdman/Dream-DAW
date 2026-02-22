use dream_models::project::{DeviceNode, Track};
use uuid::Uuid;

/// Utility helpers for mutating `Track.effects` chains in a deterministic way.
pub struct DeviceChain;

impl DeviceChain {
    /// Inserts an effect node into a track FX chain.
    ///
    /// Returns the runtime slot index for internal effects (used by engine commands),
    /// otherwise `None` for external devices/racks.
    pub fn insert_effect(
        track: &mut Track,
        node: DeviceNode,
        target_index: Option<usize>,
    ) -> Option<u8> {
        let idx = target_index
            .unwrap_or(track.effects.len())
            .min(track.effects.len());

        let runtime_slot = if is_internal_effect_node(&node) {
            Some(count_internal_effects_before(&track.effects, idx) as u8)
        } else {
            None
        };

        track.effects.insert(idx, node);
        runtime_slot
    }

    /// Removes effect node by UUID.
    ///
    /// Returns removed node + runtime slot index for internal effects.
    pub fn remove_effect(track: &mut Track, slot_id: Uuid) -> Option<(DeviceNode, Option<u8>)> {
        let index = track.effects.iter().position(|n| n.id() == slot_id)?;
        let runtime_slot = if is_internal_effect_node(&track.effects[index]) {
            Some(count_internal_effects_before(&track.effects, index) as u8)
        } else {
            None
        };

        let node = track.effects.remove(index);
        Some((node, runtime_slot))
    }

    /// Moves an effect node within the same chain.
    pub fn move_effect(track: &mut Track, slot_id: Uuid, target_index: usize) -> Result<(), String> {
        let from = track
            .effects
            .iter()
            .position(|node| node.id() == slot_id)
            .ok_or_else(|| format!("Effect slot not found: {slot_id}"))?;

        if track.effects.is_empty() {
            return Ok(());
        }

        let node = track.effects.remove(from);
        let to = target_index.min(track.effects.len());
        track.effects.insert(to, node);
        Ok(())
    }
}

/// Shared canonical mapping used by runtime plugin drop/import paths.
pub fn canonical_internal_plugin(
    plugin_id: &str,
    plugin_name: &str,
) -> Option<(&'static str, &'static str, &'static str)> {
    let pid = plugin_id.trim().to_lowercase();
    let pname = plugin_name.trim().to_lowercase();

    let is_vst = pid == "plugindevice" || pid == "auplugindevice";
    if !is_vst {
        match pid.as_str() {
            "eq8" | "eqeight" | "channeleq" | "eqthree" => {
                return Some(("internal://effect/eq-eight", "EQ", "effect"));
            }
            "compressor2" | "compressor" | "gluecompressor" | "drumbuss" | "multibanddynamics"
            | "transientshaper" => {
                return Some(("internal://effect/compressor", "Compressor", "effect"));
            }
            "delay" | "echo" | "pingpongdelay" | "filterdelay" | "beatrepeat" | "graindelay"
            | "spectraltime" => return Some(("internal://effect/delay", "Delay", "effect")),
            "reverb" | "hybridreverb" | "corpus" | "resonators" | "spectralresonator" => {
                return Some(("internal://effect/reverb", "Reverb", "effect"));
            }
            "chorus" | "chorus2" | "ensemble" | "vibrato" => {
                return Some(("internal://effect/chorus", "Chorus", "effect"));
            }
            "utility" | "tuner" | "looper" | "frequencyshifter" | "shifter" | "autoshift" => {
                return Some(("internal://effect/utility", "Utility", "effect"));
            }
            "autopan" | "autopan2" => {
                return Some(("internal://effect/auto-pan", "Auto Pan", "effect"));
            }
            "saturator" | "dynamictube" => {
                return Some(("internal://effect/saturator", "Saturator", "effect"));
            }
            "spectrumanalyzer" | "spectrum" => {
                return Some(("internal://effect/spectrum", "Spectrum", "effect"));
            }
            "limiter" => return Some(("internal://effect/limiter", "Limiter", "effect")),
            "gate" => return Some(("internal://effect/gate", "Gate", "effect")),
            "redux" | "bitcrusher" => {
                return Some(("internal://effect/bitcrusher", "Bitcrusher", "effect"));
            }
            "autofilter" | "vocoder" => {
                return Some(("internal://effect/auto-filter", "Auto Filter", "effect"));
            }
            "phasernew" | "phaser" | "phaserflanger" => {
                return Some(("internal://effect/phaser", "Phaser", "effect"));
            }
            "flanger" => return Some(("internal://effect/flanger", "Flanger", "effect")),
            "erosion" | "vinyldistortion" | "distortion" | "overdrive" | "amp" | "cabinet"
            | "pedal" | "roar" => {
                return Some(("internal://effect/distortion", "Distortion", "effect"));
            }
            "noisemachine" => {
                return Some(("internal://effect/noise-machine", "Noise Machine", "effect"));
            }
            "midipitcher" => return Some(("internal://midi-fx/pitch", "MIDI Pitch", "effect")),
            "mxdevicescale" | "midichord" => {
                return Some(("internal://midi-fx/scale", "MIDI Scale", "effect"));
            }
            "mxdevicevelocity" | "midinotelength" | "midivelocity" => {
                return Some(("internal://midi-fx/velocity", "MIDI Velocity", "effect"));
            }
            "mxdevicerandom" | "midiarpeggiator" | "midirandom" => {
                return Some(("internal://midi-fx/random", "MIDI Random", "effect"));
            }
            "originalsimpler" | "multisampler" | "drumcell" | "instrumentimpulse" => {
                return Some(("internal://instrument/sampler", "Sampler", "instrument"));
            }
            "wavetable" | "operator" | "analog" | "collision" | "tension" | "electricpiano"
            | "instrumentmeld" | "drift" | "instrumentvector" | "loungelizard" | "ultraanalog"
            | "stringstudio" => {
                return Some(("internal://instrument/wave-synth", "Wave Synth", "instrument"));
            }
            _ => {}
        }
    }

    if is_vst {
        match pname.as_str() {
            "span" | "youlean loudness meter" | "loudness meter" | "psyscope" => {
                return Some(("internal://effect/spectrum", "Spectrum", "effect"));
            }
            "synthesizer v studio 2 plugin" => {
                return Some(("internal://instrument/wave-synth", "Wave Synth", "instrument"));
            }
            _ => return None,
        }
    }

    None
}

pub fn waveform_code_from_token(token: &str) -> u8 {
    let normalized = token.trim().to_lowercase();
    if normalized.contains("triangle") || normalized.ends_with("/tri") {
        return 1;
    }
    if normalized.contains("saw") {
        return 2;
    }
    if normalized.contains("square") || normalized.ends_with("/pulse") {
        return 3;
    }
    0
}

fn is_internal_effect_node(node: &DeviceNode) -> bool {
    matches!(node, DeviceNode::Single(slot) if slot.plugin_id.starts_with("internal://effect/"))
}

fn count_internal_effects_before(nodes: &[DeviceNode], end_idx: usize) -> usize {
    nodes
        .iter()
        .take(end_idx)
        .filter(|node| is_internal_effect_node(node))
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use dream_models::project::{PluginSlot, Track};

    #[test]
    fn runtime_index_counts_only_internal_effects() {
        let mut track = Track::new("T");

        let ext = DeviceNode::Single(PluginSlot::new("Serum", "vst3:/serum"));
        let i1 = DeviceNode::Single(PluginSlot::new("EQ", "internal://effect/eq-eight"));
        let i2 = DeviceNode::Single(PluginSlot::new("Comp", "internal://effect/compressor"));

        assert_eq!(DeviceChain::insert_effect(&mut track, ext, None), None);
        assert_eq!(DeviceChain::insert_effect(&mut track, i1, None), Some(0));
        assert_eq!(DeviceChain::insert_effect(&mut track, i2, None), Some(1));
    }

    #[test]
    fn remove_effect_returns_internal_runtime_index() {
        let mut track = Track::new("T");
        let n1 = DeviceNode::Single(PluginSlot::new("EQ", "internal://effect/eq-eight"));
        let n2 = DeviceNode::Single(PluginSlot::new("Serum", "vst3:/serum"));
        let n3 = DeviceNode::Single(PluginSlot::new("Comp", "internal://effect/compressor"));

        let id1 = n1.id();
        let id2 = n2.id();
        let id3 = n3.id();

        track.effects = vec![n1, n2, n3];

        let (_, r1) = DeviceChain::remove_effect(&mut track, id1).expect("remove 1");
        assert_eq!(r1, Some(0));

        let (_, r2) = DeviceChain::remove_effect(&mut track, id2).expect("remove 2");
        assert_eq!(r2, None);

        let (_, r3) = DeviceChain::remove_effect(&mut track, id3).expect("remove 3");
        assert_eq!(r3, Some(0));
    }
}
