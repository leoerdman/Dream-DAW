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
    /// Whether to include an effect tail after the selected region.
    /// When true, the renderer auto-detects reverb/delay FX and renders
    /// until they decay. When false, output is cut exactly at the region end.
    pub include_tail: bool,
    /// Output format: "wav" or "mp3". Defaults to "wav" if unset.
    pub format: String,
    /// The project's internal sample rate (Hz).
    /// Clip positions and durations are stored in this domain.
    pub project_sample_rate: f64,
    /// Project tempo in BPM. Used for VST3 transport context.
    pub bpm: f64,
}

impl BounceConfig {
    /// Total frames to render (content only, without tail).
    /// Tail frames are computed dynamically by the renderer based on
    /// FX detection when `include_tail` is true.
    pub fn total_frames(&self) -> i64 {
        self.end_frame - self.start_frame
    }
}

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
