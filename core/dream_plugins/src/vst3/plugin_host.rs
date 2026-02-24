use std::collections::HashMap;

use log::info;
use uuid::Uuid;

use crate::descriptor::PluginDescriptor;
use crate::instance::{MidiEvent, PluginError, PluginInstance, TransportContext};
use crate::sandbox_instance::SandboxedPluginInstance;
use crate::vst2_host::Vst2Instance;
use crate::vst3_host::Vst3Instance;

pub type PluginInstanceArc = std::sync::Arc<parking_lot::Mutex<Box<dyn PluginInstance>>>;

/// Manages all loaded plugin instances.
///
/// The host owns all active plugin instances and provides methods to:
///   - Load and activate new instances.
///   - Access instances by ID for processing.
///   - Deactivate and unload instances.
///
/// This is NOT `Send` — it lives on the UI thread.
/// The audio thread accesses a snapshot via the execution plan.
pub struct PluginHost {
    /// All active plugin instances, keyed by their unique ID.
    instances: Vec<PluginInstanceArc>,
    instance_index: HashMap<Uuid, usize>,

    /// Current audio configuration.
    sample_rate: f64,
    buffer_size: usize,
}

impl PluginHost {
    /// Creates a new empty plugin host.
    pub fn new(sample_rate: f64, buffer_size: usize) -> Self {
        Self {
            instances: Vec::new(),
            instance_index: HashMap::new(),
            sample_rate,
            buffer_size,
        }
    }

    /// Loads, activates, and registers a VST3 plugin.
    pub fn load_vst3(&mut self, descriptor: PluginDescriptor) -> Result<Uuid, PluginError> {
        let mut instance = Vst3Instance::load(descriptor)?;
        instance.activate(self.sample_rate, self.buffer_size)?;

        let id = instance.id();
        info!("[PluginHost] Registered VST3 instance: {}", id);

        self.instances
            .push(std::sync::Arc::new(parking_lot::Mutex::new(Box::new(
                instance,
            ))));
        self.instance_index.insert(id, self.instances.len() - 1);
        Ok(id)
    }

    /// Loads, activates, and registers a VST2 plugin.
    ///
    /// Uses the existing `Vst2Instance` host implementation which handles
    /// the full lifecycle: dlopen → VSTPluginMain → activate → process.
    pub fn load_vst2(&mut self, descriptor: PluginDescriptor) -> Result<Uuid, PluginError> {
        let mut instance = Vst2Instance::load(&descriptor.path)?;
        instance.activate(self.sample_rate, self.buffer_size)?;

        let id = instance.id();
        info!("[PluginHost] Registered VST2 instance: {}", id);

        self.instances
            .push(std::sync::Arc::new(parking_lot::Mutex::new(Box::new(
                instance,
            ))));
        self.instance_index.insert(id, self.instances.len() - 1);
        Ok(id)
    }

    /// Reactivates all loaded plugin instances with a new sample rate
    /// and/or buffer size. This is necessary when the audio device
    /// configuration changes at runtime (e.g., user switches interface).
    ///
    /// Each instance is deactivated, then reactivated with the new config.
    /// Errors are logged but do not halt processing of remaining instances.
    pub fn reactivate_all(&mut self, sample_rate: f64, buffer_size: usize) {
        info!(
            "[PluginHost] Reactivating {} instances @ {}Hz, {} frames",
            self.instances.len(),
            sample_rate,
            buffer_size
        );
        self.sample_rate = sample_rate;
        self.buffer_size = buffer_size;

        for instance_arc in self.instances.iter_mut() {
            let mut instance = instance_arc.lock();
            if let Err(e) = instance.deactivate() {
                info!(
                    "[PluginHost] Deactivation warning for {}: {}",
                    instance.id(),
                    e
                );
            }
            if let Err(e) = instance.activate(sample_rate, buffer_size) {
                info!(
                    "[PluginHost] Reactivation failed for {}: {}",
                    instance.id(),
                    e
                );
            }
        }
    }

    /// Registers an out-of-process sandboxed plugin instance.
    ///
    /// The external daemon is expected to own the actual plugin runtime;
    /// this instance provides a shared-memory bridge under the same
    /// `PluginInstance` trait contract.
    pub fn load_vst3_sandboxed(
        &mut self,
        instance_id: Uuid,
        descriptor: PluginDescriptor,
        shared_region_path: std::path::PathBuf,
        num_inputs: u16,
        num_outputs: u16,
        max_frames: u32,
    ) -> Result<Uuid, PluginError> {
        let mut instance = SandboxedPluginInstance::create(
            instance_id,
            descriptor,
            shared_region_path,
            num_inputs,
            num_outputs,
            max_frames,
        )?;
        instance.activate(self.sample_rate, self.buffer_size)?;
        let id = instance.id();
        info!("[PluginHost] Registered sandboxed instance: {}", id);
        self.instances
            .push(std::sync::Arc::new(parking_lot::Mutex::new(Box::new(
                instance,
            ))));
        self.instance_index.insert(id, self.instances.len() - 1);
        Ok(id)
    }

    /// Returns a mutable reference to a plugin instance by its ID.
    pub fn get_mut(&mut self, id: Uuid) -> Option<&mut PluginInstanceArc> {
        let idx = *self.instance_index.get(&id)?;
        self.instances.get_mut(idx)
    }

    /// Sets transport context for an instance (RT-safe call-through).
    pub fn set_transport_context(
        &mut self,
        id: Uuid,
        ctx: TransportContext,
    ) -> Result<(), PluginError> {
        let instance_arc = self
            .get_mut(id)
            .ok_or_else(|| PluginError::InvalidState(format!("Instance {} not found", id)))?;
        let mut instance = instance_arc.lock();
        instance.set_transport_context(ctx);
        Ok(())
    }

    /// Queues a parameter change for a specific plugin instance.
    pub fn set_parameter(&mut self, id: Uuid, index: u32, value: f64) -> Result<(), PluginError> {
        let instance_arc = self
            .get_mut(id)
            .ok_or_else(|| PluginError::InvalidState(format!("Instance {} not found", id)))?;
        let mut instance = instance_arc.lock();
        instance.set_parameter(index, value)
    }

    /// Processes one plugin instance with optional sidechain bus and MIDI events.
    pub fn process_with_sidechain(
        &mut self,
        id: Uuid,
        main_inputs: &[&[f32]],
        sidechain_inputs: Option<&[&[f32]]>,
        outputs: &mut [&mut [f32]],
        num_frames: usize,
        midi_events: &[MidiEvent],
    ) -> Result<(), PluginError> {
        let instance_arc = self
            .get_mut(id)
            .ok_or_else(|| PluginError::InvalidState(format!("Instance {} not found", id)))?;
        let mut instance = instance_arc.lock();
        instance.process_with_sidechain(
            main_inputs,
            sidechain_inputs,
            outputs,
            num_frames,
            midi_events,
        )
    }

    /// Removes and deactivates a plugin instance by its ID.
    pub fn remove(&mut self, id: Uuid) -> Result<(), PluginError> {
        let Some(pos) = self.instance_index.remove(&id) else {
            return Err(PluginError::InvalidState(format!(
                "Instance {} not found",
                id
            )));
        };

        let instance_arc = self.instances.swap_remove(pos);
        let mut instance = instance_arc.lock();
        let _ = instance.close_editor();
        instance.deactivate()?;

        if pos < self.instances.len() {
            let swapped_id = self.instances[pos].lock().id();
            self.instance_index.insert(swapped_id, pos);
        }

        info!("[PluginHost] Removed instance: {}", id);
        Ok(())
    }

    /// Gracefully shuts down all loaded plugin instances.
    ///
    /// This method **must** be called before the process exits to prevent
    /// SIGSEGV crashes caused by third-party C++ plugins whose static
    /// destructors attempt to use resources that are already torn down
    /// during `exit()` (e.g., SlateCore sending ObjC messages to nil objects).
    ///
    /// Each instance is closed (editor) and deactivated in reverse order.
    /// Errors are logged but do not halt the teardown of remaining instances —
    /// resilience is critical here since we are shutting down.
    pub fn shutdown_all(&mut self) {
        let count = self.instances.len();
        if count == 0 {
            info!("[PluginHost] shutdown_all — no instances to tear down");
            return;
        }
        info!(
            "[PluginHost] shutdown_all — tearing down {} instance(s)",
            count
        );

        // Drain in reverse order — last loaded, first unloaded.
        while let Some(instance_arc) = self.instances.pop() {
            let mut instance = instance_arc.lock();
            let id = instance.id();
            let name = instance.descriptor().name.clone();

            if let Err(e) = instance.close_editor() {
                log::warn!(
                    "[PluginHost] shutdown_all: close_editor failed for '{}' ({}): {}",
                    name,
                    id,
                    e
                );
            }
            if let Err(e) = instance.deactivate() {
                log::warn!(
                    "[PluginHost] shutdown_all: deactivate failed for '{}' ({}): {}",
                    name,
                    id,
                    e
                );
            }
            info!("[PluginHost] shutdown_all: released '{}' ({})", name, id);
        }

        self.instance_index.clear();
        info!("[PluginHost] shutdown_all — complete, all instances released");
    }

    /// Returns the number of active instances.
    pub fn instance_count(&self) -> usize {
        self.instances.len()
    }

    /// Returns a snapshot of all active plugin instances for publishing to the
    /// audio thread's `SharedPluginRegistry`. Each entry maps
    /// `instance_id -> Arc<Mutex<PluginInstance>>`.
    ///
    /// This is called after every plugin load/unload to keep the registry in
    /// sync with the host. The audio thread uses this registry to call
    /// `process()` on VST3 instruments and FX.
    pub fn snapshot_registry(&self) -> HashMap<Uuid, PluginInstanceArc> {
        let mut map = HashMap::with_capacity(self.instances.len());
        for instance_arc in &self.instances {
            let id = instance_arc.lock().id();
            map.insert(id, std::sync::Arc::clone(instance_arc));
        }
        map
    }

    /// Returns an immutable reference to a plugin instance by its ID.
    pub fn get(&self, id: Uuid) -> Option<&PluginInstanceArc> {
        let idx = *self.instance_index.get(&id)?;
        self.instances.get(idx)
    }

    /// Captures the current state of all loaded plugin instances.
    ///
    /// Returns a map of instance_id → raw state bytes for each instance
    /// that successfully serializes its state. Errors are logged but do not
    /// prevent other instances from being captured.
    pub fn save_all_states(&self) -> HashMap<Uuid, Vec<u8>> {
        let mut states = HashMap::new();
        log::info!(
            "[PluginHost] save_all_states called — {} instances in host, index has {} entries",
            self.instances.len(),
            self.instance_index.len()
        );
        for instance_arc in &self.instances {
            let instance = instance_arc.lock();
            match instance.save_state() {
                Ok(bytes) if !bytes.is_empty() => {
                    info!(
                        "[PluginHost] Captured state for '{}' ({} bytes)",
                        instance.descriptor().name,
                        bytes.len()
                    );
                    states.insert(instance.id(), bytes);
                }
                Ok(_) => {}
                Err(e) => {
                    log::warn!(
                        "[PluginHost] Failed to capture state for '{}': {}",
                        instance.descriptor().name,
                        e
                    );
                }
            }
        }
        states
    }

    /// Saves the state of a single plugin instance by UUID.
    /// Returns None if the instance is not found or has no state.
    pub fn save_instance_state(&self, id: Uuid) -> Option<Vec<u8>> {
        self.instances
            .iter()
            .find(|inst| inst.lock().id() == id)
            .and_then(|inst| inst.lock().save_state().ok())
            .filter(|bytes| !bytes.is_empty())
    }

    /// Updates the audio configuration for all instances.
    pub fn set_audio_config(
        &mut self,
        sample_rate: f64,
        buffer_size: usize,
    ) -> Result<(), PluginError> {
        self.sample_rate = sample_rate;
        self.buffer_size = buffer_size;

        // BUG-RT4 FIX: Continue past errors so ALL instances get reconfigured.
        // Previously used `?` which stopped on first failure, leaving remaining
        // instances in inconsistent state with stale sample rate / buffer size.
        let mut first_error: Option<PluginError> = None;
        for instance_arc in &mut self.instances {
            let mut instance = instance_arc.lock();
            if let Err(e) = instance.deactivate() {
                info!(
                    "[PluginHost] Warning: deactivate failed for '{}': {}",
                    instance.descriptor().name,
                    e
                );
                if first_error.is_none() {
                    first_error = Some(e);
                }
            }
            if let Err(e) = instance.activate(sample_rate, buffer_size) {
                info!(
                    "[PluginHost] Warning: activate failed for '{}': {}",
                    instance.descriptor().name,
                    e
                );
                if first_error.is_none() {
                    first_error = Some(e);
                }
            }
        }

        info!(
            "[PluginHost] Audio config updated: {}Hz, {} frames, {} instances{}",
            sample_rate,
            buffer_size,
            self.instances.len(),
            if first_error.is_some() {
                " (with errors)"
            } else {
                ""
            }
        );

        match first_error {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    /// Opens native editor for a specific plugin instance.
    pub fn open_editor(&mut self, id: Uuid) -> Result<(), PluginError> {
        let instance_arc = self
            .get_mut(id)
            .ok_or_else(|| PluginError::InvalidState(format!("Instance {} not found", id)))?;
        let mut instance = instance_arc.lock();
        instance.open_editor()
    }

    /// Closes native editor for a specific plugin instance.
    pub fn close_editor(&mut self, id: Uuid) -> Result<(), PluginError> {
        let instance_arc = self
            .get_mut(id)
            .ok_or_else(|| PluginError::InvalidState(format!("Instance {} not found", id)))?;
        let mut instance = instance_arc.lock();
        instance.close_editor()
    }

    /// Returns whether a plugin instance supports opening a native editor.
    pub fn supports_editor(&mut self, id: Uuid) -> Result<bool, PluginError> {
        let instance_arc = self
            .get_mut(id)
            .ok_or_else(|| PluginError::InvalidState(format!("Instance {} not found", id)))?;
        let instance = instance_arc.lock();
        Ok(instance.supports_editor())
    }

    /// Returns plugin reported processing latency in samples.
    pub fn latency_samples(&mut self, id: Uuid) -> Result<u32, PluginError> {
        let instance_arc = self
            .get_mut(id)
            .ok_or_else(|| PluginError::InvalidState(format!("Instance {} not found", id)))?;
        let instance = instance_arc.lock();
        Ok(instance.latency_samples())
    }

    pub fn load_state_blob(
        &mut self,
        id: Uuid,
        kind: Option<&str>,
        data: &[u8],
    ) -> Result<(), PluginError> {
        let instance_arc = self
            .get_mut(id)
            .ok_or_else(|| PluginError::InvalidState(format!("Instance {} not found", id)))?;
        let mut instance = instance_arc.lock();
        instance.load_state_blob(kind, data)
    }
}
