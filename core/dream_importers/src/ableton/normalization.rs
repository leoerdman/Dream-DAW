// ═══════════════════════════════════════════════════════════════════════
// Plugin ID Normalization — Canonical mapping of Ableton device names
// ═══════════════════════════════════════════════════════════════════════

use dream_models::midi::SamplerConfig;
use dream_models::project::{DeviceNode, Project};

/// Maps raw Ableton device XML tag names and VST display names to
/// canonical internal Dream DAW plugin IDs.
///
/// Returns `(canonical_id, display_name, slot_kind)` where `slot_kind`
/// is either `"effect"` or `"instrument"`.
pub fn canonical_internal_plugin_for_import(
    plugin_id: &str,
    plugin_name: &str,
) -> Option<(&'static str, &'static str, &'static str)> {
    let pid = plugin_id.trim().to_lowercase();
    let pname = plugin_name.trim().to_lowercase();

    let is_vst = pid == "plugindevice" || pid == "auplugindevice";
    if !is_vst {
        match pid.as_str() {
            // ── EQ ────────────────────────────────────────────────────
            "eq8" | "eqeight" => {
                return Some(("internal://effect/eq-eight", "EQ Eight", "effect"));
            }
            "channeleq" => {
                return Some(("internal://effect/channel-eq", "Channel EQ", "effect"));
            }
            "eqthree" => {
                return Some(("internal://effect/eq-three", "EQ Three", "effect"));
            }

            // ── Dynamics ──────────────────────────────────────────────
            "compressor2" | "compressor" => {
                return Some(("internal://effect/compressor", "Compressor", "effect"));
            }
            "gluecompressor" => {
                return Some(("internal://effect/glue-compressor", "Glue Compressor", "effect"));
            }
            "drumbuss" => {
                return Some(("internal://effect/drum-buss", "Drum Buss", "effect"));
            }
            "multibanddynamics" => {
                return Some(("internal://effect/multiband-dynamics", "Multiband Dynamics", "effect"));
            }
            "transientshaper" => {
                return Some(("internal://effect/transient-shaper", "Transient Shaper", "effect"));
            }

            // ── Delay / Time ──────────────────────────────────────────
            "delay" | "echo" | "pingpongdelay" => {
                return Some(("internal://effect/delay", "Delay", "effect"));
            }
            "filterdelay" => {
                return Some(("internal://effect/filter-delay", "Filter Delay", "effect"));
            }
            "beatrepeat" => {
                return Some(("internal://effect/beat-repeat", "Beat Repeat", "effect"));
            }
            "graindelay" => {
                return Some(("internal://effect/grain-delay", "Grain Delay", "effect"));
            }
            "spectraltime" => {
                return Some(("internal://effect/spectral-time", "Spectral Time", "effect"));
            }

            // ── Reverb / Space ────────────────────────────────────────
            "reverb" => {
                return Some(("internal://effect/reverb", "Reverb", "effect"));
            }
            "hybridreverb" => {
                return Some(("internal://effect/hybrid-reverb", "Hybrid Reverb", "effect"));
            }
            "corpus" => {
                return Some(("internal://effect/corpus", "Corpus", "effect"));
            }
            "resonators" | "spectralresonator" => {
                return Some(("internal://effect/resonators", "Resonators", "effect"));
            }

            // ── Modulation ────────────────────────────────────────────
            "chorus" | "chorus2" | "ensemble" => {
                return Some(("internal://effect/chorus", "Chorus", "effect"));
            }
            "vibrato" => {
                return Some(("internal://effect/chorus", "Vibrato", "effect"));
            }

            // ── Utility / Tools ───────────────────────────────────────
            "utility" => {
                return Some(("internal://effect/utility", "Utility", "effect"));
            }
            "tuner" => {
                return Some(("internal://effect/tuner", "Tuner", "effect"));
            }
            "looper" => {
                return Some(("internal://effect/looper", "Looper", "effect"));
            }
            "frequencyshifter" | "shifter" | "autoshift" => {
                return Some(("internal://effect/frequency-shifter", "Frequency Shifter", "effect"));
            }
            "stereogain" => {
                return Some(("internal://effect/utility", "Utility", "effect"));
            }

            "autopan" | "autopan2" => {
                return Some(("internal://effect/auto-pan", "Auto Pan", "effect"));
            }

            // ── Saturation / Distortion ───────────────────────────────
            "saturator" => {
                return Some(("internal://effect/saturator", "Saturator", "effect"));
            }
            "dynamictube" => {
                return Some(("internal://effect/dynamic-tube", "Dynamic Tube", "effect"));
            }
            "distortion" => {
                return Some(("internal://effect/distortion", "Distortion", "effect"));
            }
            "overdrive" => {
                return Some(("internal://effect/overdrive", "Overdrive", "effect"));
            }
            "erosion" => {
                return Some(("internal://effect/erosion", "Erosion", "effect"));
            }
            "vinyldistortion" => {
                return Some(("internal://effect/vinyl-distortion", "Vinyl Distortion", "effect"));
            }
            "amp" => {
                return Some(("internal://effect/amp", "Amp", "effect"));
            }
            "cabinet" => {
                return Some(("internal://effect/cabinet", "Cabinet", "effect"));
            }
            "pedal" => {
                return Some(("internal://effect/pedal", "Pedal", "effect"));
            }
            "roar" => {
                return Some(("internal://effect/roar", "Roar", "effect"));
            }

            // ── Analysis ──────────────────────────────────────────────
            "spectrumanalyzer" | "spectrum" => {
                return Some(("internal://effect/spectrum", "Spectrum", "effect"));
            }
            "limiter" => return Some(("internal://effect/limiter", "Limiter", "effect")),
            "gate" => return Some(("internal://effect/gate", "Gate", "effect")),
            "redux" | "redux2" | "bitcrusher" => {
                return Some(("internal://effect/bitcrusher", "Bitcrusher", "effect"));
            }
            "autofilter" | "autofilter2" => {
                return Some(("internal://effect/auto-filter", "Auto Filter", "effect"));
            }
            "vocoder" => {
                return Some(("internal://effect/vocoder", "Vocoder", "effect"));
            }
            "phasernew" | "phaser" => {
                return Some(("internal://effect/phaser", "Phaser", "effect"));
            }
            "phaserflanger" => {
                return Some(("internal://effect/phaser-flanger", "Phaser-Flanger", "effect"));
            }
            "flanger" => return Some(("internal://effect/flanger", "Flanger", "effect")),
            "noisemachine" => {
                return Some(("internal://effect/noise-machine", "Noise Machine", "effect"));
            }

            // ── MIDI Effects ──────────────────────────────────────────
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

            // ── Instruments ───────────────────────────────────────────
            "originalsimpler" | "multisampler" | "drumcell" | "instrumentimpulse" => {
                return Some(("internal://instrument/sampler", "Sampler", "instrument"));
            }
            "wavetable" | "operator" | "analog" | "collision" | "tension" | "electricpiano"
            | "instrumentmeld" | "drift" | "instrumentvector" | "loungelizard" | "ultraanalog"
            | "stringstudio" => {
                return Some((
                    "internal://instrument/wave-synth",
                    "Wave Synth",
                    "instrument",
                ));
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
                return Some((
                    "internal://instrument/wave-synth",
                    "Wave Synth",
                    "instrument",
                ));
            }
            _ => return None,
        }
    }

    None
}

/// Runs normalization pass over all tracks in a project, canonicalizing
/// internal plugin IDs from Ableton XML tag names to Dream DAW format.
pub fn normalize_internal_plugins_for_import(project: &mut Project) {
    for track in &mut project.tracks {
        if let Some(inst) = &mut track.instrument {
            let pid = inst.plugin_id();
            if pid.is_empty() || pid.starts_with("internal://") {
                let pname = inst.name().to_string();
                if let Some((canonical_id, canonical_name, slot)) =
                    canonical_internal_plugin_for_import(&pid, &pname)
                    && slot == "instrument"
                {
                    inst.set_plugin_id(canonical_id);
                    if pname.trim().is_empty()
                        || pname.to_lowercase() != canonical_name.to_lowercase()
                    {
                        inst.set_name(canonical_name);
                    }
                    if track.sampler.is_none() {
                        track.sampler = Some(SamplerConfig::default());
                    }
                    if canonical_id == "internal://instrument/wave-synth"
                        && let Some(cfg) = &mut track.sampler
                        && cfg.sample_path.trim().is_empty()
                    {
                        cfg.sample_path = "internal://waveform/sine".to_string();
                    }
                }
            }
        }
        for fx in &mut track.effects {
            normalize_effect_node(fx, 0);
        }
    }
}

/// Recursively normalize a single `DeviceNode` and all children inside racks.
fn normalize_effect_node(node: &mut DeviceNode, depth: usize) {
    if depth > 16 {
        log::warn!("[normalize_effect_node] Recursion depth limit reached, skipping nested rack");
        return;
    }
    match node {
        DeviceNode::Single(slot) => {
            if !slot.plugin_id.is_empty() && !slot.plugin_id.starts_with("internal://") {
                return;
            }
            let pid = slot.plugin_id.clone();
            let pname = slot.name.clone();
            if let Some((canonical_id, canonical_name, _slot_kind)) =
                canonical_internal_plugin_for_import(&pid, &pname)
            {
                slot.plugin_id = canonical_id.to_string();
                if pname.trim().is_empty() || pname.to_lowercase() != canonical_name.to_lowercase()
                {
                    slot.name = canonical_name.to_string();
                }
            }
        }
        DeviceNode::Rack(rack) => {
            for chain in &mut rack.chains {
                for device in &mut chain.devices {
                    normalize_effect_node(device, depth + 1);
                }
            }
        }
    }
}
