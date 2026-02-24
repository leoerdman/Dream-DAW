// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Offline Bounce (Mix Export Engine)
// ═══════════════════════════════════════════════════════════════════════════
//
// THE PROBLEM:
//   A DAW without mix export is just a player. Users need to bounce
//   their project to a WAV file for distribution, mastering, or archival.
//
// THE SOLUTION: OfflineBouncer
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

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use uuid::Uuid;
pub use crate::offline_bounce_types::{BounceConfig, BounceError};

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
use dream_dsp::dsp_processor::BuiltinEffectType;

use crate::driver::ExternalFxRuntimeSlot;
use crate::driver::midi_dispatcher::clamp_midi_pitch;
use crate::render_callback::{RenderContext, soft_clip};
use crate::sampler::{AdsrParams, SampleRackEngine, SamplerEngine, Waveform};

// ── Constants ──────────────────────────────────────────────────────────

/// Buffer size for offline rendering (larger = fewer loop iterations).
/// Not constrained by real-time deadlines, so we can use big buffers.
const OFFLINE_BUFFER_FRAMES: usize = 4096;

/// Maximum output channels (stereo).
const OFFLINE_CHANNELS: usize = 2;

struct FxChainProcessCtx<'a> {
    sample_rate: f64,
    time_sig_numerator: u8,
    time_sig_denominator: u8,
    plugin_registry: &'a HashMap<uuid::Uuid, PluginInstanceArc>,
    external_fx_map: &'a [Vec<ExternalFxRuntimeSlot>],
    bpm: f64,
    playhead_pos: i64,
    left_slots: &'a [crate::render_callback::TrackSlot],
    right_slots: &'a [crate::render_callback::TrackSlot],
    /// MIDI events for the current track's VST instrument processing.
    midi_events: &'a [MidiEvent],
}

struct RenderRoutingCtx<'a> {
    clips_per_track: &'a [Vec<AudioClip>],
    clip_pool: &'a ClipPool,
    routing: &'a [Option<usize>],
    sidechains: &'a [Vec<Option<usize>>],
    post_sum_mask: &'a [bool],
    plugin_registry: &'a HashMap<uuid::Uuid, PluginInstanceArc>,
    external_fx_map: &'a [Vec<ExternalFxRuntimeSlot>],
    bpm: f64,
    time_sig_numerator: u8,
    time_sig_denominator: u8,
    master_device_chain: &'a mut DeviceChain,
    /// MIDI clips per track for VST instrument rendering.
    midi_clips_per_track: &'a [Vec<MidiClip>],
    /// Loop region for MIDI scheduling (if loop enabled).
    loop_region: Option<ClipLoopRegion>,
}

// ── Offline Bouncer ─────────────────────────────────────────────────────

/// The offline bounce engine.
///
/// Runs the entire render pipeline at maximum CPU speed (not tied to
/// the cpal audio callback) and writes the result to a WAV file.
///
/// # Usage
/// ```ignore
/// let bouncer = OfflineBouncer::new(config);
/// bouncer.bounce(&project, &clip_pool, |progress| {
///     println!("Bounce progress: {:.0}%", progress * 100.0);
/// })?;
/// ```
pub struct OfflineBouncer {
    config: BounceConfig,
    /// Cancellation flag - set to true to abort the bounce.
    /// The bouncer checks this flag during each render iteration.
    pub cancel_flag: Arc<AtomicBool>,
}

impl OfflineBouncer {
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
                if let Some(chain) = if has_solo {
                    rack.chains.iter().find(|c| c.is_solo && !c.is_mute)
                } else {
                    rack.chains.iter().find(|c| !c.is_mute)
                } {
                    for child in &chain.devices {
                        Self::collect_declared_external_slot_ids(child, rack_bypassed, out);
                    }
                }
            }
        }
    }

    fn validate_external_vst_runtime_bindings(
        project: &Project,
        external_fx_map: &[Vec<ExternalFxRuntimeSlot>],
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
            let runtime_external_slots: Vec<&ExternalFxRuntimeSlot> = external_fx_map
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
            let master_runtime_external_slots: Vec<&ExternalFxRuntimeSlot> = external_fx_map
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
                    if let Some(chain) = if has_solo {
                        rack.chains.iter().find(|c| c.is_solo && !c.is_mute)
                    } else {
                        rack.chains.iter().find(|c| !c.is_mute)
                    } {
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
                chain.add_device(slot_index, effect_type);
                if bypassed {
                    chain.set_bypass(slot_index, true);
                }
                // ── CRITICAL FIX: Sync runtime param values ──
                if let Some(ref params) = slot.params {
                    for (param_idx, &value) in params.iter().enumerate() {
                        chain.set_param(slot_index, param_idx as u8, value);
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
            is_explicit_mute[i] = track.effective_mute_from_model();
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
                let bypassed = parent_bypassed || slot.is_bypassed;
                if !bypassed && let Some(sidechain_id) = &slot.sidechain_source_track_id {
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
                let selected = if has_solo {
                    rack.chains.iter().find(|c| c.is_solo && !c.is_mute)
                } else {
                    rack.chains.iter().find(|c| !c.is_mute)
                };
                if let Some(chain) = selected {
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

    /// Processes the unified FX chain for a single track slot.
    ///
    /// Mirrors the RT driver's Insert processing logic:
    /// 1. If `external_fx_map[track_idx]` exists, iterate each `ExternalFxRuntimeSlot` in order.
    ///    - `internal_slot_index` → native FX: `device_chain.process_slot_with_sidechain()`
    ///    - `instance_id` → VST3: lock the `PluginInstanceArc`, set transport, call `process_with_sidechain()`
    /// 2. If no external FX map entry, fall back to `device_chain.process_stereo()`.
    fn process_track_fx_chain(
        slot: &mut crate::render_callback::TrackSlot,
        track_idx: usize,
        frame_count: usize,
        ctx: &FxChainProcessCtx<'_>,
    ) {
        let c = frame_count
            .min(slot.buf_left.len())
            .min(slot.buf_right.len());

        if let Some(runtime_slots) = ctx.external_fx_map.get(track_idx) {
            if !runtime_slots.is_empty() {
                for runtime_slot in runtime_slots {
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
                        slot.device_chain.process_slot_with_sidechain(
                            internal_idx,
                            &mut slot.buf_left[..c],
                            &mut slot.buf_right[..c],
                            sc_l,
                            sc_r,
                            ctx.sample_rate as f32,
                        );
                        continue;
                    }

                    // ── VST3 FX slot ──
                    if let Some(instance_id) = runtime_slot.instance_id {
                        if let Some(plugin_mtx) = ctx.plugin_registry.get(&instance_id) {
                            let mut host = plugin_mtx.lock();
                            let transport = TransportContext {
                                sample_rate: ctx.sample_rate,
                                position_samples: ctx.playhead_pos,
                                tempo: ctx.bpm,
                                is_playing: true,
                                is_recording: false,
                                time_sig_numerator: i32::from(ctx.time_sig_numerator),
                                time_sig_denominator: i32::from(ctx.time_sig_denominator),
                            };
                            host.set_transport_context(transport);

                            let mut out_left = vec![0.0f32; c];
                            let mut out_right = vec![0.0f32; c];
                            let main_inputs: [&[f32]; 2] =
                                [&slot.buf_left[..c], &slot.buf_right[..c]];
                            let mut out_slices: [&mut [f32]; 2] =
                                [&mut out_left[..c], &mut out_right[..c]];
                            let midi_to_send: &[MidiEvent] = ctx.midi_events;
                            let empty_midi: Vec<MidiEvent> = Vec::new();
                            let use_midi = if !midi_to_send.is_empty() {
                                midi_to_send
                            } else {
                                &empty_midi
                            };
                            let sc_pair =
                                source_slot.map(|src| [&src.buf_left[..c], &src.buf_right[..c]]);
                            let _ = host.process_with_sidechain(
                                &main_inputs,
                                sc_pair.as_ref().map(|pair| pair.as_slice()),
                                &mut out_slices,
                                c,
                                use_midi,
                            );
                            slot.buf_left[..c].copy_from_slice(&out_left[..c]);
                            slot.buf_right[..c].copy_from_slice(&out_right[..c]);
                        } else {
                            log::warn!(
                                "[Bounce/FX] Track {}: VST3 instance {} not in registry — skipping",
                                track_idx,
                                instance_id
                            );
                        }
                    }
                }
            } else if !slot.device_chain.is_empty() {
                slot.device_chain.process_stereo(
                    &mut slot.buf_left[..c],
                    &mut slot.buf_right[..c],
                    ctx.sample_rate as f32,
                );
            }
        } else if !slot.device_chain.is_empty() {
            slot.device_chain.process_stereo(
                &mut slot.buf_left[..c],
                &mut slot.buf_right[..c],
                ctx.sample_rate as f32,
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
        render_ctx.read_audio_clips_into_tracks(frame_count, ctx.clips_per_track, ctx.clip_pool);

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
            0,
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
            let mut track_midi_events: Vec<MidiEvent> = Vec::new();
            if has_vst_instrument && has_midi {
                // Activate the slot so it's not skipped
                slot.active = true;

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

                for event in &midi_schedule {
                    let offset_on = event.buffer_onset as i32;
                    let offset_off = event.buffer_offset_end as i32;

                    if event.is_note_off {
                        let off_pitch = clamp_midi_pitch(event.pitch as i16);
                        track_midi_events.push(MidiEvent::note_off(offset_off, 0, off_pitch, 0));
                    }

                    if event.is_note_on {
                        let on_pitch = clamp_midi_pitch(event.pitch as i16);
                        let vel = event.velocity;
                        track_midi_events.push(MidiEvent::note_on(offset_on, 0, on_pitch, vel));
                    }
                }

                track_midi_events.sort_unstable_by(|a, b| {
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
                midi_events: &track_midi_events,
            };
            Self::process_track_fx_chain(slot, track_idx, frame_count, &fx_ctx);

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

            // 3. Route Output to Parent Group (if any) or Master Bus
            if enabled {
                if let Some(parent_idx) = ctx.routing.get(track_idx).and_then(|r| *r) {
                    if parent_idx < track_slots_len
                        && ctx.post_sum_mask.get(parent_idx).copied().unwrap_or(false)
                    {
                        let c = frame_count
                            .min(slot.buf_left.len())
                            .min(slot.buf_right.len());
                        assert_ne!(track_idx, parent_idx, "Track cannot route to itself");

                        let (src_slot, parent_slot) = if track_idx < parent_idx {
                            let (left, right) = render_ctx.track_slots.split_at_mut(parent_idx);
                            (&left[track_idx], &mut right[0])
                        } else {
                            let (left, right) = render_ctx.track_slots.split_at_mut(track_idx);
                            (&right[0], &mut left[parent_idx])
                        };

                        for i in 0..c {
                            parent_slot.buf_left[i] += src_slot.buf_left[i];
                            parent_slot.buf_right[i] += src_slot.buf_right[i];
                        }
                        parent_slot.active = true;
                    }
                } else {
                    render_ctx.master_bus.add_stereo(
                        &slot.buf_left[..frame_count],
                        &slot.buf_right[..frame_count],
                    );
                }
            }
        }

        // Phase 4.5: Process master internal FX (EQ, compressor, etc.) + VSTs
        // This mirrors the real-time driver's combined internal/external master FX loop.
        let master_fx_idx = render_ctx.track_slots.len();
        let master_slots_opt =
            crate::driver::resolve_master_runtime_slots(ctx.external_fx_map, master_fx_idx);

        if let Some(master_slots) = master_slots_opt {
            if !master_slots.is_empty() {
                for runtime_slot in master_slots.iter() {
                    if let Some(internal_idx) = runtime_slot.internal_slot_index {
                        let (master_l, master_r) = render_ctx.master_bus.left_right_mut();
                        ctx.master_device_chain.process_slot_with_sidechain(
                            internal_idx,
                            &mut master_l[..frame_count],
                            &mut master_r[..frame_count],
                            None,
                            None,
                            render_ctx.sample_rate as f32,
                        );
                        continue;
                    }

                    if let Some(instance_id) = runtime_slot.instance_id
                        && let Some(plugin_mtx) = ctx.plugin_registry.get(&instance_id)
                    {
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
                        };
                        host.set_transport_context(transport);

                        let mut ext_left = vec![0.0f32; frame_count];
                        let mut ext_right = vec![0.0f32; frame_count];
                        let mut out_slices: [&mut [f32]; 2] =
                            [&mut ext_left[..frame_count], &mut ext_right[..frame_count]];
                        let empty_midi: &[dream_plugins::MidiEvent] = &[];
                        let _ = host.process_with_sidechain(
                            &main_inputs,
                            None,
                            &mut out_slices,
                            frame_count,
                            empty_midi,
                        );
                        master_l[..frame_count].copy_from_slice(&ext_left[..frame_count]);
                        master_r[..frame_count].copy_from_slice(&ext_right[..frame_count]);
                    }
                }
            } else if !ctx.master_device_chain.is_empty() {
                let (master_l, master_r) = render_ctx.master_bus.left_right_mut();
                ctx.master_device_chain.process_stereo(
                    &mut master_l[..frame_count],
                    &mut master_r[..frame_count],
                    render_ctx.sample_rate as f32,
                );
            }
        } else if !ctx.master_device_chain.is_empty() {
            let (master_l, master_r) = render_ctx.master_bus.left_right_mut();
            ctx.master_device_chain.process_stereo(
                &mut master_l[..frame_count],
                &mut master_r[..frame_count],
                render_ctx.sample_rate as f32,
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
    fn pre_render_midi_tracks(&self, project: &mut Project, clip_pool: &mut ClipPool) -> usize {
        let sample_rate = self.config.project_sample_rate.max(1.0);
        let start_frame = self.config.start_frame;
        let end_frame = self.config.end_frame;
        let total_frames = (end_frame - start_frame).max(0) as usize;

        if total_frames == 0 {
            return 0;
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

                if cfg.osc2_waveform > 0 {
                    engine.set_waveform(Waveform::Sine);
                    engine.set_waveform2(Waveform::from_u8(cfg.osc2_waveform));
                }
                // Legacy osc_mix → split into per-osc independent volumes
                let mix = cfg.osc_mix.clamp(0.0, 1.0) as f32;
                engine.set_osc1_volume(1.0 - mix);
                engine.set_osc2_volume(mix);
                engine.set_detune_cents(cfg.detune_cents as f32);
                engine.set_sub_level(cfg.sub_level as f32);

                engine.set_filter_cutoff(cfg.filter_cutoff as f32);
                engine.set_filter_resonance(cfg.filter_resonance as f32);
                engine.set_filter_type(cfg.filter_type);

                engine.set_lfo_rate(cfg.lfo_rate as f32);
                engine.set_lfo_depth(cfg.lfo_depth as f32);
                engine.set_lfo_target(cfg.lfo_target);
                engine.set_pulse_width(cfg.pulse_width as f32);

                if cfg.has_sample() {
                    if let Some(clip_audio) = clip_pool.get(&cfg.sample_path) {
                        engine.set_sample(clip_audio);
                        has_sample = true;
                    } else {
                        log::warn!(
                            "[Bounce/MIDI] Track '{}': sample '{}' not in pool — using oscillator mode.",
                            track.name,
                            cfg.sample_path
                        );
                    }
                }

                if !has_sample && cfg.osc2_waveform == 0 {
                    engine.set_waveform(Waveform::Sine);
                }
            }

            if let Some(cfg) = &rack_cfg {
                for (i, pad_cfg) in cfg.pads.iter().enumerate() {
                    if let Some(pad) = rack.pad_mut(i) {
                        pad.volume = if pad_cfg.is_muted {
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
                        pad.set_filter_cutoff(pad_cfg.filter_cutoff as f32);

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

                if !schedule_scratch.is_empty() || engine.has_active_voices() || rack_active {
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
                            cursor += seg;
                        } else if frame > cursor {
                            cursor = frame;
                        }

                        if kind == 0 {
                            engine.note_off(pitch);
                            rack.note_off(pitch);
                        } else {
                            engine.note_on(pitch, velocity);
                            rack.note_on(pitch, velocity);
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
            let _ = clip_pool.insert(clip_audio);

            let synth_clip = AudioClip::new(
                format!("{} (MIDI Pre-render)", track_name),
                synth_path,
                AbsoluteTime::new(start_frame),
                AbsoluteTime::new(total_frames as i64),
            );

            project.tracks[track_idx].clips.push(synth_clip);
            rendered_count += 1;
        }

        rendered_count
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
        external_fx_map: &[Vec<ExternalFxRuntimeSlot>],
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
            let midi_rendered = self.pre_render_midi_tracks(project, clip_pool);
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

        // Single-pass render into contiguous RAM at Project SR
        let mut mix_l = vec![0.0f32; total_frames];
        let mut mix_r = vec![0.0f32; total_frames];
        let mut interleaved_buf = vec![0.0f32; OFFLINE_BUFFER_FRAMES * OFFLINE_CHANNELS];

        info!("[Bounce] Phase 1: Rendering Master Mix");

        let mut frames_rendered = 0usize;
        let mut last_progress = -1.0f32;
        let sidechains = Self::build_sidechains(project);

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
                plugin_registry,
                external_fx_map,
                bpm: self.config.bpm,
                time_sig_numerator: project.time_signature.numerator.max(1),
                time_sig_denominator: project.time_signature.denominator.max(1),
                master_device_chain: &mut master_device_chain,
                midi_clips_per_track: &midi_clips_per_track,
                loop_region: bounce_loop_region,
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
            let spec = hound::WavSpec {
                channels: 2,
                sample_rate: self.config.sample_rate,
                bits_per_sample: self.config.bit_depth,
                sample_format: if self.config.bit_depth == 32 {
                    hound::SampleFormat::Float
                } else {
                    hound::SampleFormat::Int
                },
            };
            let mut wav_writer = hound::WavWriter::create(&self.config.output_path, spec)
                .map_err(|e| BounceError::WriteError(e.to_string()))?;

            let is_float = self.config.bit_depth == 32;
            let scaler = if self.config.bit_depth == 16 {
                32767.0
            } else if self.config.bit_depth == 24 {
                8388607.0
            } else {
                1.0
            };

            // HYPER-CORE: TPDF Dithering for integer quantization.
            // Adds ±1 LSB triangular-distributed noise before rounding,
            // converting truncation distortion into a flat, inaudible noise floor.
            // Critical for reverb tails and quiet passages at 16-bit.
            let mut ditherer = dream_dsp::dither::TpdfDitherer::new();

            for i in 0..export_frames {
                for ch in 0..2 {
                    let s = if ch == 0 { final_l[i] } else { final_r[i] };
                    if is_float {
                        wav_writer
                            .write_sample(s)
                            .map_err(|e| BounceError::WriteError(e.to_string()))?;
                    } else if self.config.bit_depth == 16 {
                        // TPDF dither: add ±1 LSB triangular noise before rounding.
                        let dithered = s * scaler + ditherer.next_tpdf();
                        let scaled = dithered.round().clamp(-32768.0, 32767.0) as i16;
                        wav_writer
                            .write_sample(scaled)
                            .map_err(|e| BounceError::WriteError(e.to_string()))?;
                    } else {
                        // 24-bit: hound writes the lower 24 bits of i32
                        let dithered = s * scaler + ditherer.next_tpdf();
                        let scaled = dithered.round().clamp(-8388608.0, 8388607.0) as i32;
                        wav_writer
                            .write_sample(scaled)
                            .map_err(|e| BounceError::WriteError(e.to_string()))?;
                    }
                }

                if i % 8192 == 0 {
                    let progress = 0.85 + 0.15 * (i as f32 / export_frames as f32);
                    if progress - last_progress >= 0.01 {
                        progress_callback(progress.min(1.0));
                        last_progress = progress;
                    }
                }
            }
            wav_writer
                .finalize()
                .map_err(|e| BounceError::WriteError(e.to_string()))?;
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
