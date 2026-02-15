// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — GPU Data Types
// ═══════════════════════════════════════════════════════════════════════════
//
// These structs are sent directly to the GPU via wgpu buffers.
// They MUST be #[repr(C)] and implement bytemuck::Pod for zero-copy upload.
//
// Layout mirrors the WGSL shader struct declarations exactly.
//
// ═══════════════════════════════════════════════════════════════════════════

use bytemuck::{Pod, Zeroable};

// ── Clip Instance (one per audio/MIDI clip on the timeline) ────────────

/// GPU-side data for a single clip instance.
///
/// Designed for instanced rendering: all clips are drawn in one draw call
/// by uploading an array of these structs to a storage buffer.
///
/// Matches the `ClipInstance` struct in `timeline.wgsl`.
#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct ClipInstance {
    /// Screen-space rect: [x, y, width, height] in pixels.
    pub rect: [f32; 4],

    /// Clip color: [r, g, b, a] normalized 0.0–1.0.
    pub color: [f32; 4],

    /// State flags:
    /// - x: isSelected (1.0 = selected)
    /// - y: isPhantom (1.0 = drag preview)
    /// - z: cornerRadius (pixels, default 5.0)
    /// - w: isMuted (1.0 = muted/grayed out)
    pub state_flags: [f32; 4],

    /// Offset into the waveform peaks buffer (-1 = no waveform data).
    pub waveform_offset: i32,

    /// Number of waveform peak samples for this clip.
    pub waveform_count: i32,

    /// 1.0 for MIDI clips, 0.0 for audio clips.
    pub is_midi: f32,

    /// Padding to align to 16-byte boundary.
    pub _padding: f32,
}

impl ClipInstance {
    /// Creates a new audio clip instance.
    pub fn audio(
        x: f32,
        y: f32,
        width: f32,
        height: f32,
        color: [f32; 4],
        waveform_offset: i32,
        waveform_count: i32,
    ) -> Self {
        Self {
            rect: [x, y, width, height],
            color,
            state_flags: [0.0, 0.0, 5.0, 0.0],
            waveform_offset,
            waveform_count,
            is_midi: 0.0,
            _padding: 0.0,
        }
    }

    /// Creates a new MIDI clip instance.
    pub fn midi(x: f32, y: f32, width: f32, height: f32, color: [f32; 4]) -> Self {
        Self {
            rect: [x, y, width, height],
            color,
            state_flags: [0.0, 0.0, 5.0, 0.0],
            waveform_offset: -1,
            waveform_count: 0,
            is_midi: 1.0,
            _padding: 0.0,
        }
    }

    /// Marks this clip as selected.
    pub fn with_selected(mut self, selected: bool) -> Self {
        self.state_flags[0] = if selected { 1.0 } else { 0.0 };
        self
    }

    /// Marks this clip as a phantom (drag preview).
    pub fn with_phantom(mut self, phantom: bool) -> Self {
        self.state_flags[1] = if phantom { 1.0 } else { 0.0 };
        self
    }

    /// Marks this clip as muted.
    pub fn with_muted(mut self, muted: bool) -> Self {
        self.state_flags[3] = if muted { 1.0 } else { 0.0 };
        self
    }
}

// ── MIDI Note Instance ────────────────────────────────────────────────

/// GPU-side data for a single MIDI note in the piano roll.
#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct MidiNoteInstance {
    /// Screen-space rect: [x, y, width, height] in pixels.
    pub rect: [f32; 4],

    /// Note color: [r, g, b, a] normalized 0.0–1.0.
    pub color: [f32; 4],

    /// State flags:
    /// - x: noteType (1.0 = note)
    /// - y: isSelected (1.0 = selected)
    /// - z, w: reserved
    pub state_flags: [f32; 4],
}

// ── Viewport Uniforms ─────────────────────────────────────────────────

/// Uniforms passed to the vertex shader for viewport transformation.
#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct ViewportUniforms {
    /// Viewport dimensions: [width, height, 0, 0].
    pub viewport_size: [f32; 4],
}

// ── Waveform Peak Data ────────────────────────────────────────────────

/// Manages waveform peak data for GPU upload.
///
/// Peak data is stored as a flat f32 array. Each clip references a
/// sub-range via `waveform_offset` and `waveform_count`.
///
/// This is designed for bulk upload: all clips' peaks are concatenated
/// into a single GPU buffer, and each clip indexes into it.
#[derive(Debug, Clone, Default)]
pub struct WaveformPeakBuffer {
    /// Flat array of peak values (amplitude 0.0–1.0).
    pub peaks: Vec<f32>,
}

impl WaveformPeakBuffer {
    /// Creates a new empty peak buffer.
    pub fn new() -> Self {
        Self { peaks: Vec::new() }
    }

    /// Creates a peak buffer with pre-allocated capacity.
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            peaks: Vec::with_capacity(capacity),
        }
    }

    /// Appends peak data for a clip. Returns the (offset, count) to use
    /// in the `ClipInstance`.
    pub fn push_peaks(&mut self, peaks: &[f32]) -> (i32, i32) {
        let offset = self.peaks.len() as i32;
        let count = peaks.len() as i32;
        self.peaks.extend_from_slice(peaks);
        (offset, count)
    }

    /// Resets the buffer for a new frame.
    pub fn clear(&mut self) {
        self.peaks.clear();
    }

    /// Returns the raw peak data as bytes for GPU upload.
    pub fn as_bytes(&self) -> &[u8] {
        bytemuck::cast_slice(&self.peaks)
    }

    /// Total number of peak samples in the buffer.
    pub fn len(&self) -> usize {
        self.peaks.len()
    }

    /// Whether the buffer is empty.
    pub fn is_empty(&self) -> bool {
        self.peaks.is_empty()
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_instance_size_is_correct() {
        // Must be a multiple of 16 bytes for GPU alignment
        assert_eq!(
            std::mem::size_of::<ClipInstance>() % 16,
            0,
            "ClipInstance must be 16-byte aligned"
        );
    }

    #[test]
    fn clip_instance_is_pod() {
        // Verify Pod trait is satisfied (no padding issues)
        let clip = ClipInstance::audio(10.0, 20.0, 200.0, 80.0, [0.3, 0.5, 0.8, 1.0], 0, 512);
        let bytes = bytemuck::bytes_of(&clip);
        assert!(!bytes.is_empty());
    }

    #[test]
    fn clip_builder_methods() {
        let clip = ClipInstance::audio(0.0, 0.0, 100.0, 50.0, [1.0; 4], -1, 0)
            .with_selected(true)
            .with_phantom(false)
            .with_muted(true);

        assert_eq!(clip.state_flags[0], 1.0); // selected
        assert_eq!(clip.state_flags[1], 0.0); // not phantom
        assert_eq!(clip.state_flags[3], 1.0); // muted
    }

    #[test]
    fn midi_clip_defaults() {
        let clip = ClipInstance::midi(0.0, 0.0, 100.0, 50.0, [0.0, 1.0, 0.5, 1.0]);
        assert_eq!(clip.is_midi, 1.0);
        assert_eq!(clip.waveform_offset, -1);
        assert_eq!(clip.waveform_count, 0);
    }

    #[test]
    fn waveform_peak_buffer_operations() {
        let mut buf = WaveformPeakBuffer::new();
        assert!(buf.is_empty());

        let peaks_a = vec![0.1, 0.5, 0.8, 0.3, 0.2];
        let (offset_a, count_a) = buf.push_peaks(&peaks_a);
        assert_eq!(offset_a, 0);
        assert_eq!(count_a, 5);
        assert_eq!(buf.len(), 5);

        let peaks_b = vec![0.9, 0.4, 0.6];
        let (offset_b, count_b) = buf.push_peaks(&peaks_b);
        assert_eq!(offset_b, 5);
        assert_eq!(count_b, 3);
        assert_eq!(buf.len(), 8);

        // Verify bytes are correct size
        assert_eq!(buf.as_bytes().len(), 8 * std::mem::size_of::<f32>());

        buf.clear();
        assert!(buf.is_empty());
    }

    #[test]
    fn midi_note_instance_size_is_aligned() {
        assert_eq!(
            std::mem::size_of::<MidiNoteInstance>() % 16,
            0,
            "MidiNoteInstance must be 16-byte aligned"
        );
    }

    #[test]
    fn viewport_uniforms_size() {
        assert_eq!(
            std::mem::size_of::<ViewportUniforms>(),
            16,
            "ViewportUniforms must be exactly 16 bytes"
        );
    }
}
