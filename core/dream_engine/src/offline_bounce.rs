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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use log::info;

use dream_clip_engine::midi_scheduler::MidiScheduler;
use dream_clip_engine::pool::{ClipAudio, ClipPool};
use dream_clip_engine::scheduler::LoopRegion as ClipLoopRegion;
use dream_io::mp3_writer::Mp3Writer;
use dream_io::wav_writer::WavWriter;
use dream_ipc::metering::MeterBank;
use dream_models::project::{AudioClip, Project};
use dream_models::time::AbsoluteTime;

use crate::render_callback::{soft_clip, RenderContext};
use crate::sampler::{AdsrParams, SamplerEngine, SampleRackEngine, Waveform};

// ── Constants ──────────────────────────────────────────────────────────

/// Buffer size for offline rendering (larger = fewer loop iterations).
/// Not constrained by real-time deadlines, so we can use big buffers.
const OFFLINE_BUFFER_FRAMES: usize = 4096;

/// Maximum output channels (stereo).
const OFFLINE_CHANNELS: usize = 2;

// ── Bounce Configuration ────────────────────────────────────────────────

/// Configuration for an offline bounce operation.
#[derive(Debug, Clone)]
pub struct BounceConfig {
    /// Output file path (e.g., "/Users/user/Desktop/my_mix.wav").
    pub output_path: String,

    /// Sample rate for the output file (Hz).
    pub sample_rate: u32,

    /// Bit depth: 16, 24, or 32 (float). Ignored for MP3.
    pub bit_depth: u16,

    /// Start frame of the bounce region (0 = project start).
    /// NOTE: frames are in the **project** sample-rate domain.
    pub start_frame: i64,

    /// End frame of the bounce region (total project length).
    /// NOTE: frames are in the **project** sample-rate domain.
    pub end_frame: i64,

    /// Whether to normalize the output to 0 dBFS.
    pub normalize: bool,

    /// Whether to apply a tail (extra silence at end for reverb tails).
    /// Value in frames.
    pub tail_frames: i64,

    /// Output format: "wav" or "mp3". Defaults to "wav" if unset.
    pub format: String,

    /// The project's internal sample rate (Hz).
    /// Clip positions and durations are stored in this domain.
    /// Must be set so the offline render can correctly separate the
    /// timeline domain from the export sample rate — matching how the
    /// real-time driver uses `SetTimelineSampleRate`.
    pub project_sample_rate: f64,
}

impl BounceConfig {
    /// Total frames to render (including tail).
    /// BUG-FIX: Use saturating arithmetic to prevent i64 overflow when
    /// end_frame is very large and tail_frames is added.
    pub fn total_frames(&self) -> i64 {
        (self.end_frame - self.start_frame).saturating_add(self.tail_frames)
    }
}

// ── Bounce Error ───────────────────────────────────────────────────────

/// Errors during the bounce process.
#[derive(Debug)]
pub enum BounceError {
    /// Invalid configuration (e.g., end < start).
    InvalidConfig(String),

    /// WAV write failure.
    WriteError(String),

    /// Render failure.
    RenderError(String),
}

impl std::fmt::Display for BounceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfig(e) => write!(f, "Invalid bounce config: {e}"),
            Self::WriteError(e) => write!(f, "WAV write error: {e}"),
            Self::RenderError(e) => write!(f, "Render error: {e}"),
        }
    }
}

impl std::error::Error for BounceError {}

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
            is_explicit_mute[i] = track.is_mute;
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
            if !changed { break; }
        }

        // 2. Propagate UP: If child soloed → parent implicitly soloed (safe-solo)
        loop {
            let mut changed = false;
            for i in 0..num_tracks {
                if let Some(parent_idx) = routing[i] {
                    if effective_solo[i] && !effective_solo[parent_idx] {
                        effective_solo[parent_idx] = true;
                        changed = true;
                    }
                }
            }
            if !changed { break; }
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
        for (src_idx, dest) in routing.iter().enumerate() {
            if let Some(dest_idx) = dest {
                if *dest_idx < mask.len() {
                    mask[*dest_idx] = true;
                }
            }
        }

        (routing, mask)
    }

    /// Routing-aware render: replaces `RenderContext::render()` with
    /// DAG-ordered summing that correctly processes group/bus tracks.
    ///
    /// This replicates what `GraphRenderer::render()` does in the
    /// real-time driver, producing identical audio output.
    fn render_routing_aware(
        render_ctx: &mut RenderContext,
        output: &mut [f32],
        clips_per_track: &[Vec<AudioClip>],
        clip_pool: &ClipPool,
        routing: &[Option<usize>],
        post_sum_mask: &[bool],
    ) {
        let channels = render_ctx.channels.max(1);
        let frame_count = output.len() / channels;

        // Phase 1: Fill source track slots (skip strip for group tracks)
        render_ctx.render_tracks_with_post_sum_mask(
            frame_count,
            clips_per_track,
            clip_pool,
            Some(post_sum_mask),
            None, // No external VSTs in offline bounce — process full device chain
        );

        // Phase 2: Route source tracks into their group buses
        // For each source track that routes to a group, add its audio
        // into the group track's buffer.
        for (src_idx, dest) in routing.iter().enumerate() {
            if let Some(group_idx) = dest {
                if *group_idx >= render_ctx.track_slots.len()
                    || src_idx >= render_ctx.track_slots.len()
                {
                    continue;
                }

                // Only route if the source is enabled (not muted/solo-excluded)
                let src_enabled = render_ctx.track_slots[src_idx].strip.is_output_enabled();
                if !src_enabled {
                    continue;
                }

                // BUG-5 FIX: Use split-borrow instead of Vec copy to eliminate
                // per-buffer allocations. Sound because src_idx != *group_idx.
                let c = frame_count
                    .min(render_ctx.track_slots[src_idx].buf_left.len())
                    .min(render_ctx.track_slots[src_idx].buf_right.len());

                // Safe split-borrow: we need &track_slots[src_idx] read and
                // &mut track_slots[*group_idx] write simultaneously.
                assert_ne!(src_idx, *group_idx, "Track cannot route to itself");
                let (src_slot, group_slot) = if src_idx < *group_idx {
                    let (left, right) = render_ctx.track_slots.split_at_mut(*group_idx);
                    (&left[src_idx], &mut right[0])
                } else {
                    let (left, right) = render_ctx.track_slots.split_at_mut(src_idx);
                    (&right[0], &mut left[*group_idx])
                };

                for i in 0..c {
                    group_slot.buf_left[i] += src_slot.buf_left[i];
                    group_slot.buf_right[i] += src_slot.buf_right[i];
                }
                group_slot.active = true;
            }
        }

        // Phase 3: Process group/bus track strips (gain, pan)
        for (idx, is_group) in post_sum_mask.iter().enumerate() {
            if !*is_group || idx >= render_ctx.track_slots.len() {
                continue;
            }
            let slot = &mut render_ctx.track_slots[idx];
            if slot.strip.is_output_enabled() {
                slot.strip.process_stereo(
                    &mut slot.buf_left[..frame_count],
                    &mut slot.buf_right[..frame_count],
                );
            } else {
                // Group is muted or solo-excluded — zero its buffer
                slot.buf_left[..frame_count].fill(0.0);
                slot.buf_right[..frame_count].fill(0.0);
            }
        }

        // Phase 4: Sum all terminal tracks into master bus
        // A source track routed to a group does NOT contribute directly;
        // its audio already went through the group in Phase 2.
        render_ctx.master_bus.clear(frame_count);
        for (idx, slot) in render_ctx.track_slots.iter().enumerate() {
            if !slot.active {
                continue;
            }

            let is_routed_to_group = routing
                .get(idx)
                .map(|r| r.is_some())
                .unwrap_or(false);
            let is_group = post_sum_mask
                .get(idx)
                .copied()
                .unwrap_or(false);

            // Skip source tracks that route to a group (already summed in Phase 2)
            if is_routed_to_group && !is_group {
                continue;
            }

            // Only include enabled tracks in master sum
            if !slot.strip.is_output_enabled() && !is_group {
                continue;
            }

            render_ctx.master_bus.add_stereo(
                &slot.buf_left[..frame_count],
                &slot.buf_right[..frame_count],
            );
        }

        // Phase 5: Interleave master bus into output with soft clipping
        let master_l = &render_ctx.master_bus.left()[..frame_count];
        let master_r = &render_ctx.master_bus.right()[..frame_count];
        if channels == 2 {
            for i in 0..frame_count {
                let base = i * 2;
                if base + 1 < output.len() {
                    output[base] = soft_clip(master_l[i]);
                    output[base + 1] = soft_clip(master_r[i]);
                }
            }
        } else if channels == 1 {
            // BUG-078 FIX: Mix stereo to mono, preventing sample overlap corruption.
            for i in 0..frame_count {
                let mono = (master_l[i] + master_r[i]) * std::f32::consts::FRAC_1_SQRT_2;
                if i < output.len() {
                    output[i] = soft_clip(mono);
                }
            }
        } else {
            for i in 0..frame_count {
                let base = i * channels;
                if base + 1 < output.len() {
                    output[base] = soft_clip(master_l[i]);
                    output[base + 1] = soft_clip(master_r[i]);
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
    fn pre_render_midi_tracks(
        &self,
        project: &mut Project,
        clip_pool: &mut ClipPool,
    ) -> usize {
        let sample_rate = self.config.sample_rate as f64;
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
                    track.name, track.midi_clips.len()
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
                engine.set_osc_mix(cfg.osc_mix as f32);
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
                            track.name, cfg.sample_path
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
                        pad.volume = if pad_cfg.is_muted { 0.0 } else { pad_cfg.volume.clamp(0.0, 2.0) as f32 };
                        pad.set_adsr(AdsrParams {
                            attack: pad_cfg.attack,
                            decay: pad_cfg.decay,
                            sustain: pad_cfg.sustain,
                            release: pad_cfg.release,
                        });
                        pad.set_filter_cutoff(pad_cfg.filter_cutoff as f32);
                        
                        if !pad_cfg.sample_path.is_empty() {
                            if let Some(clip_audio) = clip_pool.get(&pad_cfg.sample_path) {
                                pad.set_sample(clip_audio);
                            }
                        }
                    }
                }
                let any_pad_soloed = cfg.pads.iter().any(|p| p.is_soloed);
                if any_pad_soloed {
                    for (i, pad_cfg) in cfg.pads.iter().enumerate() {
                        if !pad_cfg.is_soloed {
                            if let Some(pad) = rack.pad_mut(i) {
                                pad.volume = 0.0;
                            }
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
                track_name, midi_clips.len(), total_midi_notes, total_frames
            );

            // Allocate output buffers for the full render range.
            let mut out_left = vec![0.0f32; total_frames];
            let mut out_right = vec![0.0f32; total_frames];

            // Scratch buffers for per-chunk rendering.
            let mut chunk_left = vec![0.0f32; OFFLINE_BUFFER_FRAMES];
            let mut chunk_right = vec![0.0f32; OFFLINE_BUFFER_FRAMES];
            let mut schedule_scratch: Vec<dream_clip_engine::midi_scheduler::ScheduledNote> = Vec::new();

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
                    if let Some(pad) = rack.pad_mut(p) {
                        if pad.has_active_voices() {
                            rack_active = true;
                            break;
                        }
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
                    events.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)).then_with(|| a.2.cmp(&b.2)));

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
            let peak = out_left.iter().chain(out_right.iter())
                .fold(0.0f32, |acc, &s| acc.max(s.abs()));

            if peak < 1e-7 {
                log::warn!(
                    "[Bounce/MIDI] Track '{}': pre-render produced silence (peak={:.2e}). \
                     Possible causes: no sample loaded, notes outside render range, or zero velocity.",
                    track_name, peak
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
                self.config.sample_rate,
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
                project_sr, sample_rate, project_sr / sample_rate
            );
        }

        let (routing, _) = Self::build_routing(project);
        Self::configure_render_ctx_track_mix_state(project, &mut render_ctx, &routing);
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

        // ── CRITICAL: Convert total_frames to the export-rate domain ──
        // BounceConfig.total_frames() returns frames in the project sample rate
        // domain (since start_frame, end_frame, tail_frames are all in project SR).
        // But the render loop produces output frames at the EXPORT sample rate.
        // The playhead correctly advances by frame_count * (timeline_sr / sample_rate)
        // per render call, so the render loop counter must be in export-rate frames.
        // Without this conversion, exporting 44100Hz→48000Hz would be 8.2% too short.
        let project_total_frames = self.config.total_frames() as f64;
        let sample_rate = self.config.sample_rate as f64;
        let project_sr = self.config.project_sample_rate.max(1.0);
        let sr_ratio = sample_rate / project_sr;
        let total_frames = if (sr_ratio - 1.0).abs() > 0.001 {
            // Domain conversion: project frames → export frames
            let export_frames = (project_total_frames * sr_ratio).ceil() as usize;
            info!(
                "[Bounce] Frame domain conversion: {}(project@{:.0}Hz) → {}(export@{:.0}Hz), ratio={:.6}",
                project_total_frames as usize, project_sr, export_frames, sample_rate, sr_ratio
            );
            export_frames
        } else {
            project_total_frames as usize
        };

        info!(
            "[Bounce] Starting: {} frames @ {}Hz, {}-bit, output={}",
            total_frames, self.config.sample_rate, self.config.bit_depth, self.config.output_path
        );

        // ── Diagnostic: clip inventory ──────────────────────────
        let total_audio_clips: usize = project.tracks.iter().map(|t| t.clips.len()).sum();
        let total_midi_clips: usize = project.tracks.iter().map(|t| t.midi_clips.len()).sum();
        info!(
            "[Bounce] Clip inventory: {} audio clips, {} MIDI clips across {} tracks",
            total_audio_clips,
            total_midi_clips,
            project.tracks.len()
        );

        if total_audio_clips == 0 && total_midi_clips == 0 {
            return Err(BounceError::InvalidConfig(
                "Project is empty — no audio or MIDI clips to export.".to_string(),
            ));
        }

        // ── Pre-render MIDI tracks ──────────────────────────────
        if total_midi_clips > 0 {
            let midi_rendered = self.pre_render_midi_tracks(project, clip_pool);
            info!(
                "[Bounce] Pre-rendered {} MIDI tracks into audio clips",
                midi_rendered
            );
        }

        // ── Prepare per-track clip slices ────────────────────────
        // Build the same structure that driver.rs uses for RenderContext::render().
        // After MIDI pre-rendering, synthetic audio clips have been injected
        // into the project tracks, so they are included here automatically.
        let clips_per_track: Vec<Vec<AudioClip>> = project
            .tracks
            .iter()
            .map(|track| track.clips.clone())
            .collect();
        let (routing, post_sum_mask) = Self::build_routing(project);
        let is_mp3 = self.config.format.eq_ignore_ascii_case("mp3");
        let master_gain = project.master_track.volume.clamp(0.0, 2.0) as f32;

        // ── Diagnostic: pool coverage check ─────────────────────
        {
            let total_clip_refs: usize = clips_per_track.iter().map(|v| v.len()).sum();
            let mut pool_hits = 0usize;
            let mut pool_misses = 0usize;
            for clips in &clips_per_track {
                for clip in clips {
                    if clip.file_path.is_empty() {
                        continue;
                    }
                    if clip_pool.get(&clip.file_path).is_some() {
                        pool_hits += 1;
                    } else {
                        pool_misses += 1;
                        info!(
                            "[Bounce] POOL MISS: clip '{}' file_path='{}' — will be SILENT",
                            clip.name, clip.file_path
                        );
                    }
                }
            }
            info!(
                "[Bounce] Pool coverage: {}/{} clips loaded ({} misses), master_gain={:.3}, project_sr={:.0}",
                pool_hits, total_clip_refs, pool_misses, master_gain,
                self.config.project_sample_rate
            );
            if pool_misses > 0 && pool_hits == 0 {
                log::error!(
                    "[Bounce] ALL clips missing from pool — export will be 100% silent! \
                     Check that audio files are loaded before calling export."
                );
            }
        }

        if is_mp3 {
            // MP3 path: streaming encode to avoid full-render RAM growth.
            let mut render_ctx = self.create_render_ctx(project, loop_region, sample_rate);

            let mut interleaved_buf = vec![0.0f32; OFFLINE_BUFFER_FRAMES * OFFLINE_CHANNELS];
            let mut frames_rendered = 0usize;
            let mut last_progress = -1.0f32;

            let gain = if self.config.normalize {
                let mut peak = 0.0f32;
                while frames_rendered < total_frames {
                    if self.cancel_flag.load(Ordering::SeqCst) {
                        let _ = std::fs::remove_file(&self.config.output_path);
                        return Err(BounceError::RenderError(
                            "Bounce cancelled by user".to_string(),
                        ));
                    }

                    let remaining = total_frames - frames_rendered;
                    let chunk_frames = remaining.min(OFFLINE_BUFFER_FRAMES);
                    let chunk_samples = chunk_frames * OFFLINE_CHANNELS;
                    interleaved_buf[..chunk_samples].fill(0.0);

                    Self::render_routing_aware(
                        &mut render_ctx,
                        &mut interleaved_buf[..chunk_samples],
                        &clips_per_track,
                        clip_pool,
                        &routing,
                        &post_sum_mask,
                    );

                    for &s in &interleaved_buf[..chunk_samples] {
                        peak = peak.max((s * master_gain).abs());
                    }

                    frames_rendered += chunk_frames;
                    let progress = 0.5 * (frames_rendered as f32 / total_frames as f32);
                    if progress - last_progress >= 0.01 {
                        progress_callback(progress.min(1.0));
                        last_progress = progress;
                    }
                }

                if peak > 0.0 && peak != 1.0 {
                    let g = 1.0 / peak;
                    info!(
                        "[Bounce] Normalizing MP3 path: peak={:.4}, gain={:.4}dB",
                        peak,
                        20.0 * g.log10()
                    );
                    g
                } else {
                    1.0
                }
            } else {
                1.0
            };

            // Recreate render context for encode pass when normalization scanned first.
            let mut render_ctx = self.create_render_ctx(project, loop_region, sample_rate);
            frames_rendered = 0;
            last_progress = -1.0;
            let mut mp3_writer =
                Mp3Writer::create_streaming(&self.config.output_path, self.config.sample_rate)
                    .map_err(|e| BounceError::WriteError(e.to_string()))?;
            // Pre-allocate L/R scratch buffers — reused every chunk (zero per-iteration alloc).
            let mut left = Vec::with_capacity(OFFLINE_BUFFER_FRAMES);
            let mut right = Vec::with_capacity(OFFLINE_BUFFER_FRAMES);

            while frames_rendered < total_frames {
                if self.cancel_flag.load(Ordering::SeqCst) {
                    let _ = std::fs::remove_file(&self.config.output_path);
                    return Err(BounceError::RenderError(
                        "Bounce cancelled by user".to_string(),
                    ));
                }

                let remaining = total_frames - frames_rendered;
                let chunk_frames = remaining.min(OFFLINE_BUFFER_FRAMES);
                let chunk_samples = chunk_frames * OFFLINE_CHANNELS;
                interleaved_buf[..chunk_samples].fill(0.0);

                Self::render_routing_aware(
                    &mut render_ctx,
                    &mut interleaved_buf[..chunk_samples],
                    &clips_per_track,
                    clip_pool,
                    &routing,
                    &post_sum_mask,
                );

                left.clear();
                right.clear();
                for i in 0..chunk_frames {
                    let base = i * OFFLINE_CHANNELS;
                    let l = interleaved_buf[base] * gain * master_gain;
                    let r = interleaved_buf[base + 1] * gain * master_gain;
                    left.push(l);
                    right.push(r);
                }

                mp3_writer
                    .write_chunk(&left, &right)
                    .map_err(|e| BounceError::WriteError(e.to_string()))?;

                frames_rendered += chunk_frames;
                let progress = if self.config.normalize {
                    0.5 + 0.5 * (frames_rendered as f32 / total_frames as f32)
                } else {
                    frames_rendered as f32 / total_frames as f32
                };
                if progress - last_progress >= 0.01 {
                    progress_callback(progress.min(1.0));
                    last_progress = progress;
                }
            }

            mp3_writer
                .finalize()
                .map_err(|e| BounceError::WriteError(e.to_string()))?;
        } else {
            info!(
                "[Bounce] Writing WAV (streaming): {}-bit, {}",
                self.config.bit_depth, self.config.output_path
            );

            let mut interleaved_buf = vec![0.0f32; OFFLINE_BUFFER_FRAMES * OFFLINE_CHANNELS];

            let gain = if self.config.normalize {
                // Pass 1: peak scan.
                let mut render_ctx = self.create_render_ctx(project, loop_region, sample_rate);
                let mut frames_rendered = 0usize;
                let mut peak = 0.0f32;
                let mut last_progress = -1.0f32;

                while frames_rendered < total_frames {
                    if self.cancel_flag.load(Ordering::SeqCst) {
                        let _ = std::fs::remove_file(&self.config.output_path);
                        return Err(BounceError::RenderError(
                            "Bounce cancelled by user".to_string(),
                        ));
                    }
                    let remaining = total_frames - frames_rendered;
                    let chunk_frames = remaining.min(OFFLINE_BUFFER_FRAMES);
                    let chunk_samples = chunk_frames * OFFLINE_CHANNELS;
                    interleaved_buf[..chunk_samples].fill(0.0);

                    Self::render_routing_aware(
                        &mut render_ctx,
                        &mut interleaved_buf[..chunk_samples],
                        &clips_per_track,
                        clip_pool,
                        &routing,
                        &post_sum_mask,
                    );
                    for &s in &interleaved_buf[..chunk_samples] {
                        peak = peak.max((s * master_gain).abs());
                    }

                    frames_rendered += chunk_frames;
                    let progress = 0.5 * (frames_rendered as f32 / total_frames as f32);
                    if progress - last_progress >= 0.01 {
                        progress_callback(progress.min(1.0));
                        last_progress = progress;
                    }
                }

                if peak > 0.0 && peak != 1.0 {
                    let g = 1.0 / peak;
                    info!(
                        "[Bounce] Normalizing WAV path: peak={:.4}, gain={:.4}dB",
                        peak,
                        20.0 * g.log10()
                    );
                    g
                } else {
                    1.0
                }
            } else {
                1.0
            };

            // Pass 2 (or only pass when normalize=false): render + stream-write.
            let mut render_ctx = self.create_render_ctx(project, loop_region, sample_rate);
            let mut writer = WavWriter::create_streaming(
                &self.config.output_path,
                self.config.sample_rate,
                OFFLINE_CHANNELS as u16,
                self.config.bit_depth,
            )
            .map_err(|e| BounceError::WriteError(e.to_string()))?;

            let mut frames_rendered = 0usize;
            let mut last_progress = -1.0f32;
            while frames_rendered < total_frames {
                if self.cancel_flag.load(Ordering::SeqCst) {
                    let _ = std::fs::remove_file(&self.config.output_path);
                    return Err(BounceError::RenderError(
                        "Bounce cancelled by user".to_string(),
                    ));
                }

                let remaining = total_frames - frames_rendered;
                let chunk_frames = remaining.min(OFFLINE_BUFFER_FRAMES);
                let chunk_samples = chunk_frames * OFFLINE_CHANNELS;
                interleaved_buf[..chunk_samples].fill(0.0);

                Self::render_routing_aware(
                    &mut render_ctx,
                    &mut interleaved_buf[..chunk_samples],
                    &clips_per_track,
                    clip_pool,
                    &routing,
                    &post_sum_mask,
                );

                let total_gain = gain * master_gain;
                if total_gain != 1.0 {
                    for s in &mut interleaved_buf[..chunk_samples] {
                        *s *= total_gain;
                    }
                }

                writer
                    .write_interleaved_chunk(&interleaved_buf[..chunk_samples])
                    .map_err(|e| BounceError::WriteError(e.to_string()))?;

                frames_rendered += chunk_frames;
                let progress = if self.config.normalize {
                    0.5 + 0.5 * (frames_rendered as f32 / total_frames as f32)
                } else {
                    frames_rendered as f32 / total_frames as f32
                };
                if progress - last_progress >= 0.01 {
                    progress_callback(progress.min(1.0));
                    last_progress = progress;
                }
            }

            writer
                .finalize()
                .map_err(|e| BounceError::WriteError(e.to_string()))?;
        }

        // Final progress
        progress_callback(1.0);

        info!(
            "[Bounce] Complete: {} [{}] ({:.1}s @ {}Hz)",
            self.config.output_path,
            self.config.format,
            total_frames as f64 / sample_rate,
            self.config.sample_rate
        );

        Ok(())
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use dream_models::project::{Project, Track, TrackType};

    fn make_test_project() -> Project {
        use dream_models::time::AbsoluteTime;
        let mut project = Project::default();
        let mut track = Track::new("Test Track");
        track.track_type = TrackType::Audio;
        // Add a dummy clip so the project isn't considered empty.
        // The clip references a non-existent file, producing silence.
        track.clips.push(AudioClip::new(
            "Dummy Clip",
            "__test_dummy__/silence.wav",
            AbsoluteTime::new(0),
            AbsoluteTime::new(4096),
        ));
        project.tracks.push(track);
        project
    }

    #[test]
    fn bounce_config_total_frames() {
        let config = BounceConfig {
            output_path: "/tmp/test.wav".to_string(),
            sample_rate: 44100,
            bit_depth: 32,
            start_frame: 0,
            end_frame: 44100,
            normalize: false,
            tail_frames: 4410,
            format: "wav".to_string(),
            project_sample_rate: 44100.0,
        };
        assert_eq!(config.total_frames(), 48510);
    }

    #[test]
    fn bounce_rejects_invalid_range() {
        let config = BounceConfig {
            output_path: "/tmp/test.wav".to_string(),
            sample_rate: 44100,
            bit_depth: 32,
            start_frame: 100,
            end_frame: 50, // end < start
            normalize: false,
            tail_frames: 0,
            format: "wav".to_string(),
            project_sample_rate: 44100.0,
        };

        let bouncer = OfflineBouncer::new(config);
        let mut project = make_test_project();
        let mut pool = ClipPool::new();

        let result = bouncer.bounce(&mut project, &mut pool, None, |_| {});
        assert!(matches!(result, Err(BounceError::InvalidConfig(_))));
    }

    #[test]
    fn bounce_rejects_invalid_bit_depth() {
        let config = BounceConfig {
            output_path: "/tmp/test.wav".to_string(),
            sample_rate: 44100,
            bit_depth: 8, // unsupported
            start_frame: 0,
            end_frame: 1000,
            normalize: false,
            tail_frames: 0,
            format: "wav".to_string(),
            project_sample_rate: 44100.0,
        };

        let bouncer = OfflineBouncer::new(config);
        let mut project = make_test_project();
        let mut pool = ClipPool::new();

        let result = bouncer.bounce(&mut project, &mut pool, None, |_| {});
        assert!(matches!(result, Err(BounceError::InvalidConfig(_))));
    }

    #[test]
    fn bounce_silence_produces_wav() {
        let out_path = std::env::temp_dir().join("dream_bounce_test.wav");
        let config = BounceConfig {
            output_path: out_path.to_str().unwrap().to_string(),
            sample_rate: 44100,
            bit_depth: 32,
            start_frame: 0,
            end_frame: 4096, // ~93ms
            normalize: false,
            tail_frames: 0,
            format: "wav".to_string(),
            project_sample_rate: 44100.0,
        };

        let bouncer = OfflineBouncer::new(config);
        let mut project = make_test_project();
        let mut pool = ClipPool::new();

        let mut progress_values: Vec<f32> = Vec::new();
        let result = bouncer.bounce(&mut project, &mut pool, None, |p| {
            progress_values.push(p);
        });

        assert!(result.is_ok(), "Bounce failed: {:?}", result.err());
        assert!(out_path.exists(), "WAV file not created");

        // Progress should reach 1.0
        assert!(!progress_values.is_empty());
        assert!((progress_values.last().unwrap() - 1.0).abs() < 0.01);

        // Clean up
        let _ = std::fs::remove_file(&out_path);
    }

    #[test]
    fn bounce_with_normalization() {
        let out_path = std::env::temp_dir().join("dream_bounce_norm_test.wav");
        let config = BounceConfig {
            output_path: out_path.to_str().unwrap().to_string(),
            sample_rate: 44100,
            bit_depth: 24,
            start_frame: 0,
            end_frame: 2048,
            normalize: true,
            tail_frames: 0,
            format: "wav".to_string(),
            project_sample_rate: 44100.0,
        };

        let bouncer = OfflineBouncer::new(config);
        let mut project = make_test_project();
        let mut pool = ClipPool::new();

        let result = bouncer.bounce(&mut project, &mut pool, None, |_| {});
        assert!(result.is_ok());

        let _ = std::fs::remove_file(&out_path);
    }
}
