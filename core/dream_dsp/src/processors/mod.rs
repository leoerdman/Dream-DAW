// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Built-in DSP Processors Module
// ═══════════════════════════════════════════════════════════════════════════

pub(crate) const DEFAULT_SAMPLE_RATE: f32 = 44_100.0;
pub(crate) const MIN_VALID_SAMPLE_RATE: f32 = 1_000.0;
pub(crate) const LN10_OVER_20: f32 = 0.115_129_25;

#[inline]
pub(crate) fn sanitize_sample_rate(sample_rate: f32) -> f32 {
    if sample_rate.is_finite() && sample_rate > MIN_VALID_SAMPLE_RATE {
        sample_rate
    } else {
        DEFAULT_SAMPLE_RATE
    }
}

#[inline]
pub(crate) fn db_to_linear(db: f32) -> f32 {
    (db * LN10_OVER_20).exp()
}

pub mod chorus;
pub mod compressor;
pub mod delay;
pub mod eq;
pub mod reverb;
pub mod saturator;
pub mod smoothing;
pub mod utility;
// Wave 1 — Essential Effects
pub mod analyzer;
pub mod auto_filter;
pub mod auto_pan;
pub mod bitcrusher;
pub mod distortion;
pub mod flanger;
pub mod gate;
pub mod limiter;
pub mod noise_machine;
pub mod phaser;
