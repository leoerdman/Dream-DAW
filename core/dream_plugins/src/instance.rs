// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Plugin Instance Trait
// ═══════════════════════════════════════════════════════════════════════════
//
// Format-agnostic trait for loaded plugin instances.
// Concrete implementations will wrap VST3/CLAP/AU APIs.
//
// ═══════════════════════════════════════════════════════════════════════════

use uuid::Uuid;

use crate::descriptor::PluginDescriptor;

/// Errors that can occur during plugin operations.
#[derive(Debug)]
pub enum PluginError {
    /// Plugin binary could not be loaded.
    LoadFailed(String),

    /// Plugin failed during initialization.
    InitFailed(String),

    /// Plugin processing produced an error.
    ProcessError(String),

    /// Plugin format is not supported on this platform.
    UnsupportedFormat(String),

    /// Plugin returned an unexpected state.
    InvalidState(String),
}

impl std::fmt::Display for PluginError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LoadFailed(e) => write!(f, "Plugin load failed: {e}"),
            Self::InitFailed(e) => write!(f, "Plugin init failed: {e}"),
            Self::ProcessError(e) => write!(f, "Plugin process error: {e}"),
            Self::UnsupportedFormat(e) => write!(f, "Unsupported format: {e}"),
            Self::InvalidState(e) => write!(f, "Invalid plugin state: {e}"),
        }
    }
}

impl std::error::Error for PluginError {}

/// Transport context passed to plugins before each process() call.
///
/// Contains the minimum set of host state that VST3/CLAP/AU plugins need
/// to synchronize with the DAW's transport (tempo, position, play state).
///
/// This is a lightweight, Copy struct — safe to pass on the audio thread.
#[derive(Debug, Clone, Copy)]
pub struct TransportContext {
    /// Current sample rate (Hz).
    pub sample_rate: f64,
    /// Current playhead position in sample frames (absolute).
    pub position_samples: i64,
    /// Current project tempo in BPM.
    pub tempo: f64,
    /// Whether playback is active.
    pub is_playing: bool,
    /// Whether recording is active.
    pub is_recording: bool,
    /// BUG-A7 FIX: Time signature numerator (e.g., 3 for 3/4). Default: 4.
    pub time_sig_numerator: i32,
    /// BUG-A7 FIX: Time signature denominator (e.g., 4 for 3/4). Default: 4.
    pub time_sig_denominator: i32,
}

impl Default for TransportContext {
    fn default() -> Self {
        Self {
            sample_rate: 44100.0,
            position_samples: 0,
            tempo: 120.0,
            is_playing: false,
            is_recording: false,
            time_sig_numerator: 4,
            time_sig_denominator: 4,
        }
    }
}

/// A single MIDI event for plugin processing.
///
/// Lightweight, Copy struct — safe for the audio thread.
/// Sample offset is relative to the start of the current buffer.
///
/// # Encoding
///
/// The `data` field carries raw MIDI status + data bytes:
///   - Note On:  `[0x90 | channel, note, velocity]`
///   - Note Off: `[0x80 | channel, note, velocity]`
///   - CC:       `[0xB0 | channel, cc_number, cc_value]`
///   - Pitch Bend: `[0xE0 | channel, lsb, msb]`
///
/// The `channel` field is redundant with the low nibble of `data[0]`
/// but provided for convenience / zero-cost filtering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MidiEvent {
    /// Sample offset within the current buffer (0-based).
    pub sample_offset: i32,
    /// MIDI channel (0–15).
    pub channel: u8,
    /// Raw MIDI status + data bytes (up to 3 bytes for channel messages).
    pub data: [u8; 3],
}

impl MidiEvent {
    /// Creates a Note On event.
    #[inline]
    pub fn note_on(sample_offset: i32, channel: u8, note: u8, velocity: u8) -> Self {
        Self {
            sample_offset,
            channel: channel & 0x0F,
            data: [0x90 | (channel & 0x0F), note & 0x7F, velocity & 0x7F],
        }
    }

    /// Creates a Note Off event.
    #[inline]
    pub fn note_off(sample_offset: i32, channel: u8, note: u8, velocity: u8) -> Self {
        Self {
            sample_offset,
            channel: channel & 0x0F,
            data: [0x80 | (channel & 0x0F), note & 0x7F, velocity & 0x7F],
        }
    }

    /// Creates a Control Change event.
    #[inline]
    pub fn cc(sample_offset: i32, channel: u8, cc_number: u8, cc_value: u8) -> Self {
        Self {
            sample_offset,
            channel: channel & 0x0F,
            data: [0xB0 | (channel & 0x0F), cc_number & 0x7F, cc_value & 0x7F],
        }
    }

    /// Returns `true` if this is a Note On event (status 0x9X with velocity > 0).
    #[inline]
    pub fn is_note_on(&self) -> bool {
        (self.data[0] & 0xF0) == 0x90 && self.data[2] > 0
    }

    /// Returns `true` if this is a Note Off event (status 0x8X, or 0x9X with velocity 0).
    #[inline]
    pub fn is_note_off(&self) -> bool {
        (self.data[0] & 0xF0) == 0x80 || ((self.data[0] & 0xF0) == 0x90 && self.data[2] == 0)
    }

    /// Returns the MIDI note number (0–127) for note-on/note-off events.
    #[inline]
    pub fn note(&self) -> u8 {
        self.data[1]
    }

    /// Returns the velocity (0–127) for note-on/note-off events.
    #[inline]
    pub fn velocity(&self) -> u8 {
        self.data[2]
    }
}

/// Format-agnostic interface for a loaded plugin instance.
///
/// Each concrete implementation wraps a specific plugin API:
///   - `Vst3Instance` (future)
///   - `ClapInstance` (future)
///   - `AudioUnitInstance` (future, macOS only)
///
/// Instances are created on the UI thread and process audio on the
/// audio thread. The trait enforces `Send` to support this pattern.
///
/// # Real-Time Safety
///
/// The `process` method MUST be real-time-safe:
///   - No allocations
///   - No locks
///   - No I/O
///   - No syscalls
///   - Bounded execution time
pub trait PluginInstance: Send {
    /// Unique instance ID (matches the slot on the track).
    fn id(&self) -> Uuid;

    /// Returns the plugin descriptor (static metadata).
    fn descriptor(&self) -> &PluginDescriptor;

    /// Initializes the plugin with the given sample rate and buffer size.
    ///
    /// Called once before processing begins. Not real-time-safe.
    fn activate(&mut self, sample_rate: f64, max_buffer_size: usize) -> Result<(), PluginError>;

    /// Deactivates the plugin. Called when removing or reconfiguring.
    ///
    /// Not real-time-safe.
    fn deactivate(&mut self) -> Result<(), PluginError>;

    /// Processes audio buffers in-place with optional MIDI events.
    ///
    /// # Real-Time Safety
    /// This method MUST be real-time-safe. It runs on the audio thread.
    ///
    /// # Arguments
    /// - `inputs`: Read-only input audio buffers (one per channel).
    /// - `outputs`: Mutable output audio buffers (one per channel).
    /// - `num_frames`: Number of frames to process.
    /// - `midi_events`: MIDI events for this buffer, sorted by `sample_offset`.
    ///   Empty slice for audio-only processing.
    fn process(
        &mut self,
        inputs: &[&[f32]],
        outputs: &mut [&mut [f32]],
        num_frames: usize,
        midi_events: &[MidiEvent],
    ) -> Result<(), PluginError>;

    /// Processes audio with an optional dedicated sidechain input bus.
    ///
    /// `main_inputs` represent the primary input bus (typically stereo).
    /// `sidechain_inputs`, when provided, represent the auxiliary sidechain bus.
    ///
    /// Default behavior ignores sidechain and delegates to `process`.
    fn process_with_sidechain(
        &mut self,
        main_inputs: &[&[f32]],
        sidechain_inputs: Option<&[&[f32]]>,
        outputs: &mut [&mut [f32]],
        num_frames: usize,
        midi_events: &[MidiEvent],
    ) -> Result<(), PluginError> {
        let _ = sidechain_inputs;
        self.process(main_inputs, outputs, num_frames, midi_events)
    }

    /// Returns the plugin's processing latency in samples.
    ///
    /// Used by the PDC engine to compensate parallel paths.
    fn latency_samples(&self) -> u32;

    /// Returns the plugin's tail length in samples.
    ///
    /// Used to determine how long to render after playback stops
    /// (e.g., reverb tail).
    fn tail_samples(&self) -> u32 {
        0
    }

    /// Resets the plugin's internal state (clear delay lines, etc.).
    ///
    /// Called when transport is repositioned or on loop boundaries.
    fn reset(&mut self);

    /// Sets the transport context for the next process() call.
    ///
    /// Called once per buffer, before process(). The plugin can use this
    /// to populate format-specific process context structs (e.g. VST3
    /// ProcessContext, CLAP transport).
    ///
    /// Default implementation is a no-op — built-in effects ignore this.
    ///
    /// # Real-Time Safety
    /// This method MUST be real-time-safe (no allocations, just copy a struct).
    fn set_transport_context(&mut self, _ctx: TransportContext) {
        // No-op by default — built-in DSP doesn't need transport info.
    }

    /// Whether the plugin is currently activated.
    fn is_active(&self) -> bool;

    /// Returns the number of parameters exposed by the plugin.
    fn parameter_count(&self) -> u32 {
        0
    }

    /// Gets the current value of a parameter by index.
    fn get_parameter(&self, _index: u32) -> Option<f64> {
        None
    }

    /// Sets the value of a parameter by index.
    ///
    /// This should enqueue a parameter change for the next process call,
    /// NOT apply it immediately (to maintain real-time safety).
    fn set_parameter(&mut self, _index: u32, _value: f64) -> Result<(), PluginError> {
        Err(PluginError::InvalidState(
            "Parameters not supported".to_string(),
        ))
    }

    /// Loads serialized plugin state/preset data.
    ///
    /// `kind` is an optional source hint (e.g. `ProcessorState`, `Chunk`).
    /// The default implementation reports unsupported.
    fn load_state_blob(&mut self, _kind: Option<&str>, _data: &[u8]) -> Result<(), PluginError> {
        Err(PluginError::UnsupportedFormat(
            "Plugin state restore is not supported for this instance".to_string(),
        ))
    }

    /// Opens the plugin editor window (native GUI), if supported.
    ///
    /// Called from the UI thread. Implementations may return an error
    /// when the format or backend does not yet provide editor hosting.
    fn open_editor(&mut self) -> Result<(), PluginError> {
        Err(PluginError::UnsupportedFormat(
            "Plugin editor window is not supported for this instance".to_string(),
        ))
    }

    /// Closes the plugin editor window, if currently open.
    fn close_editor(&mut self) -> Result<(), PluginError> {
        Err(PluginError::UnsupportedFormat(
            "Plugin editor window is not supported for this instance".to_string(),
        ))
    }

    /// Reports whether this instance can open a native plugin editor.
    fn supports_editor(&self) -> bool {
        false
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_error_display() {
        let err = PluginError::LoadFailed("missing binary".to_string());
        assert_eq!(format!("{err}"), "Plugin load failed: missing binary");
    }

    #[test]
    fn plugin_error_variants() {
        // Just verify all variants can be constructed
        let _ = PluginError::LoadFailed("a".into());
        let _ = PluginError::InitFailed("b".into());
        let _ = PluginError::ProcessError("c".into());
        let _ = PluginError::UnsupportedFormat("d".into());
        let _ = PluginError::InvalidState("e".into());
    }
}
