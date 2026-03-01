// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — External Device Slot (VST3/CLAP/AU Plugin Wrapper)
// ═══════════════════════════════════════════════════════════════════════════
//
// Wraps a `PluginInstanceArc` (Arc<Mutex<Box<dyn PluginInstance>>>) as a
// `DeviceProcessor`, enabling external plugins to occupy the same
// `DeviceChain` slots as internal DSP effects.
//
// # Real-Time Safety
//
// Uses `parking_lot::Mutex::try_lock()` — never blocks the audio thread.
// If the lock is contended (UI thread holding it for state save/editor),
// audio passes through unmodified and `ProcessResult::Skipped` is returned.
//
// # Memory
//
// Per-slot scratch buffers are pre-allocated at construction time.
// Processing is zero-alloc on the hot path.
//
// ═══════════════════════════════════════════════════════════════════════════

use uuid::Uuid;

use dream_dsp::device_slot::{DeviceKind, DeviceProcessor, ProcessContext, ProcessResult};
use dream_plugins::instance::{MidiEvent, TransportContext};
use dream_plugins::vst3::plugin_host::PluginInstanceArc;

use crate::render_callback::MAX_BUFFER_FRAMES;

/// A device slot wrapping an external plugin (VST3, CLAP, AudioUnit).
///
/// Implements `DeviceProcessor` so it can be placed in any `DeviceChain`
/// alongside internal effects. The audio callback does not need to know
/// that this is an external plugin — it just calls `.process()`.
///
/// # Thread Safety
///
/// The inner `PluginInstanceArc` is protected by a `parking_lot::Mutex`.
/// On the audio thread, we use `try_lock()` to avoid blocking. If the
/// mutex is contended (e.g., UI thread saving plugin state), the slot
/// returns `ProcessResult::Skipped` and audio passes through unmodified.
pub struct ExternalDeviceSlot {
    /// The plugin instance (shared with UI thread via Arc).
    instance: PluginInstanceArc,
    /// Unique instance ID (matches the slot in the project model).
    instance_id: Uuid,
    /// Whether this is an instrument (vs effect).
    is_instrument: bool,
    /// Whether this slot is bypassed.
    bypassed: bool,
    /// Pre-allocated input buffers for plugin I/O format conversion.
    /// Plugins expect `&[&[f32]]` / `&mut [&mut [f32]]`, not in-place.
    input_left: Vec<f32>,
    input_right: Vec<f32>,
    /// Pre-allocated output buffers.
    output_left: Vec<f32>,
    output_right: Vec<f32>,
    /// Pre-allocated sidechain input buffers.
    sc_left: Vec<f32>,
    sc_right: Vec<f32>,
    /// MIDI events for this processing call.
    midi_events: Vec<MidiEvent>,
    /// Pending parameter updates queued by the RT thread.
    pending_params: Vec<(u32, f32)>,
}

impl ExternalDeviceSlot {
    /// Creates a new external device slot.
    ///
    /// # Arguments
    /// - `instance`: The loaded and activated plugin instance (Arc<Mutex>).
    /// - `instance_id`: UUID matching the project model's `PluginSlot.id`.
    /// - `is_instrument`: True if this is an instrument (Serum, Vital, etc.).
    pub fn new(instance: PluginInstanceArc, instance_id: Uuid, is_instrument: bool) -> Self {
        Self {
            instance,
            instance_id,
            is_instrument,
            bypassed: false,
            input_left: vec![0.0; MAX_BUFFER_FRAMES],
            input_right: vec![0.0; MAX_BUFFER_FRAMES],
            output_left: vec![0.0; MAX_BUFFER_FRAMES],
            output_right: vec![0.0; MAX_BUFFER_FRAMES],
            sc_left: vec![0.0; MAX_BUFFER_FRAMES],
            sc_right: vec![0.0; MAX_BUFFER_FRAMES],
            midi_events: Vec::with_capacity(256),
            pending_params: Vec::with_capacity(128),
        }
    }

    /// Returns the plugin instance ID.
    pub fn instance_id(&self) -> Uuid {
        self.instance_id
    }

    /// Returns a reference to the inner plugin instance Arc.
    pub fn instance_arc(&self) -> &PluginInstanceArc {
        &self.instance
    }

    /// Returns whether this is an instrument slot.
    pub fn is_instrument(&self) -> bool {
        self.is_instrument
    }

    /// Enqueues a MIDI event for the next process() call.
    ///
    /// Called from the audio thread command dispatch for RT MIDI
    /// (preview notes, piano roll playback).
    pub fn enqueue_midi(&mut self, event: MidiEvent) {
        if self.midi_events.len() < 256 {
            self.midi_events.push(event);
        }
    }

    /// Clears all pending MIDI events.
    pub fn clear_midi(&mut self) {
        self.midi_events.clear();
    }
}

impl DeviceProcessor for ExternalDeviceSlot {
    #[inline]
    fn process(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        sidechain_left: Option<&[f32]>,
        sidechain_right: Option<&[f32]>,
        context: &ProcessContext,
    ) -> ProcessResult {
        if self.bypassed {
            self.midi_events.clear();
            return ProcessResult::Processed;
        }

        let n = left.len().min(right.len()).min(MAX_BUFFER_FRAMES);

        // Try to acquire the plugin mutex without blocking.
        let Some(mut plugin) = self.instance.try_lock() else {
            // Mutex contended — passthrough. Audio remains unmodified.
            // DO NOT clear midi_events or pending_params, they will apply on the next successful block
            return ProcessResult::Skipped;
        };

        // Flush pending parameter updates
        for (index, value) in self.pending_params.drain(..) {
            let _ = plugin.set_parameter(index, value as f64);
        }

        // Set transport context for this buffer.
        plugin.set_transport_context(TransportContext {
            sample_rate: context.sample_rate as f64,
            position_samples: context.playhead_frames,
            tempo: context.tempo,
            is_playing: context.is_playing || self.is_instrument,
            is_recording: false,
            time_sig_numerator: context.time_sig_numerator as i32,
            time_sig_denominator: context.time_sig_denominator as i32,
            cycle_active: false,
            loop_start_samples: 0,
            loop_end_samples: 0,
        });

        // Copy input into scratch buffers (plugins read from separate input bufs).
        self.input_left[..n].copy_from_slice(&left[..n]);
        self.input_right[..n].copy_from_slice(&right[..n]);

        // Clear output buffers.
        self.output_left[..n].fill(0.0);
        self.output_right[..n].fill(0.0);

        // Prepare sidechain buffers if provided.
        // BUF-012 FIX: Sidechain length MUST match main buffer length `n`.
        // Previously, sc_n could be < n, causing the plugin to read stale
        // data beyond the sidechain buffer end.
        let has_sidechain = sidechain_left.is_some() && sidechain_right.is_some();
        if let (Some(sc_l), Some(sc_r)) = (sidechain_left, sidechain_right) {
            let avail = n.min(sc_l.len()).min(sc_r.len());
            self.sc_left[..avail].copy_from_slice(&sc_l[..avail]);
            self.sc_right[..avail].copy_from_slice(&sc_r[..avail]);
            // Zero-fill remainder so plugin never reads stale data.
            if avail < n {
                self.sc_left[avail..n].fill(0.0);
                self.sc_right[avail..n].fill(0.0);
            }
        } else {
            self.sc_left[..n].fill(0.0);
            self.sc_right[..n].fill(0.0);
        }

        // Build sidechain input slices (must outlive the process call).
        // BUF-012: Sidechain buffers are now always `n` frames, matching main input.
        let sc_slices: [&[f32]; 2] = [&self.sc_left[..n], &self.sc_right[..n]];
        let sidechain: Option<&[&[f32]]> = if has_sidechain {
            Some(&sc_slices)
        } else {
            None
        };

        // Build plugin I/O slices.
        let inputs: &[&[f32]] = &[&self.input_left[..n], &self.input_right[..n]];
        let out_l = &mut self.output_left[..n];
        let out_r = &mut self.output_right[..n];
        let mut outputs: [&mut [f32]; 2] = [out_l, out_r];

        let result = plugin.process_with_sidechain(
            inputs,
            sidechain,
            &mut outputs,
            n,
            &self.midi_events,
        );

        // Clear MIDI events after processing.
        self.midi_events.clear();

        match result {
            Ok(()) => {
                // NaN/Inf sanitization — prevent poisoned signal from propagating.
                for i in 0..n {
                    let ol = self.output_left[i];
                    let or = self.output_right[i];
                    left[i] = if ol.is_finite() { ol } else { 0.0 };
                    right[i] = if or.is_finite() { or } else { 0.0 };
                }
                ProcessResult::Processed
            }
            Err(_) => {
                // Plugin returned error — passthrough original audio.
                ProcessResult::Skipped
            }
        }
    }

    fn set_param(&mut self, index: u32, value: f32) {
        // Instead of try_lock, queue param values so they aren't lost if UI holds lock
        if self.pending_params.len() < 1024 {
            self.pending_params.push((index, value));
        }
    }

    fn reset(&mut self) {
        if let Some(mut plugin) = self.instance.try_lock() {
            plugin.reset();
        }
        self.midi_events.clear();
    }

    fn latency_samples(&self) -> usize {
        self.instance
            .try_lock()
            .map(|p| p.latency_samples() as usize)
            .unwrap_or(0)
    }

    fn device_kind(&self) -> DeviceKind {
        if self.is_instrument {
            DeviceKind::ExternalInstrument
        } else {
            DeviceKind::ExternalPlugin
        }
    }

    fn is_bypassed(&self) -> bool {
        self.bypassed
    }

    fn set_bypass(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }
}
