use uuid::Uuid;

use super::{AutomationCurveMode, AutomationPoint, ExternalPluginRuntimeSlot, TrackAutomationState};

#[derive(Debug, Clone, Copy)]
pub struct ExternalParamTarget {
    pub slot_id: Option<Uuid>,
    pub slot_index: Option<usize>,
    pub param_index: u32,
}

pub fn parse_external_param_target(param_key: &str) -> Option<ExternalParamTarget> {
    let key = param_key.trim();
    if key.is_empty() {
        return None;
    }

    if let Some(rest) = key
        .strip_prefix("ext:")
        .or_else(|| key.strip_prefix("Ext:"))
        .or_else(|| key.strip_prefix("EXT:"))
    {
        let (slot_id_str, param_index_str) = rest.split_once(':')?;
        let slot_id = Uuid::parse_str(slot_id_str).ok()?;
        let idx = param_index_str.parse::<u32>().ok()?;
        return Some(ExternalParamTarget {
            slot_id: Some(slot_id),
            slot_index: None,
            param_index: idx,
        });
    }

    if let Some(rest) = key
        .strip_prefix("slot:")
        .or_else(|| key.strip_prefix("Slot:"))
        .or_else(|| key.strip_prefix("SLOT:"))
    {
        let (slot_id_str, param_token) = rest.split_once(':')?;
        let slot_id = Uuid::parse_str(slot_id_str).ok()?;

        let idx = if let Some(v) = param_token.strip_prefix("ext_param_") {
            v.parse::<u32>().ok()
        } else if let Some(v) = param_token.strip_prefix("param_id") {
            v.parse::<u32>().ok()
        } else if let Some(v) = param_token.strip_prefix("param") {
            v.parse::<u32>().ok()
        } else {
            None
        }?;

        return Some(ExternalParamTarget {
            slot_id: Some(slot_id),
            slot_index: None,
            param_index: idx,
        });
    }

    if let Some(rest) = key
        .strip_prefix("plugin:")
        .or_else(|| key.strip_prefix("Plugin:"))
        .or_else(|| key.strip_prefix("PLUGIN:"))
    {
        let mut parts = rest.split(':');
        let slot_index = parts.next()?.parse::<usize>().ok()?;
        let _plugin_key = parts.next()?;
        let plugin_key_end = rest
            .find(':')
            .and_then(|first_colon| {
                rest[first_colon + 1..]
                    .find(':')
                    .map(|second_colon| first_colon + 1 + second_colon + 1)
            })
            .unwrap_or(rest.len());
        let param_token = &rest[plugin_key_end.min(rest.len())..];
        if param_token.is_empty() {
            return None;
        }
        if let Some(id_pos) = param_token.rfind("_id") {
            let idx = param_token[(id_pos + 3)..].parse::<u32>().ok()?;
            return Some(ExternalParamTarget {
                slot_id: None,
                slot_index: Some(slot_index),
                param_index: idx,
            });
        }
    }

    None
}

#[inline]
fn equal_power_pan_gains(pan: f32) -> (f32, f32) {
    let pan = pan.clamp(-1.0, 1.0);
    let t = (pan + 1.0) * 0.5;
    let angle = t * std::f32::consts::FRAC_PI_2;
    (angle.cos(), angle.sin())
}

// ── ENTERPRISE: Cubic bezier S-curve interpolation ──────────────────────
// Attempt to match the frontend bezier curve rendering. Uses a symmetric
// cubic hermite spline controlled by the `tension` parameter:
//   tension = 0.0 → identical to linear
//   tension = 0.5 → mild S-curve (default)
//   tension = 1.0 → sharp S-curve
// Zero-allocation, branchless-friendly for the audio thread.
#[inline]
fn eval_bezier_t(t: f32, tension: f32) -> f32 {
    // Symmetric cubic hermite: y = 3t² - 2t³, scaled by tension
    let smooth = t * t * (3.0 - 2.0 * t); // Hermite smoothstep
    // Blend between linear (t) and smoothstep, controlled by tension
    t + (smooth - t) * tension.clamp(0.0, 1.0)
}

#[inline]
fn eval_automation_with_cursor(
    points: &[AutomationPoint],
    at_frame: i64,
    cursor: &mut usize,
) -> Option<f32> {
    if points.is_empty() {
        return None;
    }
    if points.len() == 1 {
        return Some(points[0].value);
    }
    if at_frame <= points[0].sample_frame {
        *cursor = 0;
        return Some(points[0].value);
    }

    if *cursor > 0 && at_frame < points[*cursor].sample_frame {
        *cursor = match points.binary_search_by_key(&at_frame, |p| p.sample_frame) {
            Ok(exact) => exact,
            Err(insert_pos) => insert_pos.saturating_sub(1),
        };
    }

    let last_pair = points.len().saturating_sub(2);
    while *cursor < last_pair && at_frame > points[*cursor + 1].sample_frame {
        *cursor += 1;
    }

    let a = &points[*cursor];
    let b = &points[(*cursor + 1).min(points.len() - 1)];
    if at_frame <= b.sample_frame {
        // ── Curve mode dispatch ─────────────────────────────────────────
        match a.curve_mode {
            AutomationCurveMode::Step => {
                // Hold 'a' value until 'b' is reached
                return Some(a.value);
            }
            AutomationCurveMode::Bezier => {
                let span = (b.sample_frame - a.sample_frame).max(1) as f32;
                let t = ((at_frame - a.sample_frame) as f32 / span).clamp(0.0, 1.0);
                let curved_t = eval_bezier_t(t, a.tension.clamp(0.0, 1.0));
                return Some(a.value + (b.value - a.value) * curved_t);
            }
            AutomationCurveMode::Linear => {
                let span = (b.sample_frame - a.sample_frame).max(1) as f32;
                let t = ((at_frame - a.sample_frame) as f32 / span).clamp(0.0, 1.0);
                return Some(a.value + (b.value - a.value) * t);
            }
        }
    }

    points.last().map(|p| p.value)
}

#[inline]
fn pan_points_use_unit_interval_domain(points: &[AutomationPoint]) -> bool {
    if points.is_empty() {
        return false;
    }
    if points.len() <= 2 && points.iter().all(|p| p.value.abs() < 0.001) {
        return false;
    }

    let mut min_v = f32::INFINITY;
    let mut max_v = f32::NEG_INFINITY;
    let mut saw_center_hint = false;
    for p in points {
        let v = p.value;
        min_v = min_v.min(v);
        max_v = max_v.max(v);
        if (v - 0.5).abs() <= 0.02 {
            saw_center_hint = true;
        }
    }

    if min_v < 0.0 || max_v > 1.0 {
        return false;
    }

    saw_center_hint || (min_v <= 0.01 && max_v >= 0.99)
}

#[cfg(test)]
#[inline]
pub(crate) fn apply_gain_pan_automation_sample_accurate(
    left: &mut [f32],
    right: &mut [f32],
    buffer_start_frame: i64,
    gain_points: Option<&[AutomationPoint]>,
    pan_points: Option<&[AutomationPoint]>,
) {
    let n = left.len().min(right.len());
    if n == 0 || (gain_points.is_none() && pan_points.is_none()) {
        return;
    }

    if gain_points.is_none_or(|p| p.len() <= 1) && pan_points.is_none_or(|p| p.len() <= 1) {
        let gain = gain_points
            .and_then(|p| p.first())
            .map(|p| p.value)
            .unwrap_or(1.0)
            .clamp(0.0, 2.0);
        let raw_pan = pan_points
            .and_then(|p| p.first())
            .map(|p| p.value)
            .unwrap_or(0.0);
        let pan = if pan_points
            .map(pan_points_use_unit_interval_domain)
            .unwrap_or(false)
        {
            raw_pan * 2.0 - 1.0
        } else {
            raw_pan
        }
        .clamp(-1.0, 1.0);
        let (left_mul, right_mul) = equal_power_pan_gains(pan);
        for i in 0..n {
            left[i] *= gain * left_mul;
            right[i] *= gain * right_mul;
        }
        return;
    }

    let pan_is_unit_interval = pan_points
        .map(pan_points_use_unit_interval_domain)
        .unwrap_or(false);
    let mut gain_cursor = 0usize;
    let mut pan_cursor = 0usize;

    for i in 0..n {
        let frame = buffer_start_frame + i as i64;
        let gain = gain_points
            .and_then(|pts| eval_automation_with_cursor(pts, frame, &mut gain_cursor))
            .unwrap_or(1.0)
            .clamp(0.0, 2.0);
        let raw_pan = pan_points
            .and_then(|pts| eval_automation_with_cursor(pts, frame, &mut pan_cursor))
            .unwrap_or(0.0);
        let pan = if pan_is_unit_interval {
            raw_pan * 2.0 - 1.0
        } else {
            raw_pan
        }
        .clamp(-1.0, 1.0);
        let (left_mul, right_mul) = equal_power_pan_gains(pan);
        left[i] *= gain * left_mul;
        right[i] *= gain * right_mul;
    }
}

#[inline]
pub(crate) fn apply_track_mixer_automation_sample_accurate(
    left: &mut [f32],
    right: &mut [f32],
    buffer_start_frame: i64,
    volume_points: Option<&[AutomationPoint]>,
    pan_points: Option<&[AutomationPoint]>,
) {
    let n = left.len().min(right.len());
    if n == 0 || (volume_points.is_none() && pan_points.is_none()) {
        return;
    }

    if volume_points.is_none_or(|p| p.len() <= 1) && pan_points.is_none_or(|p| p.len() <= 1) {
        let vol = volume_points
            .and_then(|p| p.first())
            .map(|p| p.value)
            .unwrap_or(1.0)
            .clamp(0.0, 2.0);
        let raw_pan = pan_points
            .and_then(|p| p.first())
            .map(|p| p.value)
            .unwrap_or(0.0);
        let pan = if pan_points
            .map(pan_points_use_unit_interval_domain)
            .unwrap_or(false)
        {
            raw_pan * 2.0 - 1.0
        } else {
            raw_pan
        }
        .clamp(-1.0, 1.0);
        let (left_mul, right_mul) = equal_power_pan_gains(pan);
        for i in 0..n {
            left[i] *= vol * left_mul;
            right[i] *= vol * right_mul;
        }
        return;
    }

    let pan_is_unit_interval = pan_points
        .map(pan_points_use_unit_interval_domain)
        .unwrap_or(false);
    let mut volume_cursor = 0usize;
    let mut pan_cursor = 0usize;

    for i in 0..n {
        let frame = buffer_start_frame + i as i64;
        let vol = volume_points
            .and_then(|pts| eval_automation_with_cursor(pts, frame, &mut volume_cursor))
            .unwrap_or(1.0)
            .clamp(0.0, 2.0);
        let raw_pan = pan_points
            .and_then(|pts| eval_automation_with_cursor(pts, frame, &mut pan_cursor))
            .unwrap_or(0.0);
        let pan = if pan_is_unit_interval {
            raw_pan * 2.0 - 1.0
        } else {
            raw_pan
        }
        .clamp(-1.0, 1.0);
        let (left_mul, right_mul) = equal_power_pan_gains(pan);
        left[i] *= vol * left_mul;
        right[i] *= vol * right_mul;
    }
}

pub(crate) fn apply_midi_fx_automation_block(
    config: &mut crate::driver::MidiFxRuntimeConfig,
    lane: Option<&TrackAutomationState>,
    playhead_pos: i64,
) {
    let Some(lane) = lane else {
        return;
    };
    if lane.plugin_params.is_empty() {
        return;
    }

    fn norm(raw: &str) -> String {
        let lowered = raw.to_ascii_lowercase();
        let unscoped = if let Some(rest) = lowered.strip_prefix("slot:") {
            if let Some(at) = rest.find(':') { &rest[at+1..] } else { lowered.as_str() }
        } else { lowered.as_str() };
        unscoped.chars().filter(|c| c.is_ascii_alphanumeric()).collect()
    }

    let get_val = |keys: &[&str]| -> Option<f32> {
        let normalized: Vec<String> = keys.iter().map(|&k| norm(k)).collect();
        for (lane_key_raw, points) in &lane.plugin_params {
            let lane_key = norm(lane_key_raw);
            if normalized.iter().any(|key| lane_key == *key || lane_key.ends_with(key.as_str())) {
                let mut cursor = 0usize;
                return eval_automation_with_cursor(points, playhead_pos, &mut cursor);
            }
        }
        None
    };

    if let Some(v) = get_val(&["midi.pitch.semitones", "midifx.pitch.semitones", "midiPitch.semitones"]) {
        config.pitch_semitones = v.round().clamp(-48.0, 48.0) as i8;
    }
    if let Some(v) = get_val(&["midi.scale.root", "midifx.scale.root", "midiScale.root"]) {
        config.scale_root = v.round().rem_euclid(12.0) as u8;
    }
    if let Some(v) = get_val(&["midi.scale.mask", "midifx.scale.mask", "midiScale.mask"]) {
        config.scale_mask = v.round().clamp(1.0, 4095.0) as u16;
    }
    if let Some(v) = get_val(&["midi.velocity.gain", "midifx.velocity.gain", "midiVelocity.gain"]) {
        config.velocity_gain = v.clamp(0.0, 4.0);
    }
    if let Some(v) = get_val(&["midi.velocity.offset", "midifx.velocity.offset", "midiVelocity.offset"]) {
        config.velocity_offset = v.round().clamp(-127.0, 127.0) as i8;
    }
    if let Some(v) = get_val(&["midi.random.semitones", "midifx.random.semitones", "midiRandom.semitones"]) {
        config.random_semitones = v.round().clamp(-24.0, 24.0) as i8;
    }
    if let Some(v) = get_val(&["midi.random.chance", "midifx.random.chance", "midiRandom.chance"]) {
        config.random_chance = v.clamp(0.0, 1.0);
    }
}

pub(crate) fn apply_native_device_automation_sample_accurate_block(
    device_chain: &mut dream_dsp::device_chain::DeviceChain,
    lane: Option<&TrackAutomationState>,
    playhead_pos: i64,
) {
    let Some(lane) = lane else {
        return;
    };
    if lane.plugin_params.is_empty() {
        return;
    }

    for (key, points) in &lane.plugin_params {
        if let Some(target) = parse_external_param_target(key)
            && let Some(slot_index) = target.slot_index
        {
            let mut cursor = 0usize;
            if let Some(value) = eval_automation_with_cursor(points, playhead_pos, &mut cursor) {
                device_chain.set_param(slot_index, target.param_index, value);
            }
        }
    }
}

pub(crate) fn apply_external_plugin_param_automation_block(
    host: &mut Box<dyn dream_plugins::PluginInstance>,
    lane: Option<&TrackAutomationState>,
    runtime_slot: &ExternalPluginRuntimeSlot,
    runtime_slot_index: usize,
    playhead_pos: i64,
) {
    if runtime_slot.instance_id.is_none() {
        return;
    }
    let Some(lane) = lane else {
        return;
    };
    if lane.external_plugin_params.is_empty() {
        return;
    }

    for ext_lane in &lane.external_plugin_params {
        let target = ext_lane.target;
        let points = &ext_lane.points;

        if let Some(target_slot_id) = target.slot_id
            && runtime_slot.slot_id != Some(target_slot_id)
        {
            continue;
        }
        if let Some(target_slot_index) = target.slot_index
            && target_slot_index != runtime_slot_index
        {
            continue;
        }

        let mut cursor = 0usize;
        if let Some(value) = eval_automation_with_cursor(points, playhead_pos, &mut cursor) {
            let normalized = f64::from(value.clamp(0.0, 1.0));
            let _ = host.set_parameter(target.param_index, normalized);
        }
    }
}

pub(crate) fn apply_flow_synth_automation_block(
    engine: &mut crate::flow_synth::FlowSynthEngine,
    lane: Option<&TrackAutomationState>,
    playhead_pos: i64,
) {
    let Some(lane) = lane else {
        return;
    };
    if lane.plugin_params.is_empty() {
        return;
    }

    for (key, points) in &lane.plugin_params {
        // Expected format: "flow:<numeric_id>:<param_key>"
        if key.starts_with("flow:") {
            let mut parts = key.split(':');
            let _ = parts.next(); // "flow"

            if let Some(id_str) = parts.next()
                && let Ok(node_id) = id_str.parse::<u64>()
                && let Some(param_key_str) = parts.next()
            {
                let mut cursor = 0usize;
                if let Some(value) = eval_automation_with_cursor(points, playhead_pos, &mut cursor) {
                    let flow_key = dream_ipc::FlowParamKey::from_str(param_key_str);
                    engine.update_node_param(node_id, flow_key, value);
                }
            }
        }
    }
}
