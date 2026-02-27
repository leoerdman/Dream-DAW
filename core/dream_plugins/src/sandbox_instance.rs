#![cfg_attr(test, allow(clippy::expect_used))]
// ═══════════════════════════════════════════════════════════════════════════
// SandboxedPluginInstance — Out-of-Process Plugin Bridge
// ═══════════════════════════════════════════════════════════════════════════
//
// Implements the PluginInstance trait by delegating audio processing to an
// external daemon process via shared memory. Uses a 1-block latency model:
//
//   Block N: Read daemon output from block N-1, write inputs for block N
//   Block N+1: Read daemon output from block N, write inputs for block N+1
//
// MIDI events are forwarded via the shared memory header (zero-allocation)
// for the first MAX_INLINE_MIDI_EVENTS events, with overflow sent via the
// IPC control channel as a fallback.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;

use uuid::Uuid;

use crate::descriptor::PluginDescriptor;
use crate::instance::{MidiEvent, PluginError, PluginInstance, TransportContext};
use crate::sandbox_ipc::PluginHostControlMessage;
use crate::shared_memory::{
    InlineMidiEvent, MAX_INLINE_MIDI_EVENTS, SharedAudioBufferLayout, SharedAudioBufferRegion,
};

/// PluginInstance implementation backed by an out-of-process sandbox bridge.
///
/// If the daemon has not yet produced output or has crashed, this instance
/// gracefully passes input through to output (silence-safe fallback).
pub struct SandboxedPluginInstance {
    id: Uuid,
    descriptor: PluginDescriptor,
    shared_region: SharedAudioBufferRegion,
    active: bool,
    /// Transport context snapshot forwarded by the audio engine each render cycle.
    transport: TransportContext,
    /// Plugin-reported latency for host PDC (plugin delay compensation).
    latency_samples: u32,
    /// Whether this plugin supports opening a GUI editor window.
    supports_editor: bool,
    request_seq: u32,
    /// Channel to send IPC control messages to the daemon (for overflow MIDI, params, etc.)
    ipc_sender: Option<mpsc::Sender<PluginHostControlMessage>>,
    /// LAZARUS PROTOCOL: Atomic crash flag set by the supervisor.
    /// The audio thread checks this without taking any lock.
    /// Arc-shared with the supervisor so it can set it from another thread.
    pub is_crashed: Arc<AtomicBool>,
    /// LAZARUS PROTOCOL: Bypass ramp counter (smooths audio transition).
    /// When recovering from crash, starts at BYPASS_RAMP_SAMPLES and
    /// counts down to 0. Output is multiplied by (remaining / BYPASS_RAMP_SAMPLES).
    bypass_ramp_remaining: u32,
    was_crashed_last_block: bool,
    /// Cache of last sent parameter values to prevent IPC flooding from automation curves.
    /// Pre-allocated Vec instead of HashMap to avoid RT-unsafe heap allocation.
    param_cache: Vec<(u32, f64)>,
}

/// Number of samples over which to ramp bypass→active after crash recovery.
const BYPASS_RAMP_SAMPLES: u32 = 64;

fn apply_recovery_ramp_to_outputs(
    remaining: &mut u32,
    inputs: &[&[f32]],
    outputs: &mut [&mut [f32]],
    num_frames: usize,
) {
    if *remaining == 0 || num_frames == 0 {
        return;
    }
    let num_frames_u32 = u32::try_from(num_frames).unwrap_or(u32::MAX);
    let fade_frames = (*remaining).min(num_frames_u32) as usize;
    for i in 0..fade_frames {
        let rem = *remaining;
        let dry_gain = rem as f32 / BYPASS_RAMP_SAMPLES as f32;
        let wet_gain = 1.0 - dry_gain;
        for (ch, out) in outputs.iter_mut().enumerate() {
            let dry = inputs
                .get(ch)
                .and_then(|input| input.get(i).copied())
                .unwrap_or(0.0);
            out[i] = dry * dry_gain + out[i] * wet_gain;
        }
        *remaining = remaining.saturating_sub(1);
    }
}

impl SandboxedPluginInstance {
    pub fn create(
        id: Uuid,
        descriptor: PluginDescriptor,
        shared_region_path: PathBuf,
        num_inputs: u16,
        num_outputs: u16,
        max_frames: u32,
    ) -> Result<Self, PluginError> {
        let layout = SharedAudioBufferLayout {
            num_inputs,
            num_outputs,
            max_frames,
        };
        let shared_region = SharedAudioBufferRegion::open_existing(shared_region_path, layout)
            .map_err(PluginError::LoadFailed)?;
        Ok(Self {
            id,
            descriptor,
            shared_region,
            active: false,
            transport: TransportContext::default(),
            latency_samples: 0,
            supports_editor: false,
            request_seq: 0,
            ipc_sender: None,
            is_crashed: Arc::new(AtomicBool::new(false)),
            bypass_ramp_remaining: 0,
            was_crashed_last_block: false,
            param_cache: Vec::with_capacity(64),
        })
    }

    /// Attach an IPC sender channel for forwarding control messages
    /// (overflow MIDI events, parameter changes) to the sandbox daemon.
    pub fn set_ipc_sender(&mut self, sender: mpsc::Sender<PluginHostControlMessage>) {
        self.ipc_sender = Some(sender);
    }

    /// Passthrough fallback: copies inputs to outputs (or silence if no matching input).
    fn pass_through(
        &self,
        inputs: &[&[f32]],
        outputs: &mut [&mut [f32]],
        num_frames: usize,
    ) -> Result<(), PluginError> {
        for (ch, out) in outputs.iter_mut().enumerate() {
            let input = inputs.get(ch).copied().unwrap_or(&[]);
            for i in 0..num_frames {
                out[i] = if i < input.len() { input[i] } else { 0.0 };
            }
        }
        Ok(())
    }

    /// Writes MIDI events into the shared memory header (zero-allocation on RT thread).
    ///
    /// The first MAX_INLINE_MIDI_EVENTS events are written directly into the shared memory
    /// header as InlineMidiEvent structs — no heap allocation whatsoever. If there are more
    /// events than fit inline, the overflow is sent via the IPC control channel as a fallback
    /// (this path does allocate, but is extremely rare — >4 MIDI events per audio block is unusual).
    fn forward_midi_events(&mut self, midi_events: &[MidiEvent]) {
        if midi_events.is_empty() {
            self.shared_region.clear_midi_events();
            return;
        }

        // ── Zero-allocation fast path: write into shared memory header ───
        let inline_count = midi_events.len().min(MAX_INLINE_MIDI_EVENTS);
        let mut inline_buf = [InlineMidiEvent::default(); MAX_INLINE_MIDI_EVENTS];
        for (i, evt) in midi_events[..inline_count].iter().enumerate() {
            inline_buf[i] = InlineMidiEvent {
                sample_offset: evt.sample_offset,
                channel: evt.channel,
                data: evt.data,
            };
        }
        self.shared_region
            .write_midi_events(&inline_buf[..inline_count]);

        // ── Overflow fallback: send via IPC channel (rare, >4 events/block) ───
        if midi_events.len() > MAX_INLINE_MIDI_EVENTS
            && let Some(ref sender) = self.ipc_sender
        {
            let overflow: Vec<(i32, u8, [u8; 3])> = midi_events[MAX_INLINE_MIDI_EVENTS..]
                .iter()
                .map(|e| (e.sample_offset, e.channel, e.data))
                .collect();
            let msg = PluginHostControlMessage::SendMidiEvents {
                instance_id: self.id,
                events: overflow,
            };
            let _ = sender.send(msg);
        }
    }

    /// Reads the daemon's processed output from shared memory.
    /// Returns true if valid output was read, false if passthrough was used.
    fn read_daemon_output(
        &self,
        outputs: &mut [&mut [f32]],
        num_frames: usize,
        inputs_for_passthrough: &[&[f32]],
    ) -> Result<bool, PluginError> {
        let processed_seq = self.shared_region.processed_seq();
        let has_new_block = processed_seq != 0 && processed_seq >= self.request_seq;

        if has_new_block {
            let mut read_ok = true;
            for (ch, out) in outputs.iter_mut().enumerate() {
                if self
                    .shared_region
                    .read_output_channel(ch, num_frames, out)
                    .is_err()
                {
                    read_ok = false;
                    break;
                }
            }
            if !read_ok {
                self.pass_through(inputs_for_passthrough, outputs, num_frames)?;
                return Ok(false);
            }
            Ok(true)
        } else {
            // Daemon hasn't caught up yet — passthrough.
            self.pass_through(inputs_for_passthrough, outputs, num_frames)?;
            Ok(false)
        }
    }

    /// Writes input samples and advances the sequence counter.
    fn submit_inputs_to_daemon<'a>(
        &mut self,
        input_channels: impl Iterator<Item = (usize, &'a [f32])>,
        num_frames: usize,
    ) {
        for (ch, input) in input_channels {
            let n = input.len().min(num_frames);
            let _ = self.shared_region.write_input_channel(ch, &input[..n]);
        }
        self.shared_region
            .set_requested_frames(u32::try_from(num_frames).unwrap_or(u32::MAX));
        self.request_seq = self.request_seq.wrapping_add(1);
        self.shared_region.set_request_seq(self.request_seq);
    }
}

impl PluginInstance for SandboxedPluginInstance {
    fn id(&self) -> Uuid {
        self.id
    }

    fn descriptor(&self) -> &PluginDescriptor {
        &self.descriptor
    }

    fn activate(&mut self, sample_rate: f64, max_buffer_size: usize) -> Result<(), PluginError> {
        self.transport.sample_rate = sample_rate;
        self.active = true;
        // BUG-AUD-308 FIX: Forward new buffer size to sandbox daemon via IPC.
        // Previously this parameter was ignored with `_max_buffer_size`, so the
        // daemon continued using creation-time max_frames after reactivation.
        if let Some(ref sender) = self.ipc_sender {
            let _ = sender.send(PluginHostControlMessage::SetBufferSize {
                instance_id: self.id,
                max_frames: u32::try_from(max_buffer_size).unwrap_or(u32::MAX),
            });
        }
        Ok(())
    }

    fn deactivate(&mut self) -> Result<(), PluginError> {
        self.active = false;
        Ok(())
    }

    fn set_parameter(&mut self, index: u32, value: f64) -> Result<(), PluginError> {
        // Debounce: Only send if the value changed significantly to prevent IPC flood
        // from flat automation curves or high-frequency UI dragging.
        // Uses linear scan on pre-allocated Vec (no heap allocation on RT thread).
        if let Some(entry) = self.param_cache.iter().find(|(i, _)| *i == index) {
            if (entry.1 - value).abs() < 1e-6 {
                return Ok(());
            }
        }
        // Update or insert (no allocation since Vec is pre-allocated with_capacity(64))
        if let Some(entry) = self.param_cache.iter_mut().find(|(i, _)| *i == index) {
            entry.1 = value;
        } else {
            self.param_cache.push((index, value));
        }

        if let Some(ref sender) = self.ipc_sender {
            let msg = PluginHostControlMessage::SetParameter {
                instance_id: self.id,
                index,
                value,
            };
            let _ = sender.send(msg);
        }
        Ok(())
    }

    fn process(
        &mut self,
        inputs: &[&[f32]],
        outputs: &mut [&mut [f32]],
        num_frames: usize,
        midi_events: &[MidiEvent],
    ) -> Result<(), PluginError> {
        if !self.active {
            return Err(PluginError::InvalidState(
                "Sandboxed plugin is not active".to_string(),
            ));
        }
        if num_frames > self.shared_region.layout.max_frames as usize {
            return Err(PluginError::ProcessError(
                "num_frames exceeds shared max".to_string(),
            ));
        }

        // LAZARUS PROTOCOL: Zero-lock crash check via atomic flag.
        // If crashed, immediately passthrough — no blocking, no allocation.
        if self.is_crashed.load(Ordering::Relaxed) {
            self.was_crashed_last_block = true;
            self.bypass_ramp_remaining = BYPASS_RAMP_SAMPLES;
            return self.pass_through(inputs, outputs, num_frames);
        }
        if self.was_crashed_last_block {
            self.was_crashed_last_block = false;
            self.bypass_ramp_remaining = BYPASS_RAMP_SAMPLES;
        }

        // Forward MIDI via shared memory (zero-allocation for ≤4 events)
        self.forward_midi_events(midi_events);

        // Read previous block's output BEFORE writing new inputs (1-block latency model)
        let read_ok = self.read_daemon_output(outputs, num_frames, inputs)?;
        if read_ok && self.bypass_ramp_remaining > 0 {
            apply_recovery_ramp_to_outputs(
                &mut self.bypass_ramp_remaining,
                inputs,
                outputs,
                num_frames,
            );
        }

        // Submit inputs for daemon consumption (for the NEXT block)
        self.submit_inputs_to_daemon(
            inputs.iter().enumerate().map(|(ch, s)| (ch, *s)),
            num_frames,
        );

        Ok(())
    }

    fn process_with_sidechain(
        &mut self,
        main_inputs: &[&[f32]],
        sidechain_inputs: Option<&[&[f32]]>,
        outputs: &mut [&mut [f32]],
        num_frames: usize,
        midi_events: &[MidiEvent],
    ) -> Result<(), PluginError> {
        if !self.active {
            // BUG-AUD-309 FIX: Use static str — no heap allocation on RT thread.
            return Err(PluginError::InvalidState(
                "Sandboxed plugin is not active".into(),
            ));
        }
        if num_frames > self.shared_region.layout.max_frames as usize {
            // BUG-AUD-309 FIX: Use static str — no heap allocation on RT thread.
            return Err(PluginError::ProcessError(
                "num_frames exceeds shared max".into(),
            ));
        }

        // LAZARUS PROTOCOL: Zero-lock crash check via atomic flag.
        // If crashed, immediately passthrough — no blocking, no allocation.
        if self.is_crashed.load(Ordering::Relaxed) {
            self.was_crashed_last_block = true;
            self.bypass_ramp_remaining = BYPASS_RAMP_SAMPLES;
            return self.pass_through(main_inputs, outputs, num_frames);
        }
        if self.was_crashed_last_block {
            self.was_crashed_last_block = false;
            self.bypass_ramp_remaining = BYPASS_RAMP_SAMPLES;
        }

        // Forward MIDI via shared memory
        self.forward_midi_events(midi_events);

        // Read previous block
        let read_ok = self.read_daemon_output(outputs, num_frames, main_inputs)?;
        if read_ok && self.bypass_ramp_remaining > 0 {
            apply_recovery_ramp_to_outputs(
                &mut self.bypass_ramp_remaining,
                main_inputs,
                outputs,
                num_frames,
            );
        }

        // Write inputs for NEXT block — interleave main + sidechain
        let sidechain = sidechain_inputs.unwrap_or(&[]);
        let input_channels = self.shared_region.layout.num_inputs as usize;

        let channel_iter = (0..input_channels).map(|ch| {
            let src: &[f32] = if ch < 2 {
                main_inputs.get(ch).copied().unwrap_or(&[])
            } else {
                sidechain
                    .get(ch - 2)
                    .copied()
                    .or_else(|| sidechain.first().copied())
                    .unwrap_or(&[])
            };
            (ch, src)
        });

        self.submit_inputs_to_daemon(channel_iter, num_frames);

        Ok(())
    }

    fn latency_samples(&self) -> u32 {
        self.latency_samples
    }

    fn reset(&mut self) {
        self.request_seq = 0;
        self.shared_region.set_request_seq(0);
        self.shared_region.set_processed_seq(0);
        self.shared_region.clear_midi_events();
    }

    fn set_transport_context(&mut self, ctx: TransportContext) {
        self.transport = ctx;
    }

    fn is_active(&self) -> bool {
        self.active
    }

    fn supports_editor(&self) -> bool {
        self.supports_editor
    }
}

#[cfg(test)]
mod tests {
    use super::apply_recovery_ramp_to_outputs;
    use super::*;
    use crate::format::{PluginCategory, PluginFormat};
    use crate::shared_memory::{SharedAudioBufferLayout, SharedAudioBufferRegion};
    use std::path::PathBuf;
    use std::sync::atomic::Ordering;

    #[test]
    fn recovery_ramp_blends_dry_to_wet() {
        let input_l = [1.0_f32; 4];
        let input_r = [0.5_f32; 4];
        let mut out_l = [0.0_f32; 4];
        let mut out_r = [0.0_f32; 4];
        let mut remaining = 4_u32;
        let inputs: [&[f32]; 2] = [&input_l, &input_r];
        let mut outputs: [&mut [f32]; 2] = [&mut out_l, &mut out_r];

        apply_recovery_ramp_to_outputs(&mut remaining, &inputs, &mut outputs, 4);

        assert_eq!(remaining, 0);
        assert!(out_l[0] > out_l[1]);
        assert!(out_l[1] > out_l[2]);
        assert!(out_l[2] > out_l[3]);
        assert!(out_r[0] > out_r[1]);
        assert!(out_r[1] > out_r[2]);
        assert!(out_r[2] > out_r[3]);
        assert!(out_l[0] > 0.0);
    }

    #[test]
    fn process_passthroughs_while_crashed() {
        let region_path = std::env::temp_dir().join(format!(
            "dream_daw_sandbox_instance_crashed_{}.bin",
            Uuid::new_v4()
        ));
        let layout = SharedAudioBufferLayout {
            num_inputs: 2,
            num_outputs: 2,
            max_frames: 64,
        };
        let _owner = SharedAudioBufferRegion::create(region_path.clone(), layout.clone())
            .expect("test invariant: unwrap removed for clippy policy");
        let descriptor = PluginDescriptor::new(
            "Test Plugin",
            "Dream",
            PluginFormat::VST3,
            PluginCategory::Effect,
            PathBuf::from("/tmp/test.vst3"),
        );
        let mut instance =
            SandboxedPluginInstance::create(Uuid::new_v4(), descriptor, region_path, 2, 2, 64)
                .expect("test invariant: unwrap removed for clippy policy");
        instance
            .activate(48_000.0, 64)
            .expect("test invariant: unwrap removed for clippy policy");

        let in_l = [0.1_f32, 0.2, 0.3, 0.4];
        let in_r = [0.4_f32, 0.3, 0.2, 0.1];
        let mut out_l = [0.0_f32; 4];
        let mut out_r = [0.0_f32; 4];
        let inputs: [&[f32]; 2] = [&in_l, &in_r];
        let mut outputs: [&mut [f32]; 2] = [&mut out_l, &mut out_r];

        instance.is_crashed.store(true, Ordering::Relaxed);
        instance
            .process(&inputs, &mut outputs, 4, &[])
            .expect("test invariant: unwrap removed for clippy policy");

        assert_eq!(out_l, in_l);
        assert_eq!(out_r, in_r);
        assert_eq!(instance.request_seq, 0);
    }

    #[test]
    fn process_recovers_with_ramp_after_crash_flag_clears() {
        let region_path = std::env::temp_dir().join(format!(
            "dream_daw_sandbox_instance_recovery_{}.bin",
            Uuid::new_v4()
        ));
        let layout = SharedAudioBufferLayout {
            num_inputs: 2,
            num_outputs: 2,
            max_frames: 64,
        };
        let _owner = SharedAudioBufferRegion::create(region_path.clone(), layout.clone())
            .expect("test invariant: unwrap removed for clippy policy");
        let descriptor = PluginDescriptor::new(
            "Test Plugin",
            "Dream",
            PluginFormat::VST3,
            PluginCategory::Effect,
            PathBuf::from("/tmp/test.vst3"),
        );
        let mut instance =
            SandboxedPluginInstance::create(Uuid::new_v4(), descriptor, region_path, 2, 2, 64)
                .expect("test invariant: unwrap removed for clippy policy");
        instance
            .activate(48_000.0, 64)
            .expect("test invariant: unwrap removed for clippy policy");

        let in_l = [1.0_f32; 4];
        let in_r = [0.5_f32; 4];
        let inputs: [&[f32]; 2] = [&in_l, &in_r];

        let mut crashed_out_l = [0.0_f32; 4];
        let mut crashed_out_r = [0.0_f32; 4];
        let mut crashed_outputs: [&mut [f32]; 2] = [&mut crashed_out_l, &mut crashed_out_r];
        instance.is_crashed.store(true, Ordering::Relaxed);
        instance
            .process(&inputs, &mut crashed_outputs, 4, &[])
            .expect("test invariant: unwrap removed for clippy policy");
        assert_eq!(crashed_out_l, in_l);
        assert_eq!(crashed_out_r, in_r);

        instance.is_crashed.store(false, Ordering::Relaxed);
        instance
            .shared_region
            .write_output_channel(0, &[0.0_f32; 4])
            .expect("test invariant: unwrap removed for clippy policy");
        instance
            .shared_region
            .write_output_channel(1, &[0.0_f32; 4])
            .expect("test invariant: unwrap removed for clippy policy");
        instance.shared_region.set_processed_seq(1);

        let mut recovered_out_l = [0.0_f32; 4];
        let mut recovered_out_r = [0.0_f32; 4];
        let mut recovered_outputs: [&mut [f32]; 2] = [&mut recovered_out_l, &mut recovered_out_r];
        instance
            .process(&inputs, &mut recovered_outputs, 4, &[])
            .expect("test invariant: unwrap removed for clippy policy");

        assert!(recovered_out_l[0] >= recovered_out_l[1]);
        assert!(recovered_out_l[1] >= recovered_out_l[2]);
        assert!(recovered_out_l[2] >= recovered_out_l[3]);
        assert_eq!(recovered_out_l[0], in_l[0]);
        assert!(recovered_out_l[3] > 0.0);
        assert!(recovered_out_r[0] >= recovered_out_r[1]);
        assert!(recovered_out_r[1] >= recovered_out_r[2]);
        assert!(recovered_out_r[2] >= recovered_out_r[3]);
    }
}
