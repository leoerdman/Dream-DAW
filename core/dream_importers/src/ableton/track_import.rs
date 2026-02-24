// ═══════════════════════════════════════════════════════════════════════
// Dream DAW — Ableton ALS Track Clip Import
// ═══════════════════════════════════════════════════════════════════════
//
// Imports audio and MIDI clips from an Ableton track XML node.
// Handles:
//   • AudioClip nodes → audio clip creation with warp, fades, color
//   • MidiClip nodes → MIDI clip creation with notes, envelopes
//   • Overlapping clip resolution for both audio and MIDI
//
// ═══════════════════════════════════════════════════════════════════════

use std::path::Path;

use dream_io::audio_reader::AudioReader;
use dream_models::midi::{MidiClip, MidiNote};
use dream_models::project::{AudioClip, Track};
use dream_models::time::AbsoluteTime;

use super::clip_parser::{
    parse_audio_clip_warp, parse_audio_clip_warp_base_bpm, parse_clip_envelopes,
    parse_clip_follow_action, parse_clip_groove, parse_clip_launch, parse_clip_loop,
    parse_clip_scale_info, parse_clip_time_signature,
};
use super::color_map::{
    ableton_color_index_to_hex, ableton_color_to_track_color, extract_ableton_color_index,
};
use super::xml_helpers::*;

// ── Public API ─────────────────────────────────────────────────────────

/// Imports all audio and MIDI clips from an ALS track XML node.
///
/// Builds a pointee map for clip envelope resolution, parses each
/// clip with full metadata (warp, fades, follow actions, scale info,
/// time signature, groove), then resolves overlapping clips.
pub fn import_track_clips(
    track_node: roxmltree::Node<'_, '_>,
    track: &mut Track,
    als_path: &Path,
    bpm: f64,
    sample_rate: f64,
    build_pointee_map: impl Fn(roxmltree::Node<'_, '_>) -> std::collections::HashMap<String, String>,
) {
    let pointee_map = build_pointee_map(track_node);

    import_audio_clips(track_node, track, als_path, bpm, sample_rate, &pointee_map);
    import_midi_clips(track_node, track, bpm, sample_rate, &pointee_map);

    let adjusted_audio = resolve_overlapping_audio_clips(&mut track.clips);
    let adjusted_midi = resolve_overlapping_midi_clips(&mut track.midi_clips);
    if adjusted_audio > 0 || adjusted_midi > 0 {
        log::warn!(
            "[ALS Import] Resolved overlapping clips on track '{}': audio={}, midi={}",
            track.name,
            adjusted_audio,
            adjusted_midi
        );
    }
}

// ── Audio Clip Import ──────────────────────────────────────────────────

fn import_audio_clips(
    track_node: roxmltree::Node<'_, '_>,
    track: &mut Track,
    als_path: &Path,
    bpm: f64,
    sample_rate: f64,
    pointee_map: &std::collections::HashMap<String, String>,
) {
    let mut source_duration_cache: std::collections::HashMap<String, Option<i64>> =
        std::collections::HashMap::new();
    for clip_node in track_node
        .descendants()
        .filter(|n| n.is_element() && n.has_tag_name("AudioClip"))
    {
        let Some(clip) = parse_audio_clip(
            clip_node,
            als_path,
            bpm,
            sample_rate,
            pointee_map,
            &mut source_duration_cache,
        )
        else {
            continue;
        };
        track.clips.push(clip);
    }
}

fn parse_audio_clip(
    clip_node: roxmltree::Node<'_, '_>,
    als_path: &Path,
    bpm: f64,
    sample_rate: f64,
    pointee_map: &std::collections::HashMap<String, String>,
    source_duration_cache: &mut std::collections::HashMap<String, Option<i64>>,
) -> Option<AudioClip> {
    let (start_beats, duration_beats) = parse_clip_position(clip_node)?;

    let clip_name = node_child_value(clip_node, "Name")
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "Audio Clip".to_string());

    let source_path = super::file_resolver::extract_audio_clip_source_path(clip_node, als_path);

    let mut clip = AudioClip::new(
        clip_name,
        source_path,
        AbsoluteTime::new(beats_to_frames(start_beats, bpm, sample_rate)),
        AbsoluteTime::new(beats_to_frames(duration_beats, bpm, sample_rate).max(1)),
    );

    // Color
    if let Some(color_idx) = extract_ableton_color_index(clip_node) {
        clip.color_override = Some(ableton_color_to_track_color(color_idx, 0));
        clip.color_hex = ableton_color_index_to_hex(color_idx).map(|s| s.to_string());
    }

    // Volume
    if let Some(sample_volume) = node_child_value(clip_node, "SampleVolume")
        .as_deref()
        .and_then(parse_f64_value)
    {
        clip.gain = sample_volume.clamp(0.0, 8.0);
    }

    // Fades
    let (fade_in, fade_out) =
        super::file_resolver::parse_fade_frames_from_audio_clip(clip_node, bpm, sample_rate);
    clip.fade_in_frames = fade_in;
    clip.fade_out_frames = fade_out;

    // Source offset
    if let Some(start_relative_beats) = clip_node
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("StartRelative"))
        .and_then(|n| n.attribute("Value"))
        .and_then(parse_f64_value)
    {
        clip.source_offset =
            AbsoluteTime::new(beats_to_frames(start_relative_beats, bpm, sample_rate).max(0));
    }

    // Muted
    apply_clip_disabled(clip_node, &mut clip.is_muted);

    // Launch / Follow / Scale / Loop / Warp
    apply_common_clip_metadata_audio(&mut clip, clip_node);

    // Warp-specific
    let (is_warped, warp_mode, warp_markers) = parse_audio_clip_warp(clip_node);
    clip.is_warped = is_warped;
    clip.warp_mode = warp_mode;
    clip.warp_markers = warp_markers;
    if clip.is_warped {
        clip.warp_base_bpm = parse_audio_clip_warp_base_bpm(clip_node)
            .or_else(|| infer_warp_base_bpm_from_markers(&clip))
            .unwrap_or_else(|| bpm.max(1.0));
    }
    hydrate_warp_source_duration_frames(&mut clip, source_duration_cache);

    // Take ID
    clip.take_id = parse_i64_child(clip_node, "TakeId")
        .map(|v| v.clamp(i32::MIN as i64, i32::MAX as i64) as i32);
    clip.legato = parse_bool_child(clip_node, "Legato");
    clip.ram = parse_bool_child(clip_node, "Ram");

    // Time signature / Groove / Envelopes
    let (ts_num, ts_den) = parse_clip_time_signature(clip_node);
    clip.time_signature_numerator = ts_num;
    clip.time_signature_denominator = ts_den;
    let (groove_name, groove_amount) = parse_clip_groove(clip_node);
    clip.groove_name = groove_name;
    clip.groove_amount = groove_amount;
    clip.envelopes = parse_clip_envelopes(clip_node, pointee_map);

    Some(clip)
}

fn hydrate_warp_source_duration_frames(
    clip: &mut AudioClip,
    source_duration_cache: &mut std::collections::HashMap<String, Option<i64>>,
) {
    let key = clip.file_path.trim();
    if key.is_empty() {
        return;
    }
    let cached = if let Some(cached) = source_duration_cache.get(key) {
        *cached
    } else {
        let resolved = AudioReader::read_metadata(key)
            .ok()
            .and_then(|(_, _, frames_opt)| frames_opt)
            .and_then(|frames| i64::try_from(frames).ok())
            .filter(|frames| *frames > 0);
        source_duration_cache.insert(key.to_string(), resolved);
        resolved
    };
    if let Some(frames) = cached {
        clip.warp_source_duration_frames = frames.max(1);
    }
}

fn infer_warp_base_bpm_from_markers(clip: &AudioClip) -> Option<f64> {
    if !clip.is_warped {
        return None;
    }
    if clip.warp_markers.len() < 2 {
        return None;
    }
    let first = &clip.warp_markers[0];
    let last = &clip.warp_markers[clip.warp_markers.len() - 1];
    let sec_span = (last.sec_time - first.sec_time).abs();
    let beat_span = (last.beat_time - first.beat_time).abs();
    if sec_span <= f64::EPSILON || beat_span <= f64::EPSILON {
        return None;
    }
    let bpm = (beat_span * 60.0) / sec_span;
    if bpm.is_finite() && (20.0..=320.0).contains(&bpm) {
        return Some(bpm);
    }
    None
}

// ── MIDI Clip Import ───────────────────────────────────────────────────

fn import_midi_clips(
    track_node: roxmltree::Node<'_, '_>,
    track: &mut Track,
    bpm: f64,
    sample_rate: f64,
    pointee_map: &std::collections::HashMap<String, String>,
) {
    for clip_node in track_node
        .descendants()
        .filter(|n| n.is_element() && n.has_tag_name("MidiClip"))
    {
        let Some(clip) = parse_midi_clip(clip_node, bpm, sample_rate, pointee_map) else {
            continue;
        };
        track.midi_clips.push(clip);
    }
}

fn parse_midi_clip(
    clip_node: roxmltree::Node<'_, '_>,
    bpm: f64,
    sample_rate: f64,
    pointee_map: &std::collections::HashMap<String, String>,
) -> Option<MidiClip> {
    let (start_beats, duration_beats) = parse_clip_position(clip_node)?;

    let mut clip = MidiClip::new(
        node_child_value(clip_node, "Name")
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "MIDI Clip".to_string()),
        AbsoluteTime::new(beats_to_frames(start_beats, bpm, sample_rate)),
        AbsoluteTime::new(beats_to_frames(duration_beats, bpm, sample_rate).max(1)),
    );

    // Fades
    let (fade_in, fade_out) =
        super::file_resolver::parse_fade_frames_from_audio_clip(clip_node, bpm, sample_rate);
    clip.fade_in_frames = fade_in;
    clip.fade_out_frames = fade_out;

    // Muted
    apply_clip_disabled(clip_node, &mut clip.is_muted);

    // Launch / Follow / Scale / Loop
    apply_common_clip_metadata_midi(&mut clip, clip_node);

    // Take / Legato / Ram
    clip.take_id = parse_i64_child(clip_node, "TakeId")
        .map(|v| v.clamp(i32::MIN as i64, i32::MAX as i64) as i32);
    clip.legato = parse_bool_child(clip_node, "Legato");
    clip.ram = parse_bool_child(clip_node, "Ram");

    // MIDI-specific fields
    clip.velocity_amount = node_child_value(clip_node, "VelocityAmount")
        .as_deref()
        .and_then(parse_f64_value)
        .unwrap_or(0.0);
    clip.bank_select_coarse = parse_i32_child(clip_node, "BankSelectCoarse");
    clip.bank_select_fine = parse_i32_child(clip_node, "BankSelectFine");
    clip.program_change = parse_i32_child(clip_node, "ProgramChange");

    // Color
    if let Some(color_idx) = extract_ableton_color_index(clip_node) {
        clip.color_override = Some(ableton_color_to_track_color(color_idx, 0));
        clip.color_hex = ableton_color_index_to_hex(color_idx).map(|s| s.to_string());
    }

    // Time signature / Groove / Envelopes
    let (ts_num, ts_den) = parse_clip_time_signature(clip_node);
    clip.time_signature_numerator = ts_num;
    clip.time_signature_denominator = ts_den;
    let (groove_name, groove_amount) = parse_clip_groove(clip_node);
    clip.groove_name = groove_name;
    clip.groove_amount = groove_amount;
    clip.envelopes = parse_clip_envelopes(clip_node, pointee_map);

    // MIDI notes from KeyTracks
    import_midi_notes(&mut clip, clip_node, bpm, sample_rate);

    Some(clip)
}

fn import_midi_notes(
    clip: &mut MidiClip,
    clip_node: roxmltree::Node<'_, '_>,
    bpm: f64,
    sample_rate: f64,
) {
    for key_track in clip_node
        .descendants()
        .filter(|n| n.is_element() && n.has_tag_name("KeyTrack"))
    {
        let pitch = key_track
            .children()
            .find(|n| n.is_element() && n.has_tag_name("MidiKey"))
            .and_then(|n| n.attribute("Value"))
            .and_then(parse_i64_value)
            .map(|v| v.clamp(0, 127) as u8);
        let Some(pitch) = pitch else { continue };

        for note in key_track
            .descendants()
            .filter(|n| n.is_element() && n.has_tag_name("MidiNoteEvent"))
        {
            let time_beats = note
                .attribute("Time")
                .and_then(parse_f64_value)
                .unwrap_or(0.0);
            let duration_note_beats = note
                .attribute("Duration")
                .and_then(parse_f64_value)
                .unwrap_or(0.0);
            let velocity = note
                .attribute("Velocity")
                .and_then(parse_i64_value)
                .map(|v| v.clamp(1, 127) as u8)
                .unwrap_or(100);
            let start_frame = beats_to_frames(time_beats, bpm, sample_rate).max(0);
            let duration_frames = beats_to_frames(duration_note_beats, bpm, sample_rate).max(1);
            clip.add_note(MidiNote::new(pitch, velocity, start_frame, duration_frames));
        }
    }
}

// ── Overlap Resolution ─────────────────────────────────────────────────

fn resolve_overlapping_audio_clips(clips: &mut Vec<AudioClip>) -> usize {
    clips.sort_by(|a, b| {
        a.position
            .sample_frame
            .cmp(&b.position.sample_frame)
            .then_with(|| b.duration.sample_frame.cmp(&a.duration.sample_frame))
    });
    let mut cleaned: Vec<AudioClip> = Vec::with_capacity(clips.len());
    let mut last_end = i64::MIN;
    let mut adjusted = 0usize;
    for mut clip in clips.drain(..) {
        let start = clip.position.sample_frame;
        let _clip_end = start + clip.duration.sample_frame.max(1);
        if start < last_end {
            let trim = last_end - start;
            if trim >= clip.duration.sample_frame.max(1) {
                adjusted += 1;
                continue;
            }
            clip.position.sample_frame = last_end;
            clip.duration.sample_frame = (clip.duration.sample_frame - trim).max(1);
            clip.source_offset.sample_frame = (clip.source_offset.sample_frame + trim).max(0);
            adjusted += 1;
        }
        last_end = clip.position.sample_frame + clip.duration.sample_frame.max(1);
        cleaned.push(clip);
    }
    *clips = cleaned;
    adjusted
}

fn resolve_overlapping_midi_clips(clips: &mut Vec<MidiClip>) -> usize {
    clips.sort_by(|a, b| {
        a.position
            .sample_frame
            .cmp(&b.position.sample_frame)
            .then_with(|| b.duration.sample_frame.cmp(&a.duration.sample_frame))
    });
    let mut cleaned: Vec<MidiClip> = Vec::with_capacity(clips.len());
    let mut last_end = i64::MIN;
    let mut adjusted = 0usize;
    for mut clip in clips.drain(..) {
        let start = clip.position.sample_frame;
        if start < last_end {
            let trim = last_end - start;
            if trim >= clip.duration.sample_frame.max(1) {
                adjusted += 1;
                continue;
            }
            clip.position.sample_frame = last_end;
            clip.duration.sample_frame = (clip.duration.sample_frame - trim).max(1);
            adjusted += 1;
        }
        last_end = clip.position.sample_frame + clip.duration.sample_frame.max(1);
        cleaned.push(clip);
    }
    *clips = cleaned;
    adjusted
}

// ── Shared Clip Parsing Helpers ────────────────────────────────────────

fn parse_clip_position(clip_node: roxmltree::Node<'_, '_>) -> Option<(f64, f64)> {
    let start_beats = node_child_value(clip_node, "CurrentStart")
        .as_deref()
        .and_then(parse_f64_value)
        .unwrap_or(0.0);
    let end_beats = node_child_value(clip_node, "CurrentEnd")
        .as_deref()
        .and_then(parse_f64_value)
        .unwrap_or(start_beats);
    let duration_beats = (end_beats - start_beats).max(0.0);
    if duration_beats <= 0.0 {
        return None;
    }
    Some((start_beats, duration_beats))
}

fn apply_clip_disabled(clip_node: roxmltree::Node<'_, '_>, is_muted: &mut bool) {
    if let Some(disabled) = node_child_value(clip_node, "Disabled")
        .as_deref()
        .and_then(parse_bool_value)
    {
        *is_muted = disabled;
    }
}

fn apply_common_clip_metadata_audio(clip: &mut AudioClip, clip_node: roxmltree::Node<'_, '_>) {
    let (launch_mode, launch_quantization) = parse_clip_launch(clip_node);
    clip.launch_mode = launch_mode;
    clip.launch_quantization = launch_quantization;
    let (follow_enabled, follow_time, follow_a, follow_b, chance_a, chance_b) =
        parse_clip_follow_action(clip_node);
    clip.follow_action_enabled = follow_enabled;
    clip.follow_time = follow_time;
    clip.follow_action_a = follow_a;
    clip.follow_action_b = follow_b;
    clip.follow_chance_a = chance_a;
    clip.follow_chance_b = chance_b;
    let (in_key, scale_root, scale_name) = parse_clip_scale_info(clip_node);
    clip.is_in_key = in_key;
    clip.scale_root = scale_root;
    clip.scale_name = scale_name;
    let (loop_start_beats, loop_end_beats, loop_on) = parse_clip_loop(clip_node);
    clip.loop_start_beats = loop_start_beats;
    clip.loop_end_beats = loop_end_beats;
    clip.loop_on = loop_on;
}

fn apply_common_clip_metadata_midi(clip: &mut MidiClip, clip_node: roxmltree::Node<'_, '_>) {
    let (launch_mode, launch_quantization) = parse_clip_launch(clip_node);
    clip.launch_mode = launch_mode;
    clip.launch_quantization = launch_quantization;
    let (follow_enabled, follow_time, follow_a, follow_b, chance_a, chance_b) =
        parse_clip_follow_action(clip_node);
    clip.follow_action_enabled = follow_enabled;
    clip.follow_time = follow_time;
    clip.follow_action_a = follow_a;
    clip.follow_action_b = follow_b;
    clip.follow_chance_a = chance_a;
    clip.follow_chance_b = chance_b;
    let (in_key, scale_root, scale_name) = parse_clip_scale_info(clip_node);
    clip.is_in_key = in_key;
    clip.scale_root = scale_root;
    clip.scale_name = scale_name;
    let (loop_start_beats, loop_end_beats, loop_on) = parse_clip_loop(clip_node);
    clip.loop_start_beats = loop_start_beats;
    clip.loop_end_beats = loop_end_beats;
    clip.loop_on = loop_on;
}

fn parse_bool_child(node: roxmltree::Node<'_, '_>, tag: &str) -> bool {
    node_child_value(node, tag)
        .as_deref()
        .and_then(parse_bool_value)
        .unwrap_or(false)
}

fn parse_i64_child(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<i64> {
    node_child_value(node, tag)
        .as_deref()
        .and_then(parse_i64_value)
}

fn parse_i32_child(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<i32> {
    parse_i64_child(node, tag).map(|v| v.clamp(i32::MIN as i64, i32::MAX as i64) as i32)
}
