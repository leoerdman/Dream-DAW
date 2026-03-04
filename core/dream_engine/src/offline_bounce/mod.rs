// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Offline Bounce (Mix Export Engine)
// ═══════════════════════════════════════════════════════════════════════════
//
// THE PROBLEM:
//   A DAW without mix export is just a player. Users need to bounce
//   their project to a WAV file for distribution, mastering, or archival.
//
// THE SOLUTION: OfflineRenderer
//   Decoupled from cpal's real-time clock, this engine runs the same
//   RenderContext at maximum CPU speed. Instead of feeding samples to
//   a sound card, it writes them to a WAV file via `hound`.
//
// KEY DIFFERENCES FROM REAL-TIME:
//   - No cpal stream — we drive the render loop ourselves.
//   - No time pressure — we can use larger buffers (4096 frames).
//   - Synchronous I/O — disk reads happen inline (no streaming windows).
//   - Progress reporting — via callback, not metering atomics.
//
// ARCHITECTURE:
//   1. Create a standalone RenderContext (not shared with audio thread).
//   2. Load all clips into ClipPool (synchronous, full decode).
//   3. Loop: render buffer → accumulate into output Vec.
//   4. Write accumulated audio to WAV via WavWriter.
//
// ═══════════════════════════════════════════════════════════════════════════

pub use crate::offline_bounce_types::{BounceConfig, BounceError};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use uuid::Uuid;

use log::info;

use dream_clip_engine::midi_scheduler::{MidiScheduler, ScheduledNote};
use dream_clip_engine::pool::{ClipAudio, ClipPool};
use dream_clip_engine::scheduler::LoopRegion as ClipLoopRegion;
use dream_io::mp3_writer::Mp3Writer;
use dream_ipc::metering::MeterBank;
use dream_models::midi::MidiClip;
use dream_models::project::{AudioClip, Project, builtin_effect_type_from_plugin_id};
use dream_models::time::AbsoluteTime;
use dream_plugins::vst3_host::PluginInstanceArc;
use dream_plugins::{MidiEvent, TransportContext};

use dream_dsp::device_chain::DeviceChain;
use dream_dsp::device_slot::ProcessContext;
use dream_dsp::dsp_processor::BuiltinEffectType;

use crate::driver::ExternalPluginRuntimeSlot;
use crate::driver::MidiFxRuntimeConfig;
use crate::driver::{TrackAutomationState, AutomationPoint, ExternalParamAutomationLane};
use crate::driver::apply_external_plugin_param_automation_block;
use crate::driver::apply_track_mixer_automation_sample_accurate;
use crate::driver::parse_external_param_target;
use crate::driver::midi_dispatcher::{clamp_midi_pitch, quantize_to_scale};
use crate::render_callback::{RenderContext, soft_clip};
use crate::essence_synth::EssenceSynthEngine;
use crate::flow_synth::FlowSynthEngine;
use crate::instrument_core::AdsrParams;
use crate::sampler::{SampleRackEngine, SamplerEngine};

pub mod wav_writer;
use wav_writer::WavWriter;

// ── Constants ──────────────────────────────────────────────────────────

/// Offline bounce buffer size. Must match the typical RT audio callback
/// buffer size to ensure VST3 plugins (especially sidechain compressors)
/// produce identical output. Larger buffers cause envelope followers
/// (attack/release) to behave differently, corrupting sidechain ducking.
const OFFLINE_BUFFER_FRAMES: usize = 512;

/// Public alias for cross-crate access (e.g., plugin reactivation before export).
pub const OFFLINE_BUFFER_FRAMES_FOR_PLUGINS: usize = OFFLINE_BUFFER_FRAMES;

/// Maximum output channels (stereo).
const OFFLINE_CHANNELS: usize = 2;

struct FxChainProcessCtx<'a> {
    sample_rate: f64,
    time_sig_numerator: u8,
    time_sig_denominator: u8,
    plugin_registry: &'a HashMap<uuid::Uuid, PluginInstanceArc>,
    external_fx_map: &'a [Vec<ExternalPluginRuntimeSlot>],
    bpm: f64,
    playhead_pos: i64,
    left_slots: &'a [crate::render_callback::TrackSlot],
    right_slots: &'a [crate::render_callback::TrackSlot],
    /// MIDI events for the current track's VST instrument processing.
    midi_events: &'a [MidiEvent],
    /// Per-track automation state for VST parameter automation during export.
    automation: &'a [TrackAutomationState],
    /// Current track index (for automation lookup).
    track_idx: usize,
}

struct RenderRoutingCtx<'a> {
    clips_per_track: &'a [Vec<AudioClip>],
    clip_pool: &'a ClipPool,
    routing: &'a [Option<usize>],
    sidechains: &'a [Vec<Option<usize>>],
    post_sum_mask: &'a [bool],
    track_latencies: &'a [u32],
    max_tracking_delay: u32,
    pdc_buffers: &'a mut [DelayBuffer],
    plugin_registry: &'a HashMap<uuid::Uuid, PluginInstanceArc>,
    external_fx_map: &'a [Vec<ExternalPluginRuntimeSlot>],
    bpm: f64,
    time_sig_numerator: u8,
    time_sig_denominator: u8,
    master_device_chain: &'a mut DeviceChain,
    /// MIDI clips per track for VST instrument rendering.
    midi_clips_per_track: &'a [Vec<MidiClip>],
    /// Loop region for MIDI scheduling (if loop enabled).
    loop_region: Option<ClipLoopRegion>,
    /// Per-track MIDI FX configs for pitch/scale/velocity/random transforms.
    /// Built from project track data, mirroring the RT path's MidiFxRuntimeConfig.
    /// EXP-004 FIX: Borrowed slice instead of owned Vec to avoid per-chunk clone.
    midi_fx_configs: &'a [MidiFxRuntimeConfig],
    /// Pre-built per-track automation states for external plugin parameter automation.
    automation: &'a [TrackAutomationState],
    /// CRACKLE-FIX-4: Pre-allocated VST output scratch buffers (avoids per-chunk alloc).
    bounce_scratch_left: &'a mut [f32],
    bounce_scratch_right: &'a mut [f32],
    /// CRACKLE-FIX-5: Pre-allocated MIDI events Vec (avoids per-track-per-chunk alloc).
    bounce_midi_events: &'a mut Vec<MidiEvent>,
}

// ── Offline Bouncer ─────────────────────────────────────────────────────

/// The offline bounce engine.
///
/// Runs the entire render pipeline at maximum CPU speed (not tied to
/// the cpal audio callback) and writes the result to a WAV file.
///
/// # Usage
/// ```ignore
/// let bouncer = OfflineRenderer::new(config);
/// bouncer.bounce(&project, &clip_pool, |progress| {
///     println!("Bounce progress: {:.0}%", progress * 100.0);
/// })?;
/// ```
pub struct OfflineRenderer {
    config: BounceConfig,
    /// Cancellation flag - set to true to abort the bounce.
    /// The bouncer checks this flag during each render iteration.
    pub cancel_flag: Arc<AtomicBool>,
}

struct DelayBuffer {
    left: Vec<f32>,
    right: Vec<f32>,
    write_idx: usize,
}

impl DelayBuffer {
    fn new() -> Self {
        Self { left: Vec::new(), right: Vec::new(), write_idx: 0 }
    }
    fn len(&self) -> usize { self.left.len() }
    fn resize(&mut self, size: usize) {
        self.left.resize(size, 0.0);
        self.right.resize(size, 0.0);
        self.write_idx = self.write_idx.min(size.saturating_sub(1));
    }
    fn process_stereo(&mut self, in_out_l: &mut [f32], in_out_r: &mut [f32]) {
        let size = self.left.len();
        if size == 0 { return; }
        for i in 0..in_out_l.len() {
            let out_l = self.left[self.write_idx];
            let out_r = self.right[self.write_idx];
            self.left[self.write_idx] = in_out_l[i];
            self.right[self.write_idx] = in_out_r[i];
            in_out_l[i] = out_l;
            in_out_r[i] = out_r;
            self.write_idx = (self.write_idx + 1) % size;
        }
    }
}

impl OfflineRenderer {
    fn collect_declared_external_slot_ids(
        node: &dream_models::project::DeviceNode,
        parent_bypassed: bool,
        out: &mut Vec<Uuid>,
    ) {
        match node {
            dream_models::project::DeviceNode::Single(slot) => {
                let effective_bypassed = parent_bypassed || slot.is_bypassed;
                if effective_bypassed {
                    return;
                }
                let pid = slot.plugin_id.as_str();
                if !pid.starts_with("internal://") && !pid.starts_with("missing://") {
                    out.push(slot.id);
                }
            }
            dream_models::project::DeviceNode::Rack(rack) => {
                let rack_bypassed = parent_bypassed || rack.is_bypassed;
                let has_solo = rack.chains.iter().any(|c| c.is_solo);
                for chain in &rack.chains {
                    if chain.is_disabled { continue; }
                    if has_solo && !chain.is_solo { continue; }
                    for child in &chain.devices {
                        Self::collect_declared_external_slot_ids(child, rack_bypassed, out);
                    }
                }
            }
        }
    }

    fn validate_external_vst_runtime_bindings(
        project: &Project,
        external_fx_map: &[Vec<ExternalPluginRuntimeSlot>],
    ) -> Result<(), BounceError> {
        let mut unresolved_slots: Vec<String> = Vec::new();
        let mut recovered_by_presence: Vec<String> = Vec::new();

        for (track_idx, track) in project.tracks.iter().enumerate() {
            let mut declared_slot_ids: Vec<Uuid> = Vec::new();
            if let Some(inst) = track.instrument.as_ref() {
                Self::collect_declared_external_slot_ids(inst, false, &mut declared_slot_ids);
            }
            for node in &track.effects {
                Self::collect_declared_external_slot_ids(node, false, &mut declared_slot_ids);
            }
            if declared_slot_ids.is_empty() {
                continue;
            }
            let runtime_external_slots: Vec<&ExternalPluginRuntimeSlot> = external_fx_map
                .get(track_idx)
                .map(|slots| {
                    slots
                        .iter()
                        .filter(|slot| {
                            slot.internal_slot_index.is_none() && slot.instance_id.is_some()
                        })
                        .collect()
                })
                .unwrap_or_default();
            let runtime_slot_ids: std::collections::HashSet<Uuid> = runtime_external_slots
                .iter()
                .filter_map(|slot| slot.slot_id)
                .collect();

            let mut has_exact_match = false;
            for slot_id in declared_slot_ids {
                if !runtime_slot_ids.contains(&slot_id) {
                    unresolved_slots.push(format!(
                        "scope=track name='{}' track_index={} track_id={} slot_id={}",
                        track.name, track_idx, track.id, slot_id
                    ));
                } else {
                    has_exact_match = true;
                }
            }
            if !has_exact_match && !runtime_external_slots.is_empty() {
                unresolved_slots.retain(|msg| {
                    !msg.starts_with(&format!(
                        "scope=track name='{}' track_index={} track_id={}",
                        track.name, track_idx, track.id
                    ))
                });
                recovered_by_presence.push(format!(
                    "scope=track name='{}' track_index={} track_id={} fallback=runtime_external_presence count={}",
                    track.name,
                    track_idx,
                    track.id,
                    runtime_external_slots.len()
                ));
            }
        }

        let master_runtime_index = project.tracks.len();
        let mut master_declared_slot_ids: Vec<Uuid> = Vec::new();
        if let Some(inst) = project.master_track.instrument.as_ref() {
            Self::collect_declared_external_slot_ids(inst, false, &mut master_declared_slot_ids);
        }
        for node in &project.master_track.effects {
            Self::collect_declared_external_slot_ids(node, false, &mut master_declared_slot_ids);
        }
        if !master_declared_slot_ids.is_empty() {
            let master_runtime_external_slots: Vec<&ExternalPluginRuntimeSlot> = external_fx_map
                .get(master_runtime_index)
                .map(|slots| {
                    slots
                        .iter()
                        .filter(|slot| {
                            slot.internal_slot_index.is_none() && slot.instance_id.is_some()
                        })
                        .collect()
                })
                .unwrap_or_default();
            let master_runtime_slot_ids: std::collections::HashSet<Uuid> =
                master_runtime_external_slots
                    .iter()
                    .filter_map(|slot| slot.slot_id)
                    .collect();
            let mut master_has_exact_match = false;
            for slot_id in master_declared_slot_ids {
                if !master_runtime_slot_ids.contains(&slot_id) {
                    unresolved_slots.push(format!(
                        "scope=master track_index={} slot_id={}",
                        master_runtime_index, slot_id
                    ));
                } else {
                    master_has_exact_match = true;
                }
            }
            if !master_has_exact_match && !master_runtime_external_slots.is_empty() {
                unresolved_slots.retain(|msg| {
                    !msg.starts_with(&format!(
                        "scope=master track_index={}",
                        master_runtime_index
                    ))
                });
                recovered_by_presence.push(format!(
                    "scope=master track_index={} fallback=runtime_external_presence count={}",
                    master_runtime_index,
                    master_runtime_external_slots.len()
                ));
            }
        }

        if unresolved_slots.is_empty() {
            if !recovered_by_presence.is_empty() {
                log::warn!(
                    "[Bounce] External runtime binding recovered via fallback: {}",
                    recovered_by_presence.join("; ")
                );
            }
            return Ok(());
        }

        Err(BounceError::RenderError(format!(
            "External VST runtime binding is incomplete: {}",
            unresolved_slots.join("; ")
        )))
    }

    /// Populates a DeviceChain from a list of DeviceNode effects,
    /// including param sync from PluginSlot.params.
    /// This ensures the offline bounce uses the same native FX settings
    /// that the user configured in the UI.
    fn collect_internal_slots<'a>(
        nodes: &'a [dream_models::project::DeviceNode],
        parent_bypassed: bool,
        out: &mut Vec<(&'a dream_models::project::PluginSlot, bool)>,
    ) {
        for node in nodes {
            match node {
                dream_models::project::DeviceNode::Single(slot) => {
                    if slot.plugin_id.starts_with("internal://effect/") {
                        out.push((slot, parent_bypassed || slot.is_bypassed));
                    }
                }
                dream_models::project::DeviceNode::Rack(rack) => {
                    let rack_bypassed = parent_bypassed || rack.is_bypassed;
                    let has_solo = rack.chains.iter().any(|c| c.is_solo);
                    for chain in &rack.chains {
                        if chain.is_disabled { continue; }
                        if has_solo && !chain.is_solo { continue; }
                        Self::collect_internal_slots(&chain.devices, rack_bypassed, out);
                    }
                }
            }
        }
    }

    /// Populates a DeviceChain from a list of DeviceNode effects,
    /// including param sync from PluginSlot.params.
    /// This ensures the offline bounce uses the same native FX settings
    /// that the user configured in the UI.
    fn populate_device_chain_from_effects(
        chain: &mut DeviceChain,
        effects: &[dream_models::project::DeviceNode],
    ) {
        let mut slots = Vec::new();
        Self::collect_internal_slots(effects, false, &mut slots);

        let mut slot_index: usize = 0;
        for (slot, bypassed) in slots {
            if let Some(effect_type) = builtin_effect_type_from_plugin_id(&slot.plugin_id)
                .and_then(BuiltinEffectType::from_u8)
            {
                chain.add_builtin_effect(slot_index, effect_type);
                if bypassed {
                    chain.set_bypass(slot_index, true);
                }
                // ── CRITICAL FIX: Sync runtime param values ──
                if let Some(ref params) = slot.params {
                    for (param_idx, &value) in params.iter().enumerate() {
                        chain.set_param(slot_index, param_idx as u32, value);
                    }
                }
                slot_index += 1;
            }
        }
    }

    fn configure_render_ctx_track_mix_state(
        project: &Project,
        render_ctx: &mut RenderContext,
        routing: &[Option<usize>],
    ) {
        let num_tracks = project.tracks.len();
        let mut is_explicit_solo = vec![false; num_tracks];
        let mut is_explicit_mute = vec![false; num_tracks];

        for (i, track) in project.tracks.iter().enumerate() {
            is_explicit_solo[i] = track.is_solo;
            is_explicit_mute[i] = track.effective_disabled_from_model();
        }

        let any_solo = is_explicit_solo.iter().any(|&s| s);

        let mut effective_mute = is_explicit_mute.clone();
        let mut effective_solo = is_explicit_solo.clone();

        // ── BUG-076 FIX: Topology-aware implicit mute/solo propagation ──

        // 1. Propagate DOWN: If parent muted → child muted. If parent soloed → child soloed.
        loop {
            let mut changed = false;
            for i in 0..num_tracks {
                if let Some(parent_idx) = routing[i] {
                    if effective_mute[parent_idx] && !effective_mute[i] {
                        effective_mute[i] = true;
                        changed = true;
                    }
                    if effective_solo[parent_idx] && !effective_solo[i] {
                        effective_solo[i] = true;
                        changed = true;
                    }
                }
            }
            if !changed {
                break;
            }
        }

        // 2. Propagate UP: If child soloed → parent implicitly soloed (safe-solo)
        loop {
            let mut changed = false;
            for i in 0..num_tracks {
                if let Some(parent_idx) = routing[i]
                    && effective_solo[i]
                    && !effective_solo[parent_idx]
                {
                    effective_solo[parent_idx] = true;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }

        for (idx, slot) in render_ctx.track_slots.iter_mut().enumerate() {
            let Some(track) = project.tracks.get(idx) else {
                slot.strip.set_volume(1.0);
                slot.strip.set_pan(0.0);
                slot.strip.set_effective_gain(1.0);
                slot.strip.set_output_enabled(false);
                continue;
            };

            slot.strip.set_volume(track.volume.clamp(0.0, 2.0) as f32);
            slot.strip.set_pan(track.pan.clamp(-1.0, 1.0) as f32);

            let enabled = !effective_mute.get(idx).copied().unwrap_or(false)
                && (!any_solo || effective_solo.get(idx).copied().unwrap_or(false));

            slot.strip
                .set_effective_gain(if enabled { 1.0 } else { 0.0 });
            slot.strip.set_output_enabled(enabled);
        }
    }

    // ── Routing Helpers ───────────────────────────────────────────────

    /// Builds routing map and post-sum processing mask from project.
    ///
    /// Returns `(routing, post_sum_mask)` where:
    /// - `routing[i] = Some(j)` means track `i` routes to track `j`
    /// - `post_sum_mask[i] = true` means track `i` is a group/bus
    fn build_routing(project: &Project) -> (Vec<Option<usize>>, Vec<bool>) {
        // BUG-26 FIX: Build O(1) index map instead of O(n²) linear scan per track.
        let id_to_index: std::collections::HashMap<uuid::Uuid, usize> = project
            .tracks
            .iter()
            .enumerate()
            .map(|(i, t)| (t.id, i))
            .collect();

        let routing: Vec<Option<usize>> = project
            .tracks
            .iter()
            .map(|track| {
                track
                    .output_destination_id
                    .and_then(|dest_id| id_to_index.get(&dest_id).copied())
            })
            .collect();

        let mut mask = vec![false; project.tracks.len()];
        for dest_idx in routing.iter().flatten() {
            if *dest_idx < mask.len() {
                mask[*dest_idx] = true;
            }
        }

        (routing, mask)
    }

    fn collect_sidechain_sources_from_node(
        node: &dream_models::project::DeviceNode,
        project: &Project,
        parent_bypassed: bool,
        out: &mut Vec<Option<usize>>,
    ) {
        match node {
            dream_models::project::DeviceNode::Single(slot) => {
                // SIDECHAIN-PARITY FIX: Always emit sidechain source entries
                // regardless of bypass state. Previously bypassed plugins had
                // their SC sources omitted, shifting indices and silently
                // breaking routing for subsequent plugins. The live path
                // (clip_pool.rs:291-302) correctly preserves bypassed entries.
                if let Some(sidechain_id) = &slot.sidechain_source_track_id {
                    let idx = project
                        .tracks
                        .iter()
                        .position(|t| t.id.to_string() == *sidechain_id);
                    out.push(idx);
                }
            }
            dream_models::project::DeviceNode::Rack(rack) => {
                let rack_bypassed = parent_bypassed || rack.is_bypassed;
                let has_solo = rack.chains.iter().any(|c| c.is_solo);
                for chain in &rack.chains {
                    if chain.is_disabled { continue; }
                    if has_solo && !chain.is_solo { continue; }
                    for n in &chain.devices {
                        Self::collect_sidechain_sources_from_node(n, project, rack_bypassed, out);
                    }
                }
            }
        }
    }

    fn build_sidechains(project: &Project) -> Vec<Vec<Option<usize>>> {
        project
            .tracks
            .iter()
            .map(|track| {
                let mut sources = Vec::new();
                if let Some(inst) = track.instrument.as_ref() {
                    Self::collect_sidechain_sources_from_node(inst, project, false, &mut sources);
                }
                for node in &track.effects {
                    Self::collect_sidechain_sources_from_node(node, project, false, &mut sources);
                }
                sources
            })
            .collect()
    }

    /// Builds a `MidiFxRuntimeConfig` from a project track's MIDI FX effects
    /// and automation lanes. This mirrors the RT path's config built in
    /// `sync_engine.rs::rebuild_midi_snapshot_from_project()`.
    fn build_midi_fx_config_from_track(
        track: &dream_models::project::Track,
    ) -> MidiFxRuntimeConfig {
        fn has_midi_fx(track: &dream_models::project::Track, plugin_ids: &[&str]) -> bool {
            track.effects.iter().any(|node| {
                node.collect_plugin_slots().iter().any(|slot| {
                    // Skip bypassed FX — they should not influence the runtime config
                    if slot.is_bypassed {
                        return false;
                    }
                    plugin_ids
                        .iter()
                        .any(|id| slot.plugin_id.eq_ignore_ascii_case(id))
                })
            })
        }

        fn first_param(track: &dream_models::project::Track, plugin_ids: &[&str], idx: usize) -> Option<f32> {
            for node in &track.effects {
                for slot in node.collect_plugin_slots() {
                    // Skip bypassed FX — they should not contribute param defaults
                    if slot.is_bypassed {
                        continue;
                    }
                    if !plugin_ids.iter().any(|id| slot.plugin_id.eq_ignore_ascii_case(id)) {
                        continue;
                    }
                    if let Some(v) = slot.params.as_ref().and_then(|p| p.get(idx).copied())
                        && v.is_finite() { return Some(v); }
                }
            }
            None
        }

        fn lane_value(track: &dream_models::project::Track, keys: &[&str], default: f32) -> f32 {
            fn norm(raw: &str) -> String {
                let lowered = raw.to_ascii_lowercase();
                let unscoped = if let Some(rest) = lowered.strip_prefix("slot:") {
                    if let Some(at) = rest.find(':') { &rest[at+1..] } else { lowered.as_str() }
                } else { lowered.as_str() };
                unscoped.chars().filter(|c| c.is_ascii_alphanumeric()).collect()
            }
            let normalized: Vec<String> = keys.iter().map(|k| norm(k)).collect();
            for lane in &track.automation_lanes {
                let lane_key = norm(&lane.param_id);
                if normalized.iter().any(|key| lane_key == *key || lane_key.ends_with(key.as_str()))
                    && let Some(pt) = lane.points.first() {
                        return pt.value as f32;
                    }
            }
            default
        }

        let has_pitch = has_midi_fx(track, &["internal://midi-fx/pitch"]);
        let has_scale = has_midi_fx(track, &["internal://midi-fx/scale", "internal://midi-fx/chord"]);
        let has_velocity = has_midi_fx(track, &[
            "internal://midi-fx/velocity", "internal://midi-fx/note-length",
            "internal://midi-fx/cc-control", "internal://midi-fx/expression-control",
        ]);
        let has_random = has_midi_fx(track, &["internal://midi-fx/random", "internal://midi-fx/arpeggiator"]);

        MidiFxRuntimeConfig {
            pitch_enabled: has_pitch,
            pitch_semitones: lane_value(track,
                &["midi.pitch.semitones", "midifx.pitch.semitones", "midiPitch.semitones"],
                first_param(track, &["internal://midi-fx/pitch"], 0).unwrap_or(0.0),
            ).round().clamp(-48.0, 48.0) as i8,
            scale_enabled: has_scale,
            scale_root: lane_value(track,
                &["midi.scale.root", "midifx.scale.root", "midiScale.root"],
                first_param(track, &["internal://midi-fx/scale"], 0).unwrap_or(0.0),
            ).round().rem_euclid(12.0) as u8,
            scale_mask: lane_value(track,
                &["midi.scale.mask", "midifx.scale.mask", "midiScale.mask"],
                first_param(track, &["internal://midi-fx/scale"], 1).unwrap_or(4095.0),
            ).round().clamp(1.0, 4095.0) as u16,
            velocity_enabled: has_velocity,
            velocity_gain: lane_value(track,
                &["midi.velocity.gain", "midifx.velocity.gain", "midiVelocity.gain"],
                first_param(track, &["internal://midi-fx/velocity"], 0).unwrap_or(1.0),
            ).clamp(0.0, 4.0),
            velocity_offset: lane_value(track,
                &["midi.velocity.offset", "midifx.velocity.offset", "midiVelocity.offset"],
                first_param(track, &["internal://midi-fx/velocity"], 1).unwrap_or(0.0),
            ).round().clamp(-127.0, 127.0) as i8,
            random_enabled: has_random,
            random_semitones: lane_value(track,
                &["midi.random.semitones", "midifx.random.semitones", "midiRandom.semitones"],
                first_param(track, &["internal://midi-fx/random"], 0).unwrap_or(0.0),
            ).round().clamp(-24.0, 24.0) as i8,
            random_chance: lane_value(track,
                &["midi.random.chance", "midifx.random.chance", "midiRandom.chance"],
                first_param(track, &["internal://midi-fx/random"], 1).unwrap_or(1.0),
            ).clamp(0.0, 1.0),
        }
    }

    /// Processes the unified FX chain for a single track slot.
    ///
    /// Mirrors the RT driver's Insert processing logic:
    /// 1. If `external_fx_map[track_idx]` exists, iterate each `ExternalPluginRuntimeSlot` in order.
    ///    - `internal_slot_index` → native FX: `device_chain.process_slot_with_sidechain()`
    ///    - `instance_id` → VST3: lock the `PluginInstanceArc`, set transport, call `process_with_sidechain()`
    /// 2. If no external FX map entry, fall back to `device_chain.process_stereo()`.
    fn process_track_fx_chain(
        slot: &mut crate::render_callback::TrackSlot,
        track_idx: usize,
        frame_count: usize,
        ctx: &FxChainProcessCtx<'_>,
        scratch_left: &mut [f32],
        scratch_right: &mut [f32],
    ) {
        let c = frame_count
            .min(slot.buf_left.len())
            .min(slot.buf_right.len());

        crate::driver::automation::apply_native_device_automation_sample_accurate_block(
            &mut slot.device_chain,
            ctx.automation.get(track_idx),
            ctx.playhead_pos,
        );

        if let Some(runtime_slots) = ctx.external_fx_map.get(track_idx) {
            if !runtime_slots.is_empty() {
                let has_external = runtime_slots.iter().any(|s| s.instance_id.is_some());
                let has_internal_sidechain = runtime_slots
                    .iter()
                    .any(|s| s.internal_slot_index.is_some() && s.sidechain_track_index.is_some());
                // BOUNCE-FIX: Validate internal_slot_index bounds to prevent
                // out-of-bounds access on DeviceChain (mirrors RT indices_valid check).
                let chain_len = slot.device_chain.len();
                let indices_valid = runtime_slots.iter().all(|s| {
                    s.internal_slot_index.is_none_or(|idx| idx < chain_len)
                });
                // BUG-CHAIN-001 FIX (BOUNCE PARITY): Only fall back to
                // whole-chain when there are NO external plugins AND NO internal
                // sidechains AND indices are valid. Mirrors the RT path fix.
                if !has_external && !has_internal_sidechain && indices_valid {
                    if !slot.device_chain.is_empty() {
                        let pctx = ProcessContext {
                            sample_rate: ctx.sample_rate as f32,
                            playhead_frames: ctx.playhead_pos,
                            tempo: ctx.bpm,
                            is_playing: true,
                            time_sig_numerator: ctx.time_sig_numerator,
                            time_sig_denominator: ctx.time_sig_denominator,
                        };
                        slot.device_chain.process_with_context(
                            &mut slot.buf_left[..c],
                            &mut slot.buf_right[..c],
                            &pctx,
                        );
                    }
                } else {
                    for (runtime_slot_idx, runtime_slot) in runtime_slots.iter().enumerate() {
                        // PARITY FIX 1: Skip bypassed runtime slots — audio
                        // passes through unmodified. The slot stays in the snapshot
                        // to keep subsequent indices stable, matching the live
                        // path at audio_thread_runner.rs:550.
                        if runtime_slot.is_bypassed {
                            continue;
                        }
                        let source_slot = runtime_slot.sidechain_track_index.and_then(|src_idx| {
                            if src_idx < track_idx {
                                ctx.left_slots.get(src_idx)
                            } else if src_idx == track_idx {
                                None
                            } else {
                                ctx.right_slots.get(src_idx - track_idx - 1)
                            }
                        });
                        let (sc_l, sc_r) = source_slot
                            .map(|src| (Some(&src.buf_left[..c]), Some(&src.buf_right[..c])))
                            .unwrap_or((None, None));

                        // ── Native FX slot ──
                        if let Some(internal_idx) = runtime_slot.internal_slot_index {
                            let pctx = ProcessContext {
                                sample_rate: ctx.sample_rate as f32,
                                playhead_frames: ctx.playhead_pos,
                                tempo: ctx.bpm,
                                is_playing: true,
                                time_sig_numerator: ctx.time_sig_numerator,
                                time_sig_denominator: ctx.time_sig_denominator,
                            };
                            
                            slot.device_chain.process_slot_with_sidechain_ctx(
                                internal_idx,
                                &mut slot.buf_left[..c],
                                &mut slot.buf_right[..c],
                                sc_l,
                                sc_r,
                                &pctx,
                            );

                            continue;
                        }

                        // ── VST3 FX slot ──
                        if let Some(instance_id) = runtime_slot.instance_id {
                            let Some(plugin_mtx) = ctx.plugin_registry.get(&instance_id) else {
                                log::warn!(
                                    "[Bounce/FX] Track {}: VST3 instance {} not in registry — skipping",
                                    track_idx,
                                    instance_id
                                );
                                continue;
                            };
                            // EXPORT-DISTORTION-FIX: Direct blocking lock is safe — the RT
                            // thread skips all VST try_lock() calls when export_active=true,
                            // so no contention exists. The previous cooperative try_lock()+
                            // sleep(1ms) loop introduced timing jitter in the render.
                            let mut host = plugin_mtx.lock();
                            let transport = TransportContext {
                                sample_rate: ctx.sample_rate,
                                position_samples: ctx.playhead_pos,
                                tempo: ctx.bpm,
                                is_playing: true,
                                is_recording: false,
                                time_sig_numerator: i32::from(ctx.time_sig_numerator),
                                time_sig_denominator: i32::from(ctx.time_sig_denominator),
                                cycle_active: false,
                                loop_start_samples: 0,
                                loop_end_samples: 0,
                            };
                            host.set_transport_context(transport);

                            // BOUNCE-AUTOMATION-FIX: Apply external plugin parameter
                            // automation during export (mirrors RT path's call at
                            // audio_thread_runner.rs:617). Without this, automated
                            // plugin parameters are ignored during export.
                            apply_external_plugin_param_automation_block(
                                &mut host,
                                ctx.automation.get(ctx.track_idx),
                                runtime_slot,
                                runtime_slot_idx,
                                ctx.playhead_pos,
                            );

                            // CRACKLE-FIX-4: Use pre-allocated scratch buffers instead of
                            // per-chunk Vec allocation. Eliminates heap thrashing.
                            let out_left = &mut scratch_left[..c];
                            let out_right = &mut scratch_right[..c];
                            out_left.fill(0.0);
                            out_right.fill(0.0);
                            let main_inputs: [&[f32]; 2] =
                                [&slot.buf_left[..c], &slot.buf_right[..c]];
                            let mut out_slices: [&mut [f32]; 2] =
                                [&mut out_left[..], &mut out_right[..]];
                            let midi_to_send: &[MidiEvent] = ctx.midi_events;
                            let empty_midi: &[MidiEvent] = &[];
                            let use_midi =
                                if !midi_to_send.is_empty() {
                                    midi_to_send
                                } else {
                                    empty_midi
                                };
                            let sc_pair =
                                source_slot.map(|src| [&src.buf_left[..c], &src.buf_right[..c]]);

                            if let Err(proc_err) = host.process_with_sidechain(
                                &main_inputs,
                                sc_pair.as_ref().map(|pair| pair.as_slice()),
                                &mut out_slices,
                                c,
                                use_midi,
                            ) {
                                static LOGGED_INSTANCES: std::sync::atomic::AtomicU64 =
                                    std::sync::atomic::AtomicU64::new(0);
                                let prev = LOGGED_INSTANCES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                if prev < 8 {
                                    log::warn!(
                                        "[Bounce/FX] Track {}: process_with_sidechain failed: {} (further errors suppressed)",
                                        track_idx, proc_err
                                    );
                                }
                            }

                            // ── ULTIMATE VST SLOT DIAGNOSTIC ──
                            // Logs EVERY slot interaction for ALL buffers (no limit).
                            // Smart: only logs when something interesting happens.
                            {
                                let out_rms: f32 = (scratch_left[..c].iter()
                                    .chain(scratch_right[..c].iter())
                                    .map(|s| s * s).sum::<f32>() / (2.0 * c as f32)).sqrt();
                                let in_rms: f32 = (main_inputs[0].iter().chain(main_inputs[1].iter())
                                    .map(|s| s * s).sum::<f32>() / (2.0 * c as f32)).sqrt();
                                let midi_sent = use_midi.len();
                                let has_sc = sc_pair.is_some();
                                let sc_rms = sc_pair.as_ref().map(|pair| {
                                    (pair[0].iter().chain(pair[1].iter())
                                        .map(|s| s * s).sum::<f32>() / (2.0 * c as f32)).sqrt()
                                }).unwrap_or(-1.0);
                                // Log when: (a) non-zero output, (b) sidechain active,
                                // (c) MIDI sent, (d) instrument slot — always interesting
                                let interesting = out_rms > 0.0001 || midi_sent > 0
                                    || (has_sc && sc_rms > 0.0001)
                                    || runtime_slot.is_instrument;
                                static SLOT_LOG_COUNT: std::sync::atomic::AtomicU32 =
                                    std::sync::atomic::AtomicU32::new(0);
                                let sl_n = SLOT_LOG_COUNT.load(std::sync::atomic::Ordering::Relaxed);
                                if interesting && sl_n < 3000 {
                                    let out_peak: f32 = scratch_left[..c].iter()
                                        .chain(scratch_right[..c].iter())
                                        .map(|s| s.abs())
                                        .fold(0.0f32, f32::max);
                                    log::debug!(
                                        "[Bounce-VST] T[{}]S[{}] inst={} sc={} byp={} | in={:.5} sc={:.5} out={:.5} peak={:.5} midi={}",
                                        track_idx, runtime_slot_idx,
                                        runtime_slot.is_instrument, has_sc, runtime_slot.is_bypassed,
                                        in_rms, sc_rms, out_rms, out_peak, midi_sent
                                    );
                                    SLOT_LOG_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                }
                            }

                            // BOUNCE-FIX: Sanitize plugin output — NaN/Inf from a
                            // misbehaving plugin would corrupt the entire export file.
                            for i in 0..c {
                                if !scratch_left[i].is_finite() {
                                    scratch_left[i] = 0.0;
                                }
                                if !scratch_right[i].is_finite() {
                                    scratch_right[i] = 0.0;
                                }
                            }
                            slot.buf_left[..c].copy_from_slice(&scratch_left[..c]);
                            slot.buf_right[..c].copy_from_slice(&scratch_right[..c]);
                        }
                    }
                }
            } else if !slot.device_chain.is_empty() {
                let pctx = ProcessContext {
                    sample_rate: ctx.sample_rate as f32,
                    playhead_frames: ctx.playhead_pos,
                    tempo: ctx.bpm,
                    is_playing: true,
                    time_sig_numerator: ctx.time_sig_numerator,
                    time_sig_denominator: ctx.time_sig_denominator,
                };
                slot.device_chain.process_with_context(
                    &mut slot.buf_left[..c],
                    &mut slot.buf_right[..c],
                    &pctx,
                );
            }
        } else if !slot.device_chain.is_empty() {
            let pctx = ProcessContext {
                sample_rate: ctx.sample_rate as f32,
                playhead_frames: ctx.playhead_pos,
                tempo: ctx.bpm,
                is_playing: true,
                time_sig_numerator: ctx.time_sig_numerator,
                time_sig_denominator: ctx.time_sig_denominator,
            };
            slot.device_chain.process_with_context(
                &mut slot.buf_left[..c],
                &mut slot.buf_right[..c],
                &pctx,
            );
        }
    }

    /// Routing-aware render: replaces `RenderContext::render()` with
    /// DAG-ordered summing that correctly processes group/bus tracks.
    ///
    /// This replicates what `GraphRenderer::render()` does in the
    /// real-time driver, producing identical audio output.
    fn render_routing_aware(
        render_ctx: &mut RenderContext,
        output: &mut [f32],
        ctx: &mut RenderRoutingCtx<'_>,
    ) {
        let channels = render_ctx.channels.max(1);
        let frame_count = output.len() / channels;

        // Phase 1: Fill source track slots with audio clips
        render_ctx.read_audio_clips_into_tracks(frame_count, ctx.clips_per_track, ctx.clip_pool, ctx.bpm);

        // ── CRITICAL: Capture playhead BEFORE advancing for MIDI scheduling.
        // MIDI events need to be scheduled at the CURRENT buffer's position,
        // not the next buffer's. The real-time driver also reads the playhead
        // before advancing.
        let playhead_pos = render_ctx.playhead.position();

        // Advance the playhead AFTER capturing for scheduling.
        render_ctx.advance_playhead_by_frames(frame_count);

        let sample_rate = render_ctx.sample_rate;
        let track_slots_len = render_ctx.track_slots.len();

        // ── ENTERPRISE DAG TOPOLOGY ──
        // Generate a fully topologically sorted DAG resolving routing
        // AND sidechain dependencies accurately.
        let snapshot = crate::driver::prepare_graph_snapshot_for_routing(
            track_slots_len,
            ctx.routing,
            ctx.sidechains,
            ctx.track_latencies,
            ctx.max_tracking_delay as u64,
        );

        render_ctx.master_bus.clear(frame_count);

        // Phase 1.5 - 4: Unified Topological Processing Loop
        // Correctly processes leaf and group tracks in topological dependency order.
        // Fallback: if topology plan is temporarily empty, process tracks linearly
        // to avoid silent exports (especially visible on external VST instruments).
        let processing_order: Vec<_> = if snapshot.plan.processing_order.is_empty() {
            let mut fallback = snapshot
                .dag
                .graph()
                .node_indices()
                .filter(|idx| snapshot.dag.node(*idx).id.0 != 0)
                .collect::<Vec<_>>();
            fallback.sort_unstable_by_key(|idx| snapshot.dag.node(*idx).id.0);
            fallback
        } else {
            snapshot.plan.processing_order.clone()
        };
        for &node_idx in &processing_order {
            let id = snapshot.dag.node(node_idx).id.0;
            if id == 0 {
                continue; // Master processed specifically after all nodes
            }

            let track_idx = (id - 1) as usize;
            if track_idx >= track_slots_len {
                continue;
            }

            let (left_slots, right_slots) = render_ctx.track_slots.split_at_mut(track_idx);
            let Some((slot, right_slots_rest)) = right_slots.split_first_mut() else {
                continue;
            };

            let is_group = ctx.post_sum_mask.get(track_idx).copied().unwrap_or(false);

            // ── VST INSTRUMENT FIX ─────────────────────────────────────
            // Check if this track has a VST instrument (external plugin in
            // the FX map that is NOT a native internal effect). If so,
            // schedule MIDI events and mark the track as active so VST
            // instruments produce audio during export.
            let has_vst_instrument = ctx
                .external_fx_map
                .get(track_idx)
                .map(|slots| {
                    slots
                        .iter()
                        .any(|s| s.instance_id.is_some() && s.internal_slot_index.is_none())
                })
                .unwrap_or(false);
            let has_midi = ctx
                .midi_clips_per_track
                .get(track_idx)
                .map(|clips| !clips.is_empty())
                .unwrap_or(false);

            // Schedule MIDI events for VST instrument tracks
            // CRACKLE-FIX-5: Reuse pre-allocated MIDI events Vec instead of
            // allocating a new Vec per track per chunk.
            ctx.bounce_midi_events.clear();
            if has_midi {
                if has_vst_instrument {
                    // Activate the slot so it's not skipped
                    slot.active = true;
                }

                let midi_clips = &ctx.midi_clips_per_track[track_idx];
                let mut midi_schedule: Vec<ScheduledNote> = Vec::new();
                let mut midi_tmp: Vec<ScheduledNote> = Vec::new();

                MidiScheduler::fill_active_looped_with_tmp(
                    midi_clips,
                    playhead_pos,
                    frame_count,
                    ctx.loop_region.as_ref(),
                    &mut midi_schedule,
                    &mut midi_tmp,
                );

                // PARITY FIX 3: Build MIDI FX config from project track data
                // and apply pitch/scale/velocity/random transforms — matching
                // the live path at audio_thread_runner.rs:674-766.
                let mut fx = ctx.midi_fx_configs.get(track_idx)
                    .cloned()
                    .unwrap_or_default();
                
                crate::driver::automation::apply_midi_fx_automation_block(
                    &mut fx,
                    ctx.automation.get(track_idx),
                    playhead_pos,
                );

                let mut rng_state: u32 = 0xDEAD_BEEF_u32.wrapping_add(track_idx as u32);

                for event in &midi_schedule {
                    let offset_on = event.buffer_onset as i32;
                    let offset_off = event.buffer_offset_end as i32;

                    if event.is_note_off {
                        let mut off_pitch_i16 = event.pitch as i16;
                        if fx.pitch_enabled {
                            off_pitch_i16 += fx.pitch_semitones as i16;
                        }
                        let mut off_pitch = clamp_midi_pitch(off_pitch_i16);
                        if fx.scale_enabled {
                            off_pitch = quantize_to_scale(off_pitch, fx.scale_root, fx.scale_mask);
                        }
                        ctx.bounce_midi_events.push(MidiEvent::note_off(offset_off, 0, off_pitch, 0));
                    }

                    if event.is_note_on {
                        let mut pitch_i16 = event.pitch as i16;
                        let mut velocity_i16 = event.velocity as i16;

                        if fx.pitch_enabled {
                            pitch_i16 += fx.pitch_semitones as i16;
                        }
                        let mut mapped_pitch = clamp_midi_pitch(pitch_i16);

                        if fx.scale_enabled {
                            mapped_pitch = quantize_to_scale(
                                mapped_pitch, fx.scale_root, fx.scale_mask,
                            );
                        }

                        if fx.random_enabled && fx.random_semitones != 0 {
                            // Deterministic xorshift for offline — same seed per track
                            rng_state ^= rng_state << 13;
                            rng_state ^= rng_state >> 17;
                            rng_state ^= rng_state << 5;
                            let rnd01 = (rng_state as f32) / (u32::MAX as f32);
                            if rnd01 <= fx.random_chance.clamp(0.0, 1.0) {
                                let span = fx.random_semitones.abs().max(1) as i16;
                                let signed = ((rng_state >> 8) % ((span as u32) * 2 + 1)) as i16 - span;
                                mapped_pitch = clamp_midi_pitch(mapped_pitch as i16 + signed);
                            }
                        }

                        if fx.velocity_enabled {
                            velocity_i16 = ((velocity_i16 as f32) * fx.velocity_gain)
                                .round() as i16
                                + fx.velocity_offset as i16;
                        }
                        let mapped_velocity = velocity_i16.clamp(1, 127) as u8;

                        ctx.bounce_midi_events.push(MidiEvent::note_on(
                            offset_on, 0, mapped_pitch, mapped_velocity,
                        ));
                    }
                }

                ctx.bounce_midi_events.sort_unstable_by(|a, b| {
                    a.sample_offset
                        .cmp(&b.sample_offset)
                        .then_with(|| a.data[0].cmp(&b.data[0]))
                });
            }

            // Audio leaves must have spawned audio. Groups might accumulate audio.
            // VST instrument tracks are activated above when they have MIDI clips.
            if !slot.active && !is_group {
                continue;
            }

            // 1. Unified FX Chain (Native + VST3)
            let fx_ctx = FxChainProcessCtx {
                sample_rate,
                time_sig_numerator: ctx.time_sig_numerator,
                time_sig_denominator: ctx.time_sig_denominator,
                plugin_registry: ctx.plugin_registry,
                external_fx_map: ctx.external_fx_map,
                bpm: ctx.bpm,
                playhead_pos,
                left_slots,
                right_slots: right_slots_rest,
                midi_events: ctx.bounce_midi_events,
                automation: ctx.automation,
                track_idx,
            };
            Self::process_track_fx_chain(
                slot,
                track_idx,
                frame_count,
                &fx_ctx,
                ctx.bounce_scratch_left,
                ctx.bounce_scratch_right,
            );

            // Post-FX RMS is captured in the per-buffer digest below (Phase 3.5)

            // PDC-7 FIX / SIDECHAIN-CORRUPTION FIX:
            // Calculate PDC delay for the routing destination, but DO NOT apply it
            // in-place here. Applying it here corrupts the raw `slot.buf` which
            // downstream tracks use for sidechains. We only delay it when summing.
            let dest_node_idx = ctx.routing.get(track_idx)
                .and_then(|r| *r)
                .map(|parent_idx| {
                    snapshot.dag.graph().node_indices()
                        .find(|ni| snapshot.dag.node(*ni).id.0 == (parent_idx as u64) + 1)
                })
                .unwrap_or_else(|| {
                    snapshot.dag.graph().node_indices()
                        .find(|ni| snapshot.dag.node(*ni).id.0 == 0)
                });
            let pdc_delay_frames = if let Some(dest_ni) = dest_node_idx {
                snapshot.plan.edge_delay_compensation.iter()
                    .find(|e| e.from == node_idx && e.to == dest_ni)
                    .map(|e| e.delay_samples)
                    .unwrap_or(0)
            } else { 0 };

            // 2. Channel Strip (Mute, Solo, Gain, Pan)
            let enabled = slot.strip.is_output_enabled();
            
            if enabled {
                slot.strip.process_stereo(
                    &mut slot.buf_left[..frame_count],
                    &mut slot.buf_right[..frame_count],
                );
            } else {
                slot.buf_left[..frame_count].fill(0.0);
                slot.buf_right[..frame_count].fill(0.0);
            }
            


            // BOUNCE-AUTOMATION-FIX: Apply track mixer automation (volume/pan
            // automation curves) — mirrors RT path at audio_thread_runner.rs:838.
            // Without this, automated volume fades and pan sweeps are completely
            // ignored during export, producing different audio from playback.
            if let Some(lane) = ctx.automation.get(track_idx) {
                apply_track_mixer_automation_sample_accurate(
                    &mut slot.buf_left[..frame_count],
                    &mut slot.buf_right[..frame_count],
                    playhead_pos,
                    (!lane.volume.is_empty()).then_some(lane.volume.as_slice()),
                    (!lane.pan.is_empty()).then_some(lane.pan.as_slice()),
                );
            }

            // 3. Route Output to Parent Group (if any) or Master Bus
            if enabled {
                if let Some(parent_idx) = ctx.routing.get(track_idx).and_then(|r| *r) {
                    if parent_idx < track_slots_len
                        && ctx.post_sum_mask.get(parent_idx).copied().unwrap_or(false)
                    {
                        let c = frame_count;
                        if track_idx == parent_idx {
                            static SELF_ROUTE_COUNT: std::sync::atomic::AtomicU32 =
                                std::sync::atomic::AtomicU32::new(0);
                            SELF_ROUTE_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            continue;
                        }

                        let (src_slot, parent_slot) = if track_idx < parent_idx {
                            let (left, right) = render_ctx.track_slots.split_at_mut(parent_idx);
                            (&left[track_idx], &mut right[0])
                        } else {
                            let (left, right) = render_ctx.track_slots.split_at_mut(track_idx);
                            (&right[0], &mut left[parent_idx])
                        };

                        if pdc_delay_frames > 0 {
                            let delay_buf = &mut ctx.pdc_buffers[track_idx];
                            if delay_buf.len() != pdc_delay_frames as usize {
                                delay_buf.resize(pdc_delay_frames as usize);
                            }
                            ctx.bounce_scratch_left[..c].copy_from_slice(&src_slot.buf_left[..c]);
                            ctx.bounce_scratch_right[..c].copy_from_slice(&src_slot.buf_right[..c]);
                            delay_buf.process_stereo(
                                &mut ctx.bounce_scratch_left[..c],
                                &mut ctx.bounce_scratch_right[..c],
                            );
                            for i in 0..c {
                                parent_slot.buf_left[i] += ctx.bounce_scratch_left[i];
                                parent_slot.buf_right[i] += ctx.bounce_scratch_right[i];
                            }
                        } else {
                            for i in 0..c {
                                parent_slot.buf_left[i] += src_slot.buf_left[i];
                                parent_slot.buf_right[i] += src_slot.buf_right[i];
                            }
                        }
                        parent_slot.active = true;
                    }
                } else {
                    if pdc_delay_frames > 0 {
                        let delay_buf = &mut ctx.pdc_buffers[track_idx];
                        if delay_buf.len() != pdc_delay_frames as usize {
                            delay_buf.resize(pdc_delay_frames as usize);
                        }
                        ctx.bounce_scratch_left[..frame_count].copy_from_slice(&slot.buf_left[..frame_count]);
                        ctx.bounce_scratch_right[..frame_count].copy_from_slice(&slot.buf_right[..frame_count]);
                        delay_buf.process_stereo(
                            &mut ctx.bounce_scratch_left[..frame_count],
                            &mut ctx.bounce_scratch_right[..frame_count],
                        );
                        render_ctx.master_bus.add_stereo(
                            &ctx.bounce_scratch_left[..frame_count],
                            &ctx.bounce_scratch_right[..frame_count],
                        );
                    } else {
                        render_ctx.master_bus.add_stereo(
                            &slot.buf_left[..frame_count],
                            &slot.buf_right[..frame_count],
                        );
                    }
                }
            }
        }

        // ── ULTIMATE DIAGNOSTIC: Comprehensive per-buffer all-track dump ──
        // Every 50 buffers (covering ~0.58s at 512 frames/44100Hz), log
        // COMPLETE signal state for ALL tracks. No limits — runs for entire export.
        // Shows post-strip RMS, enabled, active, device chain length.
        // This single diagnostic replaces all scattered [Bounce-RMS] and [Bounce-DIGEST].
        {
            static UBUF_COUNT: std::sync::atomic::AtomicU32 =
                std::sync::atomic::AtomicU32::new(0);
            let ubuf = UBUF_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            // Every 50 buffers for first 2000, then every 200 for the rest
            let should_dump = (ubuf < 2000 && ubuf.is_multiple_of(50)) || (ubuf >= 2000 && ubuf.is_multiple_of(200));
            if should_dump {
                let playhead_sec = playhead_pos as f64 / sample_rate;
                let mut summary_parts: Vec<String> = Vec::new();
                for ti in 0..track_slots_len.min(render_ctx.track_slots.len()) {
                    let ts = &render_ctx.track_slots[ti];
                    let rms: f32 = (ts.buf_left[..frame_count].iter()
                        .chain(ts.buf_right[..frame_count].iter())
                        .map(|s| s * s).sum::<f32>() / (2.0 * frame_count as f32).max(1.0)).sqrt();
                    let en = ts.strip.is_output_enabled();
                    let ac = ts.active;
                    let cl = ts.device_chain.len();
                    // Always show track if: has audio, is disabled (anomaly), or is key track
                    if rms > 0.0001 || !en || ti <= 3 || ti == 9 || ti == 10 {
                        summary_parts.push(format!(
                            "T[{}]:rms={:.4},en={},ac={},fx={}",
                            ti, rms, en as u8, ac as u8, cl
                        ));
                    }
                }
                // Master bus
                let (ml, mr) = render_ctx.master_bus.left_right_mut();
                let mrms: f32 = (ml[..frame_count].iter()
                    .chain(mr[..frame_count].iter())
                    .map(|s| s * s).sum::<f32>() / (2.0 * frame_count as f32).max(1.0)).sqrt();
                log::debug!(
                    "[Bounce-ALL] buf#{} t={:.2}s MASTER={:.4} | {}",
                    ubuf, playhead_sec, mrms,
                    summary_parts.join(" | ")
                );
            }
        }
        // This mirrors the real-time driver's combined internal/external master FX loop.
        let master_fx_idx = render_ctx.track_slots.len();
        let master_slots_opt =
            crate::driver::resolve_master_runtime_slots(ctx.external_fx_map, master_fx_idx);

        if let Some(master_slots) = master_slots_opt {
            if !master_slots.is_empty() {
                let has_external = master_slots.iter().any(|s| s.instance_id.is_some());
                if !has_external {
                    let (master_l, master_r) = render_ctx.master_bus.left_right_mut();
                    let pctx = ProcessContext {
                        sample_rate: render_ctx.sample_rate as f32,
                        playhead_frames: render_ctx.playhead.position(),
                        tempo: ctx.bpm,
                        is_playing: true,
                        time_sig_numerator: ctx.time_sig_numerator,
                        time_sig_denominator: ctx.time_sig_denominator,
                    };
                    ctx.master_device_chain.process_with_context(
                        &mut master_l[..frame_count],
                        &mut master_r[..frame_count],
                        &pctx,
                    );
                } else {
                    for runtime_slot in master_slots.iter() {
                        // BYPASS-FIX: Skip bypassed master bus slots.
                        if runtime_slot.is_bypassed {
                            continue;
                        }
                        if let Some(internal_idx) = runtime_slot.internal_slot_index {
                            let (master_l, master_r) = render_ctx.master_bus.left_right_mut();
                            let pctx = ProcessContext {
                                sample_rate: render_ctx.sample_rate as f32,
                                playhead_frames: render_ctx.playhead.position(),
                                tempo: ctx.bpm,
                                is_playing: true,
                                time_sig_numerator: ctx.time_sig_numerator,
                                time_sig_denominator: ctx.time_sig_denominator,
                            };
                            ctx.master_device_chain.process_slot_with_sidechain_ctx(
                                internal_idx,
                                &mut master_l[..frame_count],
                                &mut master_r[..frame_count],
                                None,
                                None,
                                &pctx,
                            );
                            continue;
                        }

                        if let Some(instance_id) = runtime_slot.instance_id {
                            let Some(plugin_mtx) = ctx.plugin_registry.get(&instance_id) else {
                                log::warn!(
                                    "[Bounce/Master] VST3 instance {} not in registry — skipping",
                                    instance_id
                                );
                                continue;
                            };
                            // EXPORT-DISTORTION-FIX: Direct blocking lock is safe — the RT
                            // thread skips all VST try_lock() calls when export_active=true,
                            // so no contention exists. The previous cooperative try_lock()+
                            // sleep(1ms) loop introduced timing jitter in the render.
                            let mut host = plugin_mtx.lock();
                            let (master_l, master_r) = render_ctx.master_bus.left_right_mut();
                            let main_inputs: [&[f32]; 2] =
                                [&master_l[..frame_count], &master_r[..frame_count]];
                            let transport = dream_plugins::TransportContext {
                                sample_rate: render_ctx.sample_rate,
                                position_samples: render_ctx.playhead.position(),
                                tempo: ctx.bpm,
                                is_playing: true,
                                is_recording: false,
                                time_sig_numerator: i32::from(ctx.time_sig_numerator),
                                time_sig_denominator: i32::from(ctx.time_sig_denominator),
                                cycle_active: false,
                                loop_start_samples: 0,
                                loop_end_samples: 0,
                            };
                            host.set_transport_context(transport);

                            // BOUNCE-AUTOMATION-FIX: Apply master bus external plugin
                            // parameter automation during export — mirrors per-track.
                            // Master bus slots use master_fx_idx as the automation index.
                            // Since master automation is not yet stored per-slot,
                            // we skip this for now (master rarely has param automation).
                            // TODO: When master automation lanes are added, wire them here.

                            // ENTERPRISE FIX: Use pre-allocated scratch buffers instead of
                            // per-chunk Vec allocation. Eliminates heap thrashing.
                            let ext_left = &mut ctx.bounce_scratch_left[..frame_count];
                            let ext_right = &mut ctx.bounce_scratch_right[..frame_count];
                            ext_left.fill(0.0);
                            ext_right.fill(0.0);
                            let mut out_slices: [&mut [f32]; 2] =
                                [&mut ext_left[..], &mut ext_right[..]];
                            let empty_midi: &[dream_plugins::MidiEvent] = &[];
                            // BOUNCE-FIX: Log process errors instead of silently swallowing.
                            if let Err(proc_err) = host.process_with_sidechain(
                                &main_inputs,
                                None,
                                &mut out_slices,
                                frame_count,
                                empty_midi,
                            ) {
                                log::warn!(
                                    "[Bounce/Master] process_with_sidechain failed: {}",
                                    proc_err
                                );
                            }
                            // BOUNCE-FIX: Sanitize plugin output — NaN/Inf would corrupt export.
                            for i in 0..frame_count {
                                if !ext_left[i].is_finite() {
                                    ext_left[i] = 0.0;
                                }
                                if !ext_right[i].is_finite() {
                                    ext_right[i] = 0.0;
                                }
                            }
                            master_l[..frame_count].copy_from_slice(&ext_left[..frame_count]);
                            master_r[..frame_count].copy_from_slice(&ext_right[..frame_count]);
                        }
                    }
                }
            } else if !ctx.master_device_chain.is_empty() {
                let (master_l, master_r) = render_ctx.master_bus.left_right_mut();
                let pctx = ProcessContext {
                    sample_rate: render_ctx.sample_rate as f32,
                    playhead_frames: render_ctx.playhead.position(),
                    tempo: ctx.bpm,
                    is_playing: true,
                    time_sig_numerator: ctx.time_sig_numerator,
                    time_sig_denominator: ctx.time_sig_denominator,
                };
                ctx.master_device_chain.process_with_context(
                    &mut master_l[..frame_count],
                    &mut master_r[..frame_count],
                    &pctx,
                );
            }
        } else if !ctx.master_device_chain.is_empty() {
            let (master_l, master_r) = render_ctx.master_bus.left_right_mut();
            let pctx = ProcessContext {
                sample_rate: render_ctx.sample_rate as f32,
                playhead_frames: render_ctx.playhead.position(),
                tempo: ctx.bpm,
                is_playing: true,
                time_sig_numerator: ctx.time_sig_numerator,
                time_sig_denominator: ctx.time_sig_denominator,
            };
            ctx.master_device_chain.process_with_context(
                &mut master_l[..frame_count],
                &mut master_r[..frame_count],
                &pctx,
            );
        }

        // Phase 5: Interleave master bus into output (no clipping here).
        // Final soft clipping is applied once at the end of bounce.
        let master_l = &render_ctx.master_bus.left()[..frame_count];
        let master_r = &render_ctx.master_bus.right()[..frame_count];
        if channels == 2 {
            for i in 0..frame_count {
                let base = i * 2;
                if base + 1 < output.len() {
                    output[base] = master_l[i];
                    output[base + 1] = master_r[i];
                }
            }
        } else if channels == 1 {
            // BUG-078 FIX: Mix stereo to mono, preventing sample overlap corruption.
            for i in 0..frame_count {
                let mono = (master_l[i] + master_r[i]) * std::f32::consts::FRAC_1_SQRT_2;
                if i < output.len() {
                    output[i] = mono;
                }
            }
        } else {
            for i in 0..frame_count {
                let base = i * channels;
                if base + 1 < output.len() {
                    output[base] = master_l[i];
                    output[base + 1] = master_r[i];
                    for ch in 2..channels {
                        let idx = base + ch;
                        if idx < output.len() {
                            output[idx] = 0.0;
                        }
                    }
                }
            }
        }
    }

    // ── MIDI Pre-Rendering ────────────────────────────────────────────
    //
    // Pre-renders MIDI tracks through the built-in SamplerEngine, producing
    // synthetic AudioClip data that the existing render pipeline mixes normally.
    //
    // This replicates the core of driver.rs:2102-2277 in an offline context:
    //   1. MidiScheduler::fill_active() → schedule events per buffer
    //   2. Sort events, dispatch note_on/note_off to SamplerEngine
    //   3. SamplerEngine::render() → produce audio samples
    //   4. Accumulate into L/R buffers → wrap as ClipAudio + AudioClip
    //
    // Limitations:
    //   - Only built-in sampler/synth instruments. External VST3 not available.
    //   - MIDI FX (pitch shift, scale quantize, random) not applied offline.

    /// Pre-renders all MIDI tracks with built-in sampler instruments.
    ///
    /// For each track that has MIDI clips AND a SamplerConfig, this method:
    /// 1. Creates a SamplerEngine configured from the track's SamplerConfig
    /// 2. Loads the sample from the ClipPool (or uses oscillator mode)
    /// 3. Iterates buffer-by-buffer, scheduling MIDI events and rendering audio
    /// 4. Creates a synthetic AudioClip from the rendered audio
    /// 5. Adds the AudioClip to the project and registers the ClipAudio in the pool
    ///
    /// Returns the number of tracks that were pre-rendered.
    fn pre_render_midi_tracks(&self, project: &mut Project, clip_pool: &mut ClipPool) -> Result<usize, BounceError> {
        let sample_rate = self.config.project_sample_rate.max(1.0);
        let start_frame = self.config.start_frame;
        let end_frame = self.config.end_frame;
        let total_frames = (end_frame - start_frame).max(0) as usize;

        if total_frames == 0 {
            return Ok(0);
        }

        let mut rendered_count = 0usize;

        // Iterate by index so we can mutate project.tracks[i] later.
        for track_idx in 0..project.tracks.len() {
            let track = &project.tracks[track_idx];

            // Skip tracks without MIDI clips.
            if track.midi_clips.is_empty() {
                continue;
            }

            // Skip tracks without a built-in instrument.
            let sampler_cfg = track.sampler.clone();
            let rack_cfg = track.sample_rack.clone();

            if sampler_cfg.is_none() && rack_cfg.is_none() {
                log::warn!(
                    "[Bounce/MIDI] Track '{}' has {} MIDI clips but no built-in instrument — skipping.",
                    track.name,
                    track.midi_clips.len()
                );
                continue;
            }

            // ── Configure SamplerEngine ──────────────────────────
            let mut engine = SamplerEngine::new(sample_rate);
            let mut rack = SampleRackEngine::new(sample_rate);
            let mut essence = EssenceSynthEngine::new(sample_rate);
            let mut flow = FlowSynthEngine::new(sample_rate);
            let mut has_sample = false;

            if let Some(cfg) = &sampler_cfg {
                engine.set_root_note(cfg.root_note);
                engine.volume = cfg.volume.clamp(0.0, 2.0) as f32;
                engine.set_adsr(AdsrParams {
                    attack: cfg.attack,
                    decay: cfg.decay,
                    sustain: cfg.sustain,
                    release: cfg.release,
                });

                if cfg.has_sample() {
                    if let Some(clip_audio) = clip_pool.get(&cfg.sample_path) {
                        engine.set_sample(clip_audio);
                        has_sample = true;
                    } else {
                        log::warn!(
                            "[Bounce/MIDI] Track '{}': sample '{}' not in pool — skipping.",
                            track.name,
                            cfg.sample_path
                        );
                    }
                }

                // Configure EssenceSynthEngine from the same SamplerConfig
                essence.set_adsr(AdsrParams {
                    attack: cfg.attack,
                    decay: cfg.decay,
                    sustain: cfg.sustain,
                    release: cfg.release,
                });
                essence.set_volume(cfg.volume.clamp(0.0, 2.0) as f32);
                essence.set_filter_cutoff(cfg.filter_cutoff as f32);
                essence.set_filter_resonance(cfg.filter_resonance as f32);
                essence.set_filter_type(cfg.filter_type);
                essence.set_lfo_rate(cfg.lfo_rate as f32);
                essence.set_lfo_depth(cfg.lfo_depth as f32);
                essence.set_lfo_target(cfg.lfo_target);
                essence.set_detune_cents(cfg.detune_cents as f32);
                essence.set_sub_level(cfg.sub_level as f32);
                essence.set_pulse_width(cfg.pulse_width as f32);
            }

            if let Some(cfg) = &rack_cfg {
                for (i, pad_cfg) in cfg.pads.iter().enumerate() {
                    if let Some(pad) = rack.pad_mut(i) {
                        pad.volume = if pad_cfg.is_disabled {
                            0.0
                        } else {
                            pad_cfg.volume.clamp(0.0, 2.0) as f32
                        };
                        pad.set_adsr(AdsrParams {
                            attack: pad_cfg.attack,
                            decay: pad_cfg.decay,
                            sustain: pad_cfg.sustain,
                            release: pad_cfg.release,
                        });

                        if !pad_cfg.sample_path.is_empty()
                            && let Some(clip_audio) = clip_pool.get(&pad_cfg.sample_path)
                        {
                            pad.set_sample(clip_audio);
                        }
                    }
                }
                let any_pad_soloed = cfg.pads.iter().any(|p| p.is_soloed);
                if any_pad_soloed {
                    for (i, pad_cfg) in cfg.pads.iter().enumerate() {
                        if !pad_cfg.is_soloed
                            && let Some(pad) = rack.pad_mut(i)
                        {
                            pad.volume = 0.0;
                        }
                    }
                }
            }

            // ── Pre-render buffer by buffer ──────────────────────
            let midi_clips = track.midi_clips.clone();
            let track_name = track.name.clone();
            let total_midi_notes: usize = midi_clips.iter().map(|c| c.notes.len()).sum();

            info!(
                "[Bounce/MIDI] Pre-rendering track '{}': {} clips, {} notes, {} frames",
                track_name,
                midi_clips.len(),
                total_midi_notes,
                total_frames
            );

            // Allocate output buffers for the full render range.
            let mut out_left = vec![0.0f32; total_frames];
            let mut out_right = vec![0.0f32; total_frames];

            // Scratch buffers for per-chunk rendering.
            let mut chunk_left = vec![0.0f32; OFFLINE_BUFFER_FRAMES];
            let mut chunk_right = vec![0.0f32; OFFLINE_BUFFER_FRAMES];
            let mut schedule_scratch: Vec<dream_clip_engine::midi_scheduler::ScheduledNote> =
                Vec::new();

            let mut frames_done = 0usize;
            let mut playhead = start_frame;

            while frames_done < total_frames {
                if self.cancel_flag.load(Ordering::SeqCst) {
                    return Err(BounceError::RenderError(
                        "Bounce cancelled by user during MIDI pre-render".to_string(),
                    ));
                }

                let remaining = total_frames - frames_done;
                let chunk_frames = remaining.min(OFFLINE_BUFFER_FRAMES);

                // Clear chunk buffers.
                chunk_left[..chunk_frames].fill(0.0);
                chunk_right[..chunk_frames].fill(0.0);

                // Schedule MIDI events for this buffer window (no loop region for offline).
                MidiScheduler::fill_active(
                    &midi_clips,
                    playhead,
                    chunk_frames,
                    &mut schedule_scratch,
                );

                let mut rack_active = false;
                for p in 0..16 {
                    if let Some(pad) = rack.pad_mut(p)
                        && pad.has_active_voices()
                    {
                        rack_active = true;
                        break;
                    }
                }

                // ENTERPRISE: Gate essence_active based on instrument exclusion.
                // If the sampler has a loaded sample, suppress the Essence Synth.
                let use_essence = !has_sample;
                let essence_active_now = use_essence && essence.has_active_voices();
                let use_flow = flow.is_enabled();
                let flow_active_now = use_flow && flow.has_active_voices();
                if !schedule_scratch.is_empty() || engine.has_active_voices() || rack_active || essence_active_now || flow_active_now || use_flow {
                    // Convert scheduled notes to instantaneous events (same logic as driver.rs).
                    let mut events: Vec<(usize, u8, u8, u8)> = Vec::new(); // (frame, kind, pitch, velocity)
                    for event in &schedule_scratch {
                        if event.is_note_off {
                            events.push((
                                event.buffer_offset_end.min(chunk_frames),
                                0, // Note Off
                                event.pitch,
                                event.velocity,
                            ));
                        }
                        if event.is_note_on {
                            events.push((
                                event.buffer_onset.min(chunk_frames),
                                1, // Note On
                                event.pitch,
                                event.velocity,
                            ));
                        }
                    }
                    events.sort_by(|a, b| {
                        a.0.cmp(&b.0)
                            .then_with(|| a.1.cmp(&b.1))
                            .then_with(|| a.2.cmp(&b.2))
                    });

                    // Render segments between events.
                    let mut cursor = 0usize;
                    for &(frame, kind, pitch, velocity) in &events {
                        let seg = frame.saturating_sub(cursor).min(chunk_frames - cursor);
                        if seg > 0 {
                            if engine.has_active_voices() {
                                engine.render(
                                    &mut chunk_left[cursor..cursor + seg],
                                    &mut chunk_right[cursor..cursor + seg],
                                    seg,
                                );
                            }
                            rack.render(
                                &mut chunk_left[cursor..cursor + seg],
                                &mut chunk_right[cursor..cursor + seg],
                                seg,
                            );
                            if use_essence && essence.has_active_voices() {
                                essence.render(
                                    &mut chunk_left[cursor..cursor + seg],
                                    &mut chunk_right[cursor..cursor + seg],
                                    seg,
                                );
                            }
                            if use_flow {
                                flow.render(
                                    &mut chunk_left[cursor..cursor + seg],
                                    &mut chunk_right[cursor..cursor + seg],
                                    seg,
                                );
                            }
                            cursor += seg;
                        } else if frame > cursor {
                            cursor = frame;
                        }

                        if kind == 0 {
                            engine.note_off(pitch);
                            rack.note_off(pitch);
                            if use_essence {
                                essence.note_off(pitch);
                            }
                            if use_flow {
                                flow.note_off(pitch);
                            }
                        } else {
                            engine.note_on(pitch, velocity);
                            rack.note_on(pitch, velocity);
                            if use_essence {
                                essence.note_on(pitch, velocity);
                            }
                            if use_flow {
                                flow.note_on(pitch, velocity);
                            }
                        }
                    }

                    // Render tail after last event.
                    if cursor < chunk_frames {
                        let rem = chunk_frames - cursor;
                        if engine.has_active_voices() {
                            engine.render(
                                &mut chunk_left[cursor..cursor + rem],
                                &mut chunk_right[cursor..cursor + rem],
                                rem,
                            );
                        }
                        rack.render(
                            &mut chunk_left[cursor..cursor + rem],
                            &mut chunk_right[cursor..cursor + rem],
                            rem,
                        );
                        if use_essence && essence.has_active_voices() {
                            essence.render(
                                &mut chunk_left[cursor..cursor + rem],
                                &mut chunk_right[cursor..cursor + rem],
                                rem,
                            );
                        }
                        if use_flow {
                            flow.render(
                                &mut chunk_left[cursor..cursor + rem],
                                &mut chunk_right[cursor..cursor + rem],
                                rem,
                            );
                        }
                    }
                }

                // Copy chunk into output buffers.
                out_left[frames_done..frames_done + chunk_frames]
                    .copy_from_slice(&chunk_left[..chunk_frames]);
                out_right[frames_done..frames_done + chunk_frames]
                    .copy_from_slice(&chunk_right[..chunk_frames]);

                frames_done += chunk_frames;
                playhead += chunk_frames as i64;
            }

            // ── Check if anything was actually rendered ──────────
            let peak = out_left
                .iter()
                .chain(out_right.iter())
                .fold(0.0f32, |acc, &s| acc.max(s.abs()));

            if peak < 1e-7 {
                log::warn!(
                    "[Bounce/MIDI] Track '{}': pre-render produced silence (peak={:.2e}). \
                     Possible causes: no sample loaded, notes outside render range, or zero velocity.",
                    track_name,
                    peak
                );
                continue;
            }

            info!(
                "[Bounce/MIDI] Track '{}': pre-render complete, peak={:.4}, {} frames",
                track_name, peak, total_frames
            );

            // ── Create synthetic ClipAudio + AudioClip ───────────
            let synth_path = format!("__midi_prerender__/track_{}", track_idx);
            let clip_audio = ClipAudio::new(
                synth_path.clone(),
                vec![out_left, out_right],
                sample_rate as u32,
            );
            clip_pool.insert(clip_audio).map_err(BounceError::RenderError)?;

            let synth_clip = AudioClip::new(
                format!("{} (MIDI Pre-render)", track_name),
                synth_path,
                AbsoluteTime::new(start_frame),
                AbsoluteTime::new(total_frames as i64),
            );

            project.tracks[track_idx].clips.push(synth_clip);
            rendered_count += 1;
        }

        Ok(rendered_count)
    }

    /// Creates a new bouncer with the given configuration.
    pub fn new(config: BounceConfig) -> Self {
        Self {
            config,
            cancel_flag: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Returns a clone of the cancel flag.
    /// Set to `true` from another thread to abort the bounce.
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel_flag)
    }

    /// Resets the cancel flag to false.
    pub fn reset_cancel(&self) {
        self.cancel_flag.store(false, Ordering::SeqCst);
    }

    fn create_render_ctx(
        &self,
        project: &Project,
        loop_region: Option<&ClipLoopRegion>,
        sample_rate: f64,
    ) -> RenderContext {
        let meter_bank = Arc::new(MeterBank::new(project.tracks.len().max(1)));
        let mut render_ctx = RenderContext::new(
            project.tracks.len().max(1),
            sample_rate,
            OFFLINE_CHANNELS,
            meter_bank,
        );

        // ── CRITICAL: Set timeline sample rate to project SR ────────
        // Clip positions and durations are stored in the project's SR
        // domain. Without this, the playhead advances at the export SR
        // rate, causing incorrect clip scheduling when project SR ≠
        // export SR. This mirrors what the real-time driver does via
        // EngineCommand::SetTimelineSampleRate(project.sample_rate).
        let project_sr = self.config.project_sample_rate;
        if project_sr > 0.0 && project_sr.is_finite() && (project_sr - sample_rate).abs() > 0.001 {
            render_ctx.set_timeline_sample_rate(project_sr);
            info!(
                "[Bounce] Timeline SR set to {:.0}Hz (export SR={:.0}Hz, ratio={:.4})",
                project_sr,
                sample_rate,
                project_sr / sample_rate
            );
        }

        let (routing, _) = Self::build_routing(project);
        Self::configure_render_ctx_track_mix_state(project, &mut render_ctx, &routing);

        // ── CRITICAL FIX: Populate per-track native device chains ────
        // Without this, all native FX (EQ, compressor, reverb, etc.) on
        // individual tracks are silently skipped during offline export.
        // The real-time driver populates these via EngineCommand::AddDevice,
        // but offline bounce must do it directly from the project data.
        for (track_idx, track) in project.tracks.iter().enumerate() {
            if track_idx < render_ctx.track_slots.len() {
                Self::populate_device_chain_from_effects(
                    &mut render_ctx.track_slots[track_idx].device_chain,
                    &track.effects,
                );
            }
        }

        render_ctx.loop_region = loop_region.cloned();
        render_ctx.playhead.seek(self.config.start_frame);
        render_ctx.playhead.set_advancing(true);
        // ENTERPRISE: Enable offline mode — removes RT-safety constraints
        // that degrade quality (e.g., Pro warp budget limit). Offline
        // rendering runs at max CPU speed, not constrained by audio deadline.
        render_ctx.offline_mode = true;
        render_ctx
    }

    /// Executes the offline bounce.
    ///
    /// This is a **blocking** operation — call from a background thread
    /// (e.g., `tokio::task::spawn_blocking` or `std::thread::spawn`).
    ///
    /// # Arguments
    /// - `project`: The project to bounce (provides track/clip data).
    /// - `clip_pool`: Pre-loaded audio data for all clips.
    /// - `loop_region`: Optional loop region for the bounce.
    /// - `progress_callback`: Called with progress 0.0–1.0.
    ///
    /// # Returns
    /// `Ok(())` on success. The WAV file is written to `config.output_path`.
    pub fn bounce<F>(
        &self,
        project: &mut Project,
        clip_pool: &mut ClipPool,
        loop_region: Option<&ClipLoopRegion>,
        plugin_registry: &HashMap<uuid::Uuid, PluginInstanceArc>,
        external_fx_map: &[Vec<ExternalPluginRuntimeSlot>],
        mut progress_callback: F,
    ) -> Result<(), BounceError>
    where
        F: FnMut(f32),
    {
        // ── Validate config ──────────────────────────────────────
        if self.config.end_frame <= self.config.start_frame {
            return Err(BounceError::InvalidConfig(
                "end_frame must be greater than start_frame".to_string(),
            ));
        }

        if self.config.bit_depth != 16 && self.config.bit_depth != 24 && self.config.bit_depth != 32
        {
            return Err(BounceError::InvalidConfig(format!(
                "Unsupported bit depth: {} (use 16, 24, or 32)",
                self.config.bit_depth
            )));
        }

        let project_sr = self.config.project_sample_rate.max(1.0);
        let export_sr = self.config.sample_rate as f64;
        let total_frames = self.config.total_frames() as usize;

        info!(
            "[Bounce] Starting: {} frames @ {}Hz (Engine: {:.0}Hz), {}-bit, output={}",
            total_frames,
            self.config.sample_rate,
            project_sr,
            self.config.bit_depth,
            self.config.output_path
        );

        // ── Diagnostic: clip inventory ──────────────────────────
        let total_audio_clips: usize = project.tracks.iter().map(|t| t.clips.len()).sum();
        let total_midi_clips: usize = project.tracks.iter().map(|t| t.midi_clips.len()).sum();

        if total_audio_clips == 0 && total_midi_clips == 0 {
            return Err(BounceError::InvalidConfig(
                "Project is empty — no audio or MIDI clips to export.".to_string(),
            ));
        }

        // Validate runtime VST bindings, but keep export best-effort:
        // mismatches can happen after import/reload and should not hard-block render.
        if let Err(err) = Self::validate_external_vst_runtime_bindings(project, external_fx_map) {
            log::warn!(
                "[Bounce] External runtime binding preflight failed; continuing best-effort render: {}",
                err
            );
        }

        // ── Pre-render MIDI tracks ──────────────────────────────
        if total_midi_clips > 0 {
            let midi_rendered = self.pre_render_midi_tracks(project, clip_pool)?;
            info!("[Bounce] Pre-rendered {} MIDI tracks", midi_rendered);
        }

        let clips_per_track: Vec<Vec<AudioClip>> = project
            .tracks
            .iter()
            .map(|track| track.clips.clone())
            .collect();
        // ── VST INSTRUMENT FIX: Collect MIDI clips for VST instrument rendering ──
        let midi_clips_per_track: Vec<Vec<MidiClip>> = project
            .tracks
            .iter()
            .map(|track| track.midi_clips.clone())
            .collect();
        let bounce_loop_region = loop_region
            .as_ref()
            .map(|lr| ClipLoopRegion::new(lr.start, lr.end));
        let (routing, post_sum_mask) = Self::build_routing(project);
        let is_mp3 = self.config.format.eq_ignore_ascii_case("mp3");
        let master_gain = project.master_track.volume.clamp(0.0, 2.0) as f32;

        let mut render_ctx = self.create_render_ctx(project, loop_region, project_sr);

        // ── Master DeviceChain: internal FX on master bus ──────────
        // Build from project.master_track.effects, matching the
        // real-time driver's rebuild_runtime_device_chains_from_project.
        // Uses populate_device_chain_from_effects to add devices AND sync params.
        let mut master_device_chain = DeviceChain::new(project_sr as f32);
        Self::populate_device_chain_from_effects(
            &mut master_device_chain,
            &project.master_track.effects,
        );

        // ── ENTERPRISE: Export parity diagnostics ──────────────────
        // Log per-track state at bounce start to help identify any
        // divergence between RT playback and offline export.
        // Uses warn! level to ensure visibility in terminal.
        log::info!(
            "[Bounce-Diag] Master: volume={:.3}, device_chain_slots={}, effects_count={}",
            project.master_track.volume,
            master_device_chain.len(),
            project.master_track.effects.len(),
        );
        for (track_idx, track) in project.tracks.iter().enumerate() {
            let chain_len = if track_idx < render_ctx.track_slots.len() {
                render_ctx.track_slots[track_idx].device_chain.len()
            } else {
                0
            };
            let ext_fx_count = external_fx_map
                .get(track_idx)
                .map(|slots| slots.len())
                .unwrap_or(0);
            let is_group = !track.child_track_ids.is_empty();
            // Also log sidechain sources for this track
            let sc_sources: Vec<String> = track.effects.iter().flat_map(|node| {
                node.collect_plugin_slots().into_iter().filter_map(|slot| {
                    slot.sidechain_source_track_id.as_ref().map(|sc_id| {
                        format!("slot='{}' sc_src={} bypassed={}", slot.name, sc_id, slot.is_bypassed)
                    })
                }).collect::<Vec<_>>()
            }).collect();
            let sc_info = if sc_sources.is_empty() {
                String::from("none")
            } else {
                sc_sources.join("; ")
            };
            
            // ── ENTERPRISE DIAGNOSTIC: Deep MIDI Clip Analysis ──
            if track_idx == 1 || track_idx == 2 || track_idx == 9 {
                let clips = &track.midi_clips;
                let mut bounds_str = Vec::new();
                for (c_idx, c) in clips.iter().enumerate() {
                    let start_sec = c.position.sample_frame as f64 / project_sr;
                    let end_sec = (c.position.sample_frame + c.duration.sample_frame) as f64 / project_sr;
                    bounds_str.push(format!("C{}[{:.2}s-{:.2}s, {} notes]", c_idx, start_sec, end_sec, c.notes.len()));
                }
                let loop_str = loop_region.as_ref().map(|lr| format!("[{:.2}s - {:.2}s]", lr.start as f64 / project_sr, lr.end as f64 / project_sr)).unwrap_or("DISABLED".to_string());
                log::debug!(
                    "[Bounce-Diag-MIDI] T[{}] '{}': loop={} bounds={} | export={:.2}s - {:.2}s",
                    track_idx, track.name, loop_str, bounds_str.join(","),
                    self.config.start_frame as f64 / project_sr, self.config.end_frame as f64 / project_sr
                );
            }

            log::debug!(
                "[Bounce-Diag] Track[{}] '{}': disabled={}, solo={}, vol={:.3}, pan={:.3}, \
                 internal_fx={}, external_fx_slots={}, is_group={}, \
                 audio_clips={}, midi_clips={}, sidechains=[{}]",
                track_idx,
                track.name,
                track.is_disabled,
                track.is_solo,
                track.volume,
                track.pan,
                chain_len,
                ext_fx_count,
                is_group,
                track.clips.len(),
                track.midi_clips.len(),
                sc_info,
            );
        }

        // ── ENTERPRISE: Log RUNTIME sidechain_track_index from external_fx_snapshot ──
        // This shows the actual resolved numeric indices used by the bounce render loop,
        // confirming whether ShaperBox/etc. receive the correct sidechain source buffer.
        for (ti, runtime_slots) in external_fx_map.iter().enumerate() {
            for (si, rs) in runtime_slots.iter().enumerate() {
                if rs.sidechain_track_index.is_some() || rs.instance_id.is_some() {
                    log::debug!(
                        "[Bounce-Diag] Runtime Track[{}] Slot[{}]: sc_track_idx={:?}, instance_id={:?}, internal_idx={:?}, bypassed={}, is_instrument={}",
                        ti, si, rs.sidechain_track_index, rs.instance_id, rs.internal_slot_index, rs.is_bypassed, rs.is_instrument
                    );
                }
            }
        }

        // BUF-M05 FIX: Allocate extra tail frames for reverb/delay decay.
        // Only add tail if there are master effects that could produce decay.
        // Without effects, tail is just silence — the user's reported "3 seconds
        // of empty space" at end of export was caused by this unnecessary tail.
        let has_any_master_fx = !master_device_chain.is_empty()
            || external_fx_map.get(render_ctx.track_slots.len())
                .map(|slots| slots.iter().any(|s| s.instance_id.is_some() && !s.is_bypassed))
                .unwrap_or(false);
        // Also check if any track has reverb/delay VSTs that could produce tail
        let has_any_track_reverb_vst = external_fx_map.iter().any(|slots| {
            slots.iter().any(|s| s.instance_id.is_some() && !s.is_bypassed)
        });
        let max_tail_frames = if self.config.include_tail && (has_any_master_fx || has_any_track_reverb_vst) {
            (project_sr as usize).min(192000) // 1 second max (auto-detected from FX)
        } else {
            0 // Tail disabled OR no effects = no tail
        };
        let total_with_tail = total_frames + max_tail_frames;
        log::info!(
            "[Bounce-Config] tail_frames={} ({:.2}s), master_fx={}, track_vst={}, total_frames={}, export_range=[{}..{}]",
            max_tail_frames, max_tail_frames as f64 / project_sr,
            has_any_master_fx, has_any_track_reverb_vst,
            total_frames, self.config.start_frame, self.config.end_frame
        );

        // EXP-PDC FIX: Compute track latencies for PDC during export
        let track_slots_len = render_ctx.track_slots.len();
        let mut track_latencies = Vec::with_capacity(track_slots_len);
        for track_idx in 0..track_slots_len {
            let track_latency = if let Some(slots) = external_fx_map.get(track_idx) {
                slots
                    .iter()
                    .filter(|slot| !slot.is_bypassed)
                    .filter_map(|slot| slot.instance_id)
                    .map(|instance_id| {
                        plugin_registry
                            .get(&instance_id)
                            .and_then(|arc| arc.try_lock())
                            .map(|p| p.latency_samples())
                            .unwrap_or(0)
                    })
                    .sum::<u32>()
            } else {
                0
            };
            track_latencies.push(track_latency);
        }
        let max_tracking_delay = track_latencies.iter().copied().max().unwrap_or(0);
        let mut pdc_buffers: Vec<DelayBuffer> = (0..track_slots_len)
            .map(|_| DelayBuffer::new())
            .collect();

        // Single-pass render into contiguous RAM at Project SR
        let mut mix_l = vec![0.0f32; total_with_tail];
        let mut mix_r = vec![0.0f32; total_with_tail];
        let mut interleaved_buf = vec![0.0f32; OFFLINE_BUFFER_FRAMES * OFFLINE_CHANNELS];
        // CRACKLE-FIX-4: Pre-allocate VST output scratch buffers outside the
        // render loop. Previously, `vec![0.0; c]` was allocated per-slot per-chunk,
        // causing heap thrashing during offline rendering.
        let mut bounce_scratch_left = vec![0.0f32; OFFLINE_BUFFER_FRAMES];
        let mut bounce_scratch_right = vec![0.0f32; OFFLINE_BUFFER_FRAMES];
        // CRACKLE-FIX-5: Pre-allocate MIDI events Vec outside the loop.
        let mut bounce_midi_events: Vec<MidiEvent> = Vec::with_capacity(4096);

        info!("[Bounce] Phase 1: Rendering Master Mix");

        let mut frames_rendered = 0usize;
        let mut last_progress = -1.0f32;
        let sidechains = Self::build_sidechains(project);

        // PARITY FIX 3: Build per-track MIDI FX configs from project data.
        // This mirrors the RT driver's rebuild_midi_snapshot_from_project()
        // so offline export applies the same pitch/scale/velocity/random
        // transforms as live playback.
        let midi_fx_configs: Vec<MidiFxRuntimeConfig> = project
            .tracks
            .iter()
            .map(Self::build_midi_fx_config_from_track)
            .collect();

        // BOUNCE-AUTOMATION-FIX: Build per-track external plugin automation
        // from project model. This mirrors the RT driver's
        // rebuild_automation_snapshot_from_project() so offline export applies
        // the same plugin parameter automation as live playback.
        let bounce_automation: Vec<TrackAutomationState> = project
            .tracks
            .iter()
            .map(|track| {
                let mut state = TrackAutomationState::default();
                for lane in &track.automation_lanes {
                    let key = lane.param_id.to_lowercase();
                    let mut points: Vec<AutomationPoint> = lane
                        .points
                        .iter()
                        .map(|p| AutomationPoint {
                            sample_frame: project.pulse_map.sample_frame(p.beat.max(0.0)),
                            value: p.value as f32,
                        })
                        .collect();
                    points.sort_by_key(|p| p.sample_frame);

                    // BOUNCE-AUTOMATION-FIX: Parse volume/pan automation in
                    // addition to external plugin params. Without this, track
                    // volume/pan curves are applied only via static strip gain
                    // and animated curves are completely ignored during export.
                    let is_pan = matches!(key.as_str(), "pan" | "track.pan" | "mixer.pan");
                    let is_vol = matches!(
                        key.as_str(),
                        "volume" | "gain" | "track.volume" | "track.gain" | "mixer.gain"
                    );
                    if is_pan {
                        for p in &mut points {
                            p.value = p.value.clamp(-1.0, 1.0);
                        }
                        state.pan = points;
                    } else if is_vol {
                        for p in &mut points {
                            p.value = p.value.clamp(0.0, 2.0);
                        }
                        state.volume = points;
                    } else if let Some(target) = parse_external_param_target(&lane.param_id) {
                        state.external_plugin_params.push(ExternalParamAutomationLane {
                            target,
                            points,
                        });
                    }
                }
                state
            })
            .collect();

        // ── PDC-8 FIX: Pre-Roll Phase ──────────────────────────────────
        // PDC delay lines are freshly allocated (all zeros). Without pre-roll,
        // the first `max_tracking_delay` frames of the export would have wrong
        // timing on PDC-delayed tracks — they output silence until the delay
        // line fills up. The RT path doesn't have this issue because its delay
        // lines are continuously filled during playback.
        //
        // Solution: Seek the playhead backward by max_tracking_delay, render
        // those extra frames through the full pipeline (priming all delay
        // buffers with valid audio), then discard the output.
        if max_tracking_delay > 0 {
            let preroll_frames = max_tracking_delay as usize;
            let preroll_start = (self.config.start_frame - preroll_frames as i64).max(0);
            let actual_preroll = (self.config.start_frame - preroll_start) as usize;

            if actual_preroll > 0 {
                render_ctx.playhead.seek(preroll_start);
                let mut preroll_rendered = 0usize;
                let mut preroll_interleaved = vec![0.0f32; OFFLINE_BUFFER_FRAMES * OFFLINE_CHANNELS];

                info!(
                    "[Bounce] PDC pre-roll: rendering {} frames from position {} to prime delay lines",
                    actual_preroll, preroll_start
                );

                while preroll_rendered < actual_preroll {
                    let chunk = (actual_preroll - preroll_rendered).min(OFFLINE_BUFFER_FRAMES);
                    let chunk_samples = chunk * OFFLINE_CHANNELS;
                    preroll_interleaved[..chunk_samples].fill(0.0);

                    let mut preroll_routing_ctx = RenderRoutingCtx {
                        clips_per_track: &clips_per_track,
                        clip_pool,
                        routing: &routing,
                        sidechains: &sidechains,
                        post_sum_mask: &post_sum_mask,
                        track_latencies: &track_latencies,
                        max_tracking_delay,
                        pdc_buffers: &mut pdc_buffers,
                        plugin_registry,
                        external_fx_map,
                        bpm: self.config.bpm,
                        time_sig_numerator: project.time_signature.numerator.max(1),
                        time_sig_denominator: project.time_signature.denominator.max(1),
                        master_device_chain: &mut master_device_chain,
                        midi_clips_per_track: &midi_clips_per_track,
                        loop_region: bounce_loop_region,
                        midi_fx_configs: &midi_fx_configs,
                        automation: &bounce_automation,
                        bounce_scratch_left: &mut bounce_scratch_left,
                        bounce_scratch_right: &mut bounce_scratch_right,
                        bounce_midi_events: &mut bounce_midi_events,
                    };
                    Self::render_routing_aware(
                        &mut render_ctx,
                        &mut preroll_interleaved[..chunk_samples],
                        &mut preroll_routing_ctx,
                    );
                    // Discard output — we only care about priming PDC delay buffers
                    preroll_rendered += chunk;
                }

                info!("[Bounce] PDC pre-roll complete: {} frames processed", preroll_rendered);
            }
        }

        while frames_rendered < total_frames {
            if self.cancel_flag.load(Ordering::SeqCst) {
                return Err(BounceError::RenderError(
                    "Bounce cancelled by user".to_string(),
                ));
            }

            let chunk_frames = (total_frames - frames_rendered).min(OFFLINE_BUFFER_FRAMES);
            let chunk_samples = chunk_frames * OFFLINE_CHANNELS;
            interleaved_buf[..chunk_samples].fill(0.0);

            let mut routing_ctx = RenderRoutingCtx {
                clips_per_track: &clips_per_track,
                clip_pool,
                routing: &routing,
                sidechains: &sidechains,
                post_sum_mask: &post_sum_mask,
                track_latencies: &track_latencies,
                max_tracking_delay,
                pdc_buffers: &mut pdc_buffers,
                plugin_registry,
                external_fx_map,
                bpm: self.config.bpm,
                time_sig_numerator: project.time_signature.numerator.max(1),
                time_sig_denominator: project.time_signature.denominator.max(1),
                master_device_chain: &mut master_device_chain,
                midi_clips_per_track: &midi_clips_per_track,
                loop_region: bounce_loop_region,
                midi_fx_configs: &midi_fx_configs,
                automation: &bounce_automation,
                bounce_scratch_left: &mut bounce_scratch_left,
                bounce_scratch_right: &mut bounce_scratch_right,
                bounce_midi_events: &mut bounce_midi_events,
            };
            Self::render_routing_aware(
                &mut render_ctx,
                &mut interleaved_buf[..chunk_samples],
                &mut routing_ctx,
            );

            let mut out_idx = 0;
            for i in 0..chunk_frames {
                mix_l[frames_rendered + i] = interleaved_buf[out_idx];
                mix_r[frames_rendered + i] = interleaved_buf[out_idx + 1];
                out_idx += OFFLINE_CHANNELS;
            }

            frames_rendered += chunk_frames;
            let progress = (frames_rendered as f32 / total_frames as f32) * 0.7; // First 70% is rendering
            if progress - last_progress >= 0.01 {
                progress_callback(progress.min(1.0));
                last_progress = progress;
            }
        }

        // BUF-M05 FIX: Render tail frames to capture reverb/delay decay.
        // Continue processing with silence input until tail is either exhausted
        // or output falls below -96dB (silence threshold).
        let mut tail_rendered = 0usize;
        let silence_threshold: f32 = 1e-5; // ~-100dB
        while tail_rendered < max_tail_frames {
            if self.cancel_flag.load(Ordering::SeqCst) {
                break;
            }
            let chunk_frames = (max_tail_frames - tail_rendered).min(OFFLINE_BUFFER_FRAMES);
            let chunk_samples = chunk_frames * OFFLINE_CHANNELS;
            interleaved_buf[..chunk_samples].fill(0.0);

            // Process master FX chain on silence to generate tail output
            let process_ctx_tail = dream_dsp::device_slot::ProcessContext {
                sample_rate: project_sr as f32,
                playhead_frames: self.config.end_frame + tail_rendered as i64,
                tempo: self.config.bpm,
                is_playing: false,
                time_sig_numerator: project.time_signature.numerator.max(1),
                time_sig_denominator: project.time_signature.denominator.max(1),
            };
            let _ = process_ctx_tail; // Silence warning if unused below

            // EXP-003 FIX: Process full master FX chain (internal + VST3) during
            // tail rendering, mirroring Phase 4.5 of render_routing_aware().
            // Previously only internal FX (DeviceChain) were processed, causing
            // VST3 reverbs/limiters/compressors on the master bus to cut off.
            let tail_start = total_frames + tail_rendered;
            let tail_end = (tail_start + chunk_frames).min(total_with_tail);
            let actual = tail_end - tail_start;
            if actual == 0 { break; }

            // Use mix_l/mix_r directly (already zeroed) to avoid allocation
            let tail_slice_l = &mut mix_l[tail_start..tail_end];
            let tail_slice_r = &mut mix_r[tail_start..tail_end];

            let master_fx_idx = render_ctx.track_slots.len();
            let master_slots_opt =
                crate::driver::resolve_master_runtime_slots(external_fx_map, master_fx_idx);

            if let Some(master_slots) = master_slots_opt {
                if !master_slots.is_empty() {
                    let has_external = master_slots.iter().any(|s| s.instance_id.is_some());
                    if !has_external {
                        // Internal-only master chain
                        let pctx = ProcessContext {
                            sample_rate: project_sr as f32,
                            playhead_frames: self.config.end_frame + tail_rendered as i64,
                            tempo: self.config.bpm,
                            is_playing: false,
                            time_sig_numerator: project.time_signature.numerator.max(1),
                            time_sig_denominator: project.time_signature.denominator.max(1),
                        };
                        master_device_chain.process_with_context(
                            tail_slice_l,
                            tail_slice_r,
                            &pctx,
                        );
                    } else {
                        // Interleaved internal + external VST3 master chain
                        for runtime_slot in master_slots.iter() {
                            if runtime_slot.is_bypassed {
                                continue;
                            }
                            if let Some(internal_idx) = runtime_slot.internal_slot_index {
                                let pctx = ProcessContext {
                                    sample_rate: project_sr as f32,
                                    playhead_frames: self.config.end_frame + tail_rendered as i64,
                                    tempo: self.config.bpm,
                                    is_playing: false,
                                    time_sig_numerator: project.time_signature.numerator.max(1),
                                    time_sig_denominator: project.time_signature.denominator.max(1),
                                };
                                master_device_chain.process_slot_with_sidechain_ctx(
                                    internal_idx,
                                    tail_slice_l,
                                    tail_slice_r,
                                    None,
                                    None,
                                    &pctx,
                                );
                                continue;
                            }

                            if let Some(instance_id) = runtime_slot.instance_id {
                                let Some(plugin_mtx) = plugin_registry.get(&instance_id) else {
                                    continue;
                                };
                                // EXPORT-DISTORTION-FIX: Direct blocking lock is safe — the RT
                                // thread skips all VST try_lock() calls when export_active=true,
                                // so no contention exists. The previous cooperative try_lock() +
                                // sleep(1ms) loop introduced timing jitter in the render.
                                let mut host = plugin_mtx.lock();
                                let main_inputs: [&[f32]; 2] =
                                    [&tail_slice_l[..actual], &tail_slice_r[..actual]];
                                let transport = dream_plugins::TransportContext {
                                    sample_rate: project_sr,
                                    position_samples: self.config.end_frame + tail_rendered as i64,
                                    tempo: self.config.bpm,
                                    is_playing: false,
                                    is_recording: false,
                                    time_sig_numerator: i32::from(project.time_signature.numerator.max(1)),
                                    time_sig_denominator: i32::from(project.time_signature.denominator.max(1)),
                                    cycle_active: false,
                                    loop_start_samples: 0,
                                    loop_end_samples: 0,
                                };
                                host.set_transport_context(transport);

                                let ext_left = &mut bounce_scratch_left[..actual];
                                let ext_right = &mut bounce_scratch_right[..actual];
                                ext_left.fill(0.0);
                                ext_right.fill(0.0);
                                let mut out_slices: [&mut [f32]; 2] =
                                    [&mut ext_left[..], &mut ext_right[..]];
                                let empty_midi: &[dream_plugins::MidiEvent] = &[];
                                if let Err(proc_err) = host.process_with_sidechain(
                                    &main_inputs,
                                    None,
                                    &mut out_slices,
                                    actual,
                                    empty_midi,
                                ) {
                                    log::warn!(
                                        "[Bounce/Tail/Master] process_with_sidechain failed: {}",
                                        proc_err
                                    );
                                }
                                // Sanitize plugin output
                                for i in 0..actual {
                                    if !ext_left[i].is_finite() {
                                        ext_left[i] = 0.0;
                                    }
                                    if !ext_right[i].is_finite() {
                                        ext_right[i] = 0.0;
                                    }
                                }
                                tail_slice_l[..actual].copy_from_slice(&ext_left[..actual]);
                                tail_slice_r[..actual].copy_from_slice(&ext_right[..actual]);
                            }
                        }
                    }
                } else if !master_device_chain.is_empty() {
                    master_device_chain.process_stereo(
                        tail_slice_l,
                        tail_slice_r,
                        project_sr as f32,
                    );
                }
            } else if !master_device_chain.is_empty() {
                master_device_chain.process_stereo(
                    tail_slice_l,
                    tail_slice_r,
                    project_sr as f32,
                );
            }

            // Check if tail is still audible
            let peak_l: f32 = tail_slice_l.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
            let peak_r: f32 = tail_slice_r.iter().map(|s| s.abs()).fold(0.0f32, f32::max);

            if peak_l < silence_threshold && peak_r < silence_threshold {
                break; // Tail has decayed to silence
            }

            tail_rendered += chunk_frames;
        }

        // Update effective total with actual tail length
        let total_frames = total_frames + tail_rendered;

        // ── ULTIMATE END-OF-BOUNCE SUMMARY ──
        // Single log line with everything needed to verify the export
        {
            let final_peak_l: f32 = mix_l[..total_frames].iter().map(|s| s.abs()).fold(0.0f32, f32::max);
            let final_peak_r: f32 = mix_r[..total_frames].iter().map(|s| s.abs()).fold(0.0f32, f32::max);
            let final_rms_l: f32 = (mix_l[..total_frames].iter().map(|s| s * s).sum::<f32>() / total_frames as f32).sqrt();
            let final_rms_r: f32 = (mix_r[..total_frames].iter().map(|s| s * s).sum::<f32>() / total_frames as f32).sqrt();
            // Scan for silence at the end — find last non-silent frame
            let silence_th = 1e-5f32;
            let last_audible = mix_l[..total_frames].iter()
                .zip(mix_r[..total_frames].iter())
                .rposition(|(l, r)| l.abs() > silence_th || r.abs() > silence_th)
                .unwrap_or(0);
            let trailing_silence_frames = total_frames.saturating_sub(last_audible + 1);
            let trailing_silence_sec = trailing_silence_frames as f64 / project_sr;
            log::info!(
                "[Bounce-FINAL] total_frames={} ({:.2}s), tail_frames={} ({:.2}s), \
                 master_gain={:.3}, peak_L={:.5} peak_R={:.5}, rms_L={:.5} rms_R={:.5}, \
                 trailing_silence={} frames ({:.2}s), last_audible_frame={}",
                total_frames, total_frames as f64 / project_sr,
                tail_rendered, tail_rendered as f64 / project_sr,
                master_gain,
                final_peak_l, final_peak_r, final_rms_l, final_rms_r,
                trailing_silence_frames, trailing_silence_sec, last_audible
            );
        }

        info!("[Bounce] Phase 2: Gain / Normalization");
        let mut peak = 0.0f32;
        if self.config.normalize {
            for i in 0..total_frames {
                peak = peak
                    .max((mix_l[i] * master_gain).abs())
                    .max((mix_r[i] * master_gain).abs());
            }
        }

        let mut total_gain = master_gain;
        if self.config.normalize && peak > 0.0 && peak != 1.0 {
            total_gain *= 1.0 / peak;
            info!(
                "[Bounce] Normalizing: peak={:.4}, gain={:.4}dB",
                peak,
                20.0 * (1.0 / peak).log10()
            );
        }

        if total_gain != 1.0 {
            for i in 0..total_frames {
                mix_l[i] *= total_gain;
                mix_r[i] *= total_gain;
            }
        }

        progress_callback(0.75);

        // Resample only at the very end
        let (mut final_l, mut final_r) = if (project_sr - export_sr).abs() > 0.001 {
            info!(
                "[Bounce] Phase 3: Resampling from {:.0}Hz to {:.0}Hz",
                project_sr, export_sr
            );
            let resampled = dream_dsp::resampler::resample_channels(
                &[mix_l, mix_r],
                project_sr as usize,
                export_sr as usize,
            )
            .map_err(|e| BounceError::RenderError(format!("Resample failed: {}", e)))?;
            (resampled[0].clone(), resampled[1].clone())
        } else {
            (mix_l, mix_r)
        };

        // Final output limiter pass: apply soft clipping once at the end of
        // the offline pipeline (mirrors realtime final output safety stage).
        for (l, r) in final_l.iter_mut().zip(final_r.iter_mut()) {
            *l = soft_clip(*l);
            *r = soft_clip(*r);
        }

        progress_callback(0.85);
        info!("[Bounce] Phase 4: Writing File");

        let export_frames = final_l.len();

        if is_mp3 {
            let mut mp3_writer =
                Mp3Writer::create_streaming(&self.config.output_path, self.config.sample_rate)
                    .map_err(|e| BounceError::WriteError(e.to_string()))?;
            let chunk_size = 4096;
            let mut w_pos = 0;
            while w_pos < export_frames {
                let chunk = (export_frames - w_pos).min(chunk_size);
                mp3_writer
                    .write_chunk(
                        &final_l[w_pos..w_pos + chunk],
                        &final_r[w_pos..w_pos + chunk],
                    )
                    .map_err(|e| BounceError::WriteError(e.to_string()))?;
                w_pos += chunk;

                let progress = 0.85 + 0.15 * (w_pos as f32 / export_frames as f32);
                if progress - last_progress >= 0.01 {
                    progress_callback(progress.min(1.0));
                    last_progress = progress;
                }
            }
            mp3_writer
                .finalize()
                .map_err(|e| BounceError::WriteError(e.to_string()))?;
        } else {
            let mut wav_writer = WavWriter::create(
                &self.config.output_path,
                self.config.sample_rate,
                self.config.bit_depth,
            )?;
            
            let chunk_size = 8192;
            let mut w_pos = 0;
            while w_pos < export_frames {
                let chunk = (export_frames - w_pos).min(chunk_size);
                wav_writer.write_chunk(
                    &final_l[w_pos..w_pos + chunk],
                    &final_r[w_pos..w_pos + chunk],
                )?;
                w_pos += chunk;

                let progress = 0.85 + 0.15 * (w_pos as f32 / export_frames as f32);
                if progress - last_progress >= 0.01 {
                    progress_callback(progress.min(1.0));
                    last_progress = progress;
                }
            }
            wav_writer.finalize()?;
        }

        progress_callback(1.0);
        info!(
            "[Bounce] Complete: {} [{}] ({:.1}s @ {}Hz)",
            self.config.output_path,
            self.config.format,
            export_frames as f64 / export_sr,
            self.config.sample_rate
        );

        Ok(())
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests;
