// ═══════════════════════════════════════════════════════════════════════
// Dream DAW — Ableton ALS Device Parameter Import
// ═══════════════════════════════════════════════════════════════════════
//
// Maps Ableton internal device XML parameters to Dream DAW automation
// lanes and sampler configurations. Handles:
//   • collect_device_manual_params — extracts all Manual params from XML
//   • import_internal_device_static_params — per-device-type routing
//   • collect_external_plugin_static_lanes — VST/VST3 parameter lanes
//
// ═══════════════════════════════════════════════════════════════════════

use std::collections::HashMap;

use dream_models::midi::SamplerConfig;
use dream_models::project::Track;

use super::plugin_mapper::normalize_plugin_key;
use super::xml_helpers::*;

// ── Utility Helpers ────────────────────────────────────────────────────

/// Collects all descendant nodes that have a `Manual` child with a `Value`
/// attribute into a HashMap keyed by tag name.
pub fn collect_device_manual_params(device: roxmltree::Node<'_, '_>) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    for node in device.descendants().filter(|n| n.is_element()) {
        let key = node.tag_name().name().to_string();
        let val = node
            .children()
            .find(|c| c.is_element() && c.has_tag_name("Manual"))
            .and_then(|m| m.attribute("Value"))
            .and_then(parse_f64_value);
        if let Some(v) = val {
            out.entry(key).or_insert(v);
        }
    }
    out
}

/// Returns the first matching value from a set of alternative keys.
pub fn first_param_value(params: &HashMap<String, f64>, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|k| params.get(*k).copied())
}

/// Normalizes a value that may be either 0–1 or 0–100 to 0–1.
pub fn normalize_percent_or_unit(value: f64) -> f64 {
    if value > 1.0 {
        (value / 100.0).clamp(0.0, 1.0)
    } else {
        value.clamp(0.0, 1.0)
    }
}

// ── Automation Lane Upsert ─────────────────────────────────────────────

/// Inserts or replaces an automation lane with a single static value.
pub fn upsert_static_import_lane(track: &mut Track, param_id: &str, value: f64) {
    if let Some(existing) = track
        .automation_lanes
        .iter_mut()
        .find(|lane| lane.param_id.eq_ignore_ascii_case(param_id))
    {
        existing.points = vec![dream_models::project::AutomationPoint {
            beat: 0.0,
            value,
            curve_type: "linear".to_string(),
            tension: None,
            bezier_cp1x: None,
            bezier_cp1y: None,
            bezier_cp2x: None,
            bezier_cp2y: None,
        }];
        existing.param_id = param_id.to_string();
        return;
    }
    track
        .automation_lanes
        .push(dream_models::project::AutomationLane {
            param_id: param_id.to_string(),
            points: vec![dream_models::project::AutomationPoint {
                beat: 0.0,
                value,
                curve_type: "linear".to_string(),
                tension: None,
                bezier_cp1x: None,
                bezier_cp1y: None,
                bezier_cp2x: None,
                bezier_cp2y: None,
            }],
        });
}

/// Like `upsert_static_import_lane`, but only inserts if the param_id
/// does not already have a lane.
pub fn upsert_static_import_lane_if_missing(track: &mut Track, param_id: &str, value: f64) {
    if track
        .automation_lanes
        .iter()
        .any(|lane| lane.param_id.eq_ignore_ascii_case(param_id))
    {
        return;
    }
    upsert_static_import_lane(track, param_id, value);
}

// ── Internal Device Static Parameters ──────────────────────────────────

/// Imports static (snapshot) parameters from an Ableton internal device XML
/// node into Dream DAW automation lanes and sampler config.
///
/// Each internal plugin ID has a dedicated branch that maps Ableton's
/// parameter names to Dream DAW lane IDs with appropriate normalization.
pub fn import_internal_device_static_params(
    track: &mut Track,
    plugin_id: &str,
    device: roxmltree::Node<'_, '_>,
) {
    let params = collect_device_manual_params(device);
    let key = plugin_id.to_ascii_lowercase();

    // Common on/off switch where available.
    if let Some(on) = first_param_value(&params, &["On"]) {
        upsert_static_import_lane(track, "device.on", if on >= 0.5 { 1.0 } else { 0.0 });
    }

    if key == "internal://effect/utility" {
        import_utility_params(track, &params);
        return;
    }
    if key == "internal://effect/auto-filter" {
        import_auto_filter_params(track, &params);
        return;
    }
    if key == "internal://effect/compressor" {
        import_compressor_params(track, &params);
        return;
    }
    if key == "internal://effect/reverb" {
        import_reverb_params(track, &params);
        return;
    }
    if key == "internal://effect/delay" {
        import_delay_params(track, &params);
        return;
    }
    if key == "internal://effect/eq-eight" {
        import_eq_eight_params(track, &params, device);
        return;
    }
    if key == "internal://instrument/wave-synth" {
        import_wave_synth_params(track, &params);
        return;
    }
    if key == "internal://instrument/sampler" {
        import_sampler_params(track, &params);
        return;
    }
    if key == "internal://effect/chorus" {
        import_chorus_params(track, &params);
        return;
    }
    if key == "internal://effect/flanger" {
        import_flanger_params(track, &params);
        return;
    }
    if key == "internal://effect/phaser" {
        import_phaser_params(track, &params);
        return;
    }
    if key == "internal://effect/distortion" {
        import_distortion_params(track, &params);
        return;
    }
    if key == "internal://effect/saturator" {
        import_saturator_params(track, &params);
        return;
    }
    if key == "internal://effect/gate" {
        import_gate_params(track, &params);
        return;
    }
    if key == "internal://effect/limiter" {
        import_limiter_params(track, &params);
        return;
    }
    if key == "internal://effect/bitcrusher" {
        import_bitcrusher_params(track, &params);
        return;
    }
    if key == "internal://effect/auto-pan" {
        import_auto_pan_params(track, &params);
        return;
    }
    if key == "internal://effect/noise-machine" {
        import_noise_machine_params(track, &params);
    }
    // Spectrum is analysis-only — no runtime parameters needed.
}

// ── Per-Device Parameter Importers ─────────────────────────────────────

fn import_utility_params(track: &mut Track, params: &HashMap<String, f64>) {
    if let Some(gain) = first_param_value(params, &["Volume", "Gain", "Output", "GlobalGain"]) {
        upsert_static_import_lane(track, "plugin.gain", gain.clamp(0.0, 2.0));
    }
    if let Some(pan) = first_param_value(params, &["Pan", "Panorama"]) {
        upsert_static_import_lane(track, "plugin.pan", pan.clamp(-1.0, 1.0));
    }
    if let Some(width) = first_param_value(params, &["Width", "StereoWidth"]) {
        let normalized = if width <= 2.0 { width * 100.0 } else { width };
        upsert_static_import_lane(track, "plugin.width", normalized.clamp(0.0, 200.0));
    }
    if let Some(mono) = first_param_value(params, &["Mono", "BassMono"]) {
        upsert_static_import_lane(track, "plugin.mono", if mono >= 0.5 { 1.0 } else { 0.0 });
    }
}

fn import_auto_filter_params(track: &mut Track, params: &HashMap<String, f64>) {
    if let Some(v) = first_param_value(params, &["Cutoff", "Filter_Frequency"]) {
        upsert_static_import_lane(track, "effect.auto_filter.cutoff", v.clamp(20.0, 20_000.0));
    }
    if let Some(v) = first_param_value(params, &["Resonance", "Filter_Resonance"]) {
        upsert_static_import_lane(track, "effect.auto_filter.resonance", v.clamp(0.0, 1.0));
    }
    if let Some(v) = first_param_value(params, &["Drive", "Filter_Drive"]) {
        upsert_static_import_lane(track, "effect.auto_filter.drive", v.clamp(0.0, 24.0));
    }
    if let Some(v) = first_param_value(params, &["FilterType", "Filter_Type"]) {
        upsert_static_import_lane(track, "effect.auto_filter.type", v.round().clamp(0.0, 8.0));
    }
    if let Some(v) = first_param_value(params, &["Lfo_Frequency", "LfoRate"]) {
        upsert_static_import_lane(track, "effect.auto_filter.lfo.rate", v.clamp(0.01, 20.0));
    }
    if let Some(v) = first_param_value(params, &["Lfo_Amount", "LfoAmount"]) {
        upsert_static_import_lane(
            track,
            "effect.auto_filter.lfo.depth",
            normalize_percent_or_unit(v),
        );
    }
    if let Some(v) = first_param_value(params, &["Envelope_Amount", "EnvAmount"]) {
        let env = if v.abs() > 1.0 {
            (v / 100.0).clamp(-1.0, 1.0)
        } else {
            v.clamp(-1.0, 1.0)
        };
        upsert_static_import_lane(track, "effect.auto_filter.env.amount", env);
    }
    if let Some(v) = first_param_value(params, &["Lfo_Waveform", "LfoShape"]) {
        upsert_static_import_lane(
            track,
            "effect.auto_filter.lfo.shape",
            v.round().clamp(0.0, 5.0),
        );
    }
    if let Some(v) = first_param_value(params, &["Envelope_Attack", "EnvSpeed"]) {
        let ms = if v <= 1.0 { v * 1000.0 } else { v };
        upsert_static_import_lane(
            track,
            "effect.auto_filter.env.speed_ms",
            ms.clamp(1.0, 200.0),
        );
    }
    if let Some(v) = first_param_value(params, &["DryWet", "Mix"]) {
        upsert_static_import_lane(
            track,
            "effect.auto_filter.mix",
            normalize_percent_or_unit(v),
        );
    }
}

fn import_compressor_params(track: &mut Track, params: &HashMap<String, f64>) {
    if let Some(v) = first_param_value(params, &["Threshold"]) {
        upsert_static_import_lane(track, "effect.compressor.threshold", v.clamp(-80.0, 0.0));
    }
    if let Some(v) = first_param_value(params, &["Ratio", "ExpansionRatio"]) {
        upsert_static_import_lane(track, "effect.compressor.ratio", v.clamp(1.0, 20.0));
    }
    if let Some(v) = first_param_value(params, &["Attack"]) {
        upsert_static_import_lane(track, "effect.compressor.attack", v.clamp(0.01, 200.0));
    }
    if let Some(v) = first_param_value(params, &["Release"]) {
        upsert_static_import_lane(track, "effect.compressor.release", v.clamp(1.0, 1000.0));
    }
    if let Some(v) = first_param_value(params, &["Knee"]) {
        upsert_static_import_lane(track, "effect.compressor.knee", v.clamp(0.0, 24.0));
    }
    if let Some(v) = first_param_value(params, &["Gain", "GainCompensation"]) {
        upsert_static_import_lane(track, "effect.compressor.makeup", v.clamp(-24.0, 24.0));
    }
    if let Some(v) = first_param_value(params, &["DryWet"]) {
        upsert_static_import_lane(track, "effect.compressor.mix", normalize_percent_or_unit(v));
    }
}

fn import_reverb_params(track: &mut Track, params: &HashMap<String, f64>) {
    if let Some(v) = first_param_value(params, &["PreDelay", "PreDelay_Time"]) {
        upsert_static_import_lane(track, "effect.reverb.predelay", v.clamp(0.0, 500.0));
    }
    if let Some(v) = first_param_value(params, &["DecayTime", "Algorithm_Decay"]) {
        upsert_static_import_lane(track, "effect.reverb.decay", v.clamp(0.1, 60.0));
    }
    if let Some(v) = first_param_value(params, &["RoomSize", "Algorithm_Size"]) {
        upsert_static_import_lane(track, "effect.reverb.size", normalize_percent_or_unit(v));
    }
    if let Some(v) = first_param_value(params, &["DryWet", "MixDiffuse"]) {
        upsert_static_import_lane(track, "effect.reverb.mix", normalize_percent_or_unit(v));
    }
}

fn import_delay_params(track: &mut Track, params: &HashMap<String, f64>) {
    if let Some(v) = first_param_value(params, &["Time", "DelayTime", "Feedback_FeedbackTime"]) {
        upsert_static_import_lane(track, "effect.delay.time", v.max(0.0));
    }
    if let Some(v) = first_param_value(params, &["Feedback", "Feedback_FeedbackAmount"]) {
        upsert_static_import_lane(track, "effect.delay.feedback", normalize_percent_or_unit(v));
    }
    if let Some(v) = first_param_value(params, &["DryWet", "Send"]) {
        upsert_static_import_lane(track, "effect.delay.mix", normalize_percent_or_unit(v));
    }
}

fn import_eq_eight_params(
    track: &mut Track,
    params: &HashMap<String, f64>,
    device: roxmltree::Node<'_, '_>,
) {
    if let Some(v) = first_param_value(params, &["GlobalGain"]) {
        upsert_static_import_lane(track, "effect.eq.global_gain", v.clamp(-24.0, 24.0));
    }
    if let Some(v) = first_param_value(params, &["Scale"]) {
        upsert_static_import_lane(track, "effect.eq.scale", normalize_percent_or_unit(v));
    }
    if let Some(v) = first_param_value(params, &["AdaptiveQ"]) {
        upsert_static_import_lane(
            track,
            "effect.eq.adaptive_q",
            if v >= 0.5 { 1.0 } else { 0.0 },
        );
    }
    for band in 0..8 {
        let band_tag = format!("Bands.{band}");
        if let Some(band_node) = device
            .descendants()
            .find(|n| n.is_element() && n.tag_name().name() == band_tag)
        {
            let param_node = band_node
                .children()
                .find(|n| n.is_element() && n.tag_name().name() == "ParameterA")
                .or_else(|| band_node.children().find(|n| n.is_element()));
            if let Some(pn) = param_node {
                if let Some(v) = maybe_parse_f64_manual(pn, "Freq") {
                    upsert_static_import_lane(
                        track,
                        &format!("effect.eq.band{band}.freq"),
                        v.clamp(20.0, 20_000.0),
                    );
                }
                if let Some(v) = maybe_parse_f64_manual(pn, "Gain") {
                    upsert_static_import_lane(
                        track,
                        &format!("effect.eq.band{band}.gain"),
                        v.clamp(-24.0, 24.0),
                    );
                }
                if let Some(v) = maybe_parse_f64_manual(pn, "Q") {
                    upsert_static_import_lane(
                        track,
                        &format!("effect.eq.band{band}.q"),
                        v.clamp(0.1, 18.0),
                    );
                }
                if let Some(v) = maybe_parse_f64_manual(pn, "IsOn") {
                    upsert_static_import_lane(
                        track,
                        &format!("effect.eq.band{band}.on"),
                        if v >= 0.5 { 1.0 } else { 0.0 },
                    );
                }
                if let Some(v) = maybe_parse_f64_manual(pn, "Mode") {
                    upsert_static_import_lane(
                        track,
                        &format!("effect.eq.band{band}.mode"),
                        v.round().clamp(0.0, 7.0),
                    );
                }
            }
        }
    }
}

fn import_wave_synth_params(track: &mut Track, params: &HashMap<String, f64>) {
    if let Some(v) = first_param_value(params, &["Voice_Oscillator1_Pitch_Detune", "Detune"]) {
        upsert_static_import_lane(track, "synth.detune", v.clamp(-50.0, 50.0));
        if let Some(cfg) = &mut track.sampler {
            cfg.detune_cents = v.clamp(-50.0, 50.0);
        }
    }
    if let Some(v) = first_param_value(params, &["Voice_SubOscillator_Gain"]) {
        upsert_static_import_lane(track, "synth.sub", normalize_percent_or_unit(v));
        if let Some(cfg) = &mut track.sampler {
            cfg.sub_level = normalize_percent_or_unit(v);
        }
    }
    if let Some(v) = first_param_value(params, &["Voice_Filter1_Frequency", "Filter_Frequency"]) {
        upsert_static_import_lane(track, "synth.filter.cutoff", v.clamp(20.0, 20_000.0));
        if let Some(cfg) = &mut track.sampler {
            cfg.filter_cutoff = v.clamp(20.0, 20_000.0);
        }
    }
    if let Some(v) = first_param_value(params, &["Voice_Filter1_Resonance", "Filter_Resonance"]) {
        upsert_static_import_lane(track, "synth.filter.resonance", v.clamp(0.0, 0.99));
        if let Some(cfg) = &mut track.sampler {
            cfg.filter_resonance = v.clamp(0.0, 0.99);
        }
    }
    if let Some(v) = first_param_value(params, &["Voice_Filter1_Type", "Filter_Type"]) {
        upsert_static_import_lane(track, "synth.filter.type", v.round().clamp(0.0, 3.0));
        if let Some(cfg) = &mut track.sampler {
            cfg.filter_type = v.round().clamp(0.0, 3.0) as u8;
        }
    }
    if let (Some(osc1), Some(osc2)) = (
        first_param_value(params, &["Voice_Oscillator1_Gain"]),
        first_param_value(params, &["Voice_Oscillator2_Gain"]),
    ) {
        let total = osc1.abs() + osc2.abs();
        if total > 1e-6 {
            let mix = (osc2.abs() / total).clamp(0.0, 1.0);
            upsert_static_import_lane(track, "synth.osc.mix", mix);
            if let Some(cfg) = &mut track.sampler {
                cfg.osc_mix = mix;
            }
        }
    }
    if let Some(v) = first_param_value(
        params,
        &["Voice_Modulators_AmpEnvelope_Times_Attack", "Attack"],
    ) {
        upsert_static_import_lane(track, "sampler.attack", v.clamp(0.001, 10.0));
    }
    if let Some(v) = first_param_value(
        params,
        &["Voice_Modulators_AmpEnvelope_Times_Decay", "Decay"],
    ) {
        upsert_static_import_lane(track, "sampler.decay", v.clamp(0.001, 10.0));
    }
    if let Some(v) = first_param_value(params, &["Voice_Modulators_AmpEnvelope_Sustain", "Sustain"])
    {
        upsert_static_import_lane(track, "sampler.sustain", normalize_percent_or_unit(v));
    }
    if let Some(v) = first_param_value(
        params,
        &["Voice_Modulators_AmpEnvelope_Times_Release", "Release"],
    ) {
        upsert_static_import_lane(track, "sampler.release", v.clamp(0.001, 20.0));
    }
}

fn import_sampler_params(track: &mut Track, params: &HashMap<String, f64>) {
    let mut lane_updates = Vec::<(String, f64)>::new();
    let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);

    if let Some(v) = first_param_value(params, &["Volume", "Vol", "SampleVolume", "Gain"]) {
        cfg.volume = ableton_volume_to_linear_gain(v);
        lane_updates.push(("sampler.volume".to_string(), cfg.volume));
    }
    if let Some(v) = first_param_value(params, &["Attack", "AttackTime", "EnvAttack"]) {
        cfg.attack = v.clamp(0.0, 20.0);
        lane_updates.push(("sampler.attack".to_string(), cfg.attack));
    }
    if let Some(v) = first_param_value(params, &["Decay", "DecayTime", "EnvDecay"]) {
        cfg.decay = v.clamp(0.0, 20.0);
        lane_updates.push(("sampler.decay".to_string(), cfg.decay));
    }
    if let Some(v) = first_param_value(params, &["Sustain", "EnvSustain"]) {
        let sustain = if v > 1.0 {
            (v / 100.0).clamp(0.0, 1.0)
        } else {
            v.clamp(0.0, 1.0)
        };
        cfg.sustain = sustain;
        lane_updates.push(("sampler.sustain".to_string(), cfg.sustain));
    }
    if let Some(v) = first_param_value(params, &["Release", "ReleaseTime", "EnvRelease"]) {
        cfg.release = v.clamp(0.0, 20.0);
        lane_updates.push(("sampler.release".to_string(), cfg.release));
    }
    if let Some(v) = first_param_value(params, &["Root", "RootKey", "Base", "Transpose"]) {
        let root = if v.abs() <= 24.0 && v.fract().abs() < 1e-9 {
            (60.0 + v).round()
        } else {
            v.round()
        };
        cfg.root_note = root.clamp(0.0, 127.0) as u8;
        lane_updates.push(("sampler.root_note".to_string(), cfg.root_note as f64));
    }
    if let Some(v) = first_param_value(params, &["Filter_Frequency", "Cutoff"]) {
        cfg.filter_cutoff = v.clamp(20.0, 20_000.0);
        lane_updates.push(("sampler.filter_cutoff".to_string(), cfg.filter_cutoff));
    }
    if let Some(v) = first_param_value(params, &["Filter_Resonance", "Resonance"]) {
        cfg.filter_resonance = v.clamp(0.0, 0.99);
        lane_updates.push(("sampler.filter_resonance".to_string(), cfg.filter_resonance));
    }
    if let Some(v) = first_param_value(params, &["Filter_Type", "FilterType"]) {
        cfg.filter_type = v.round().clamp(0.0, 3.0) as u8;
        lane_updates.push(("sampler.filter_type".to_string(), cfg.filter_type as f64));
    }
    if let Some(v) = first_param_value(params, &["Detune", "FineTune", "SampleDetune"]) {
        cfg.detune_cents = v.clamp(-50.0, 50.0);
        lane_updates.push(("sampler.detune_cents".to_string(), cfg.detune_cents));
    }
    if let Some(v) = first_param_value(params, &["Osc2Waveform", "Voice_Oscillator2_Waveform"]) {
        cfg.osc2_waveform = v.round().clamp(0.0, 3.0) as u8;
        lane_updates.push((
            "sampler.osc2_waveform".to_string(),
            cfg.osc2_waveform as f64,
        ));
    }
    if let Some(v) = first_param_value(params, &["OscMix", "Voice_Oscillator_Blend"]) {
        cfg.osc_mix = normalize_percent_or_unit(v);
        lane_updates.push(("sampler.osc_mix".to_string(), cfg.osc_mix));
    }
    if let Some(v) = first_param_value(params, &["Sub", "SubLevel", "SubOsc"]) {
        cfg.sub_level = normalize_percent_or_unit(v);
        lane_updates.push(("sampler.sub_level".to_string(), cfg.sub_level));
    }
    if let Some(v) = first_param_value(params, &["LfoRate", "Lfo_Frequency"]) {
        cfg.lfo_rate = v.clamp(0.01, 20.0);
        lane_updates.push(("sampler.lfo_rate".to_string(), cfg.lfo_rate));
    }
    if let Some(v) = first_param_value(params, &["LfoDepth", "Lfo_Amount"]) {
        cfg.lfo_depth = normalize_percent_or_unit(v);
        lane_updates.push(("sampler.lfo_depth".to_string(), cfg.lfo_depth));
    }
    if let Some(v) = first_param_value(params, &["LfoTarget"]) {
        cfg.lfo_target = v.round().clamp(0.0, 2.0) as u8;
        lane_updates.push(("sampler.lfo_target".to_string(), cfg.lfo_target as f64));
    }
    if let Some(v) = first_param_value(params, &["PulseWidth", "OscPulseWidth"]) {
        cfg.pulse_width = v.clamp(0.05, 0.95);
        lane_updates.push(("sampler.pulse_width".to_string(), cfg.pulse_width));
    }

    for (param_id, value) in lane_updates {
        upsert_static_import_lane(track, &param_id, value);
    }
}

fn import_chorus_params(track: &mut Track, params: &HashMap<String, f64>) {
    if let Some(v) = first_param_value(params, &["Rate", "Rate1", "LfoRate"]) {
        upsert_static_import_lane(track, "effect.chorus.rate", v.clamp(0.01, 20.0));
    }
    if let Some(v) = first_param_value(params, &["Depth", "Amount", "DelayModAmount"]) {
        upsert_static_import_lane(track, "effect.chorus.depth", normalize_percent_or_unit(v));
    }
    if let Some(v) = first_param_value(params, &["Delay1", "DelayTime"]) {
        upsert_static_import_lane(track, "effect.chorus.delay", v.clamp(0.0, 20.0));
    }
    if let Some(v) = first_param_value(params, &["Feedback", "FeedbackAmount"]) {
        upsert_static_import_lane(
            track,
            "effect.chorus.feedback",
            normalize_percent_or_unit(v),
        );
    }
    if let Some(v) = first_param_value(params, &["DryWet", "Mix"]) {
        upsert_static_import_lane(track, "effect.chorus.mix", normalize_percent_or_unit(v));
    }
}

fn import_flanger_params(track: &mut Track, params: &HashMap<String, f64>) {
    if let Some(v) = first_param_value(params, &["Frequency", "Rate", "HiPassFreq"]) {
        upsert_static_import_lane(track, "effect.flanger.rate", v.clamp(0.01, 20.0));
    }
    if let Some(v) = first_param_value(params, &["Depth", "Amount"]) {
        upsert_static_import_lane(track, "effect.flanger.depth", normalize_percent_or_unit(v));
    }
    if let Some(v) = first_param_value(params, &["Feedback"]) {
        upsert_static_import_lane(
            track,
            "effect.flanger.feedback",
            normalize_percent_or_unit(v),
        );
    }
    if let Some(v) = first_param_value(params, &["Delay", "DelayTime"]) {
        upsert_static_import_lane(track, "effect.flanger.delay", v.clamp(0.0, 20.0));
    }
    if let Some(v) = first_param_value(params, &["DryWet", "Mix"]) {
        upsert_static_import_lane(track, "effect.flanger.mix", normalize_percent_or_unit(v));
    }
}

fn import_phaser_params(track: &mut Track, params: &HashMap<String, f64>) {
    if let Some(v) = first_param_value(params, &["Frequency", "Rate"]) {
        upsert_static_import_lane(track, "effect.phaser.rate", v.clamp(0.01, 20.0));
    }
    if let Some(v) = first_param_value(params, &["Depth", "Amount"]) {
        upsert_static_import_lane(track, "effect.phaser.depth", normalize_percent_or_unit(v));
    }
    if let Some(v) = first_param_value(params, &["Poles"]) {
        upsert_static_import_lane(track, "effect.phaser.poles", v.round().clamp(1.0, 12.0));
    }
    if let Some(v) = first_param_value(params, &["Feedback"]) {
        upsert_static_import_lane(
            track,
            "effect.phaser.feedback",
            normalize_percent_or_unit(v),
        );
    }
    if let Some(v) = first_param_value(params, &["DryWet", "Mix"]) {
        upsert_static_import_lane(track, "effect.phaser.mix", normalize_percent_or_unit(v));
    }
}

fn import_distortion_params(track: &mut Track, params: &HashMap<String, f64>) {
    if let Some(v) = first_param_value(params, &["Drive", "DriveAmount", "Gain"]) {
        upsert_static_import_lane(track, "effect.distortion.drive", v.clamp(0.0, 48.0));
    }
    if let Some(v) = first_param_value(params, &["Type", "Mode"]) {
        upsert_static_import_lane(track, "effect.distortion.type", v.round().clamp(0.0, 10.0));
    }
    if let Some(v) = first_param_value(params, &["Tone", "Color", "Filter_Frequency"]) {
        upsert_static_import_lane(track, "effect.distortion.tone", v.clamp(20.0, 20_000.0));
    }
    if let Some(v) = first_param_value(params, &["Output", "Volume", "OutputGain"]) {
        upsert_static_import_lane(track, "effect.distortion.output", v.clamp(-24.0, 24.0));
    }
    if let Some(v) = first_param_value(params, &["DryWet", "Mix"]) {
        upsert_static_import_lane(track, "effect.distortion.mix", normalize_percent_or_unit(v));
    }
}

fn import_saturator_params(track: &mut Track, params: &HashMap<String, f64>) {
    if let Some(v) = first_param_value(params, &["Drive", "PreDrive"]) {
        upsert_static_import_lane(track, "effect.saturator.drive", v.clamp(0.0, 36.0));
    }
    if let Some(v) = first_param_value(params, &["Type", "WaveshapeType"]) {
        upsert_static_import_lane(track, "effect.saturator.type", v.round().clamp(0.0, 6.0));
    }
    if let Some(v) = first_param_value(params, &["Output", "PostGain"]) {
        upsert_static_import_lane(track, "effect.saturator.output", v.clamp(-24.0, 24.0));
    }
    if let Some(v) = first_param_value(params, &["DryWet", "Mix"]) {
        upsert_static_import_lane(track, "effect.saturator.mix", normalize_percent_or_unit(v));
    }
}

fn import_gate_params(track: &mut Track, params: &HashMap<String, f64>) {
    if let Some(v) = first_param_value(params, &["Threshold"]) {
        upsert_static_import_lane(track, "effect.gate.threshold", v.clamp(-80.0, 0.0));
    }
    if let Some(v) = first_param_value(params, &["Return", "Range"]) {
        upsert_static_import_lane(track, "effect.gate.range", v.clamp(-80.0, 0.0));
    }
    if let Some(v) = first_param_value(params, &["Attack"]) {
        upsert_static_import_lane(track, "effect.gate.attack", v.clamp(0.01, 100.0));
    }
    if let Some(v) = first_param_value(params, &["Hold", "HoldTime"]) {
        upsert_static_import_lane(track, "effect.gate.hold", v.clamp(0.0, 500.0));
    }
    if let Some(v) = first_param_value(params, &["Release"]) {
        upsert_static_import_lane(track, "effect.gate.release", v.clamp(1.0, 1000.0));
    }
    if let Some(v) = first_param_value(params, &["FlipMode", "Flip"]) {
        upsert_static_import_lane(track, "effect.gate.flip", if v >= 0.5 { 1.0 } else { 0.0 });
    }
}

fn import_limiter_params(track: &mut Track, params: &HashMap<String, f64>) {
    if let Some(v) = first_param_value(params, &["Gain", "InputGain"]) {
        upsert_static_import_lane(track, "effect.limiter.gain", v.clamp(-24.0, 24.0));
    }
    if let Some(v) = first_param_value(params, &["Ceiling"]) {
        upsert_static_import_lane(track, "effect.limiter.ceiling", v.clamp(-24.0, 0.0));
    }
    if let Some(v) = first_param_value(params, &["Release", "ReleaseTime"]) {
        upsert_static_import_lane(track, "effect.limiter.release", v.clamp(0.1, 1000.0));
    }
}

fn import_bitcrusher_params(track: &mut Track, params: &HashMap<String, f64>) {
    if let Some(v) = first_param_value(params, &["BitDepth", "Bits"]) {
        upsert_static_import_lane(track, "effect.bitcrusher.bits", v.clamp(1.0, 24.0));
    }
    if let Some(v) = first_param_value(params, &["SampleRateReduction", "Downsample"]) {
        upsert_static_import_lane(track, "effect.bitcrusher.downsample", v.clamp(1.0, 200.0));
    }
    if let Some(v) = first_param_value(params, &["DryWet", "Mix"]) {
        upsert_static_import_lane(track, "effect.bitcrusher.mix", normalize_percent_or_unit(v));
    }
}

fn import_auto_pan_params(track: &mut Track, params: &HashMap<String, f64>) {
    if let Some(v) = first_param_value(params, &["Frequency", "Rate"]) {
        upsert_static_import_lane(track, "effect.auto_pan.rate", v.clamp(0.01, 30.0));
    }
    if let Some(v) = first_param_value(params, &["Amount", "Depth"]) {
        upsert_static_import_lane(track, "effect.auto_pan.depth", normalize_percent_or_unit(v));
    }
    if let Some(v) = first_param_value(params, &["Shape"]) {
        upsert_static_import_lane(track, "effect.auto_pan.shape", v.round().clamp(0.0, 5.0));
    }
    if let Some(v) = first_param_value(params, &["Phase"]) {
        upsert_static_import_lane(track, "effect.auto_pan.phase", v.clamp(0.0, 360.0));
    }
    if let Some(v) = first_param_value(params, &["Offset"]) {
        upsert_static_import_lane(track, "effect.auto_pan.offset", v.clamp(-1.0, 1.0));
    }
}

fn import_noise_machine_params(track: &mut Track, params: &HashMap<String, f64>) {
    if let Some(v) = first_param_value(params, &["Volume", "Level", "Gain"]) {
        upsert_static_import_lane(track, "effect.noise_machine.level", v.clamp(0.0, 1.0));
    }
    if let Some(v) = first_param_value(params, &["Color", "Type"]) {
        upsert_static_import_lane(
            track,
            "effect.noise_machine.color",
            v.round().clamp(0.0, 4.0),
        );
    }
}

// ── External Plugin Static Lanes ───────────────────────────────────────

/// Collects static parameter values from a `PluginDevice` node and formats
/// them as lane key/value pairs for automation storage.
pub fn collect_external_plugin_static_lanes(
    device: roxmltree::Node<'_, '_>,
    dev_idx: usize,
    plugin_key: &str,
) -> Vec<(String, f64)> {
    let mut out = Vec::<(String, f64)>::new();

    for (param_idx, param_node) in device
        .descendants()
        .filter(|n| {
            if !n.is_element() {
                return false;
            }
            let tag = n.tag_name().name();
            tag == "PluginFloatParameter"
                || tag == "PluginIntParameter"
                || tag == "PluginBoolParameter"
        })
        .enumerate()
    {
        let manual = param_node
            .children()
            .find(|n| n.is_element() && n.has_tag_name("ParameterValue"))
            .and_then(|pv| {
                pv.children()
                    .find(|n| n.is_element() && n.has_tag_name("Manual"))
                    .and_then(|m| m.attribute("Value"))
                    .and_then(parse_f64_value)
            });
        let Some(value) = manual else { continue };

        let raw_name = param_node
            .children()
            .find(|n| n.is_element() && n.has_tag_name("ParameterName"))
            .and_then(|n| n.attribute("Value"))
            .unwrap_or_default()
            .trim()
            .to_string();
        let raw_id = param_node
            .children()
            .find(|n| n.is_element() && n.has_tag_name("ParameterId"))
            .and_then(|n| n.attribute("Value"))
            .unwrap_or_default()
            .trim()
            .to_string();

        let mut param_key = normalize_plugin_key(&raw_name);
        if param_key.is_empty() {
            param_key = normalize_plugin_key(&raw_id);
        }
        if param_key.is_empty() {
            param_key = format!("param{param_idx}");
        } else if let Ok(v) = raw_id.parse::<i64>()
            && v >= 0
        {
            param_key = format!("{param_key}_id{v}");
        }

        out.push((format!("plugin:{dev_idx}:{plugin_key}:{param_key}"), value));
    }

    out
}
