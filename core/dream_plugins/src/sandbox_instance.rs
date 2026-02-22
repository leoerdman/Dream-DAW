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
use std::sync::mpsc;

use uuid::Uuid;

use crate::descriptor::PluginDescriptor;
use crate::instance::{MidiEvent, PluginError, PluginInstance, TransportContext};
use crate::sandbox_ipc::PluginHostControlMessage;
use crate::shared_memory::{
    InlineMidiEvent, SharedAudioBufferLayout, SharedAudioBufferRegion, MAX_INLINE_MIDI_EVENTS,
};

/// PluginInstance implementation backed by an out-of-process sandbox bridge.
///
/// If the daemon has not yet produced output or has crashed, this instance
/// gracefully passes input through to output (silence-safe fallback).
pub struct SandboxedPluginInstance {
    id: Uuid,
    descriptor: PluginDescriptor,
    active: bool,
    transport: TransportContext,
    latency_samples: u32,
    supports_editor: bool,
    shared_region: SharedAudioBufferRegion,
    request_seq: u32,
    /// Channel to send IPC control messages to the daemon (for overflow MIDI, params, etc.)
    ipc_sender: Option<mpsc::Sender<PluginHostControlMessage>>,
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
            active: false,
            transport: TransportContext::default(),
            latency_samples: 0,
            supports_editor: false,
            shared_region,
            request_seq: 0,
            ipc_sender: None,
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
        self.shared_region.write_midi_events(&inline_buf[..inline_count]);

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
        self.shared_region.set_requested_frames(num_frames as u32);
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

    fn activate(&mut self, sample_rate: f64, _max_buffer_size: usize) -> Result<(), PluginError> {
        self.transport.sample_rate = sample_rate;
        self.active = true;
        Ok(())
    }

    fn deactivate(&mut self) -> Result<(), PluginError> {
        self.active = false;
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

        // Forward MIDI via shared memory (zero-allocation for ≤4 events)
        self.forward_midi_events(midi_events);

        // Read previous block's output BEFORE writing new inputs (1-block latency model)
        self.read_daemon_output(outputs, num_frames, inputs)?;

        // Write inputs for daemon consumption (for the NEXT block)
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
            return Err(PluginError::InvalidState(
                "Sandboxed plugin is not active".to_string(),
            ));
        }
        if num_frames > self.shared_region.layout.max_frames as usize {
            return Err(PluginError::ProcessError(
                "num_frames exceeds shared max".to_string(),
            ));
        }

        // Forward MIDI via shared memory
        self.forward_midi_events(midi_events);

        // Read previous block
        self.read_daemon_output(outputs, num_frames, main_inputs)?;

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
