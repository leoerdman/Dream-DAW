use std::path::PathBuf;

use uuid::Uuid;

use crate::descriptor::PluginDescriptor;
use crate::instance::{PluginError, PluginInstance, TransportContext};
use crate::shared_memory::{SharedAudioBufferLayout, SharedAudioBufferRegion};

/// PluginInstance implementation backed by an out-of-process sandbox bridge.
///
/// Current phase: lifecycle + shared-memory transport contract. If daemon output
/// is unavailable, it gracefully passes input through to output.
pub struct SandboxedPluginInstance {
    id: Uuid,
    descriptor: PluginDescriptor,
    active: bool,
    transport: TransportContext,
    latency_samples: u32,
    supports_editor: bool,
    shared_region: SharedAudioBufferRegion,
    request_seq: u32,
    last_seen_processed_seq: u32,
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
            last_seen_processed_seq: 0,
        })
    }

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
    ) -> Result<(), PluginError> {
        if !self.active {
            return Err(PluginError::InvalidState(
                "Sandboxed plugin is not active".to_string(),
            ));
        }
        if num_frames > self.shared_region.layout.max_frames as usize {
            return Err(PluginError::ProcessError(format!(
                "num_frames={} exceeds shared max={}",
                num_frames, self.shared_region.layout.max_frames
            )));
        }

        // Write inputs for daemon consumption.
        for (ch, input) in inputs.iter().enumerate() {
            let n = input.len().min(num_frames);
            self.shared_region
                .write_input_channel(ch, &input[..n])
                .map_err(PluginError::ProcessError)?;
        }
        self.shared_region.set_requested_frames(num_frames as u32);
        self.request_seq = self.request_seq.wrapping_add(1);
        self.shared_region.set_request_seq(self.request_seq);
        let _ = self.shared_region.flush();

        let processed_seq = self.shared_region.processed_seq();
        let has_new_block = processed_seq != 0 && processed_seq >= self.request_seq;
        self.last_seen_processed_seq = processed_seq;

        if has_new_block {
            let mut read_ok = true;
            for (ch, out) in outputs.iter_mut().enumerate() {
                if let Err(_err) = self.shared_region.read_output_channel(ch, num_frames, out) {
                    read_ok = false;
                    break;
                }
            }
            if !read_ok {
                self.pass_through(inputs, outputs, num_frames)?;
            }
        } else {
            self.pass_through(inputs, outputs, num_frames)?;
        }

        Ok(())
    }

    fn latency_samples(&self) -> u32 {
        self.latency_samples
    }

    fn reset(&mut self) {
        // No-op for now.
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
