// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Viewport / Projection Utilities
// ═══════════════════════════════════════════════════════════════════════════
//
// Manages the 2D viewport state for timeline rendering:
//   - Pixel ↔ sample frame conversion
//   - Zoom level (samples per pixel, SPP)
//   - Scroll position
//   - Visible range calculation (for clip culling)
//
// ═══════════════════════════════════════════════════════════════════════════

/// 2D viewport state for the DAW timeline.
///
/// Maps between screen pixels and audio sample frames.
/// The viewport is the "camera" into the arrangement — it defines
/// what portion of the timeline is visible.
#[derive(Debug, Clone)]
pub struct Viewport {
    /// Width of the viewport in pixels.
    pub width: f32,

    /// Height of the viewport in pixels.
    pub height: f32,

    /// Horizontal scroll position in sample frames.
    /// This is the leftmost visible sample frame.
    pub scroll_x: i64,

    /// Vertical scroll position in pixels.
    /// This is the topmost visible pixel (track offset).
    pub scroll_y: f32,

    /// Zoom level: number of sample frames per pixel.
    /// Lower SPP = more zoomed in.
    /// Typical range: 1 (max zoom) to 100_000+ (fully zoomed out).
    pub samples_per_pixel: f64,
}

impl Viewport {
    /// Creates a new viewport with default zoom.
    pub fn new(width: f32, height: f32) -> Self {
        Self {
            width,
            height,
            scroll_x: 0,
            scroll_y: 0.0,
            // Default: ~220 samples per pixel at 44.1kHz ≈ 5ms per pixel ≈ shows ~10s of audio
            samples_per_pixel: 220.0,
        }
    }

    /// Returns the sample frame range currently visible in the viewport.
    pub fn visible_sample_range(&self) -> (i64, i64) {
        let start = self.scroll_x;
        let end = start + (self.width as f64 * self.samples_per_pixel) as i64;
        (start, end)
    }

    /// Converts a sample frame position to a screen X coordinate.
    pub fn sample_to_x(&self, sample_frame: i64) -> f32 {
        ((sample_frame - self.scroll_x) as f64 / self.samples_per_pixel) as f32
    }

    /// Converts a screen X coordinate to a sample frame position.
    pub fn x_to_sample(&self, x: f32) -> i64 {
        self.scroll_x + (x as f64 * self.samples_per_pixel) as i64
    }

    /// Converts a duration in sample frames to a pixel width.
    pub fn sample_duration_to_width(&self, duration_samples: i64) -> f32 {
        (duration_samples as f64 / self.samples_per_pixel) as f32
    }

    /// Zooms in/out by a factor around a focal point (screen X coordinate).
    ///
    /// `zoom_factor` > 1.0 = zoom in, < 1.0 = zoom out.
    /// The focal point remains at the same screen position after zoom.
    pub fn zoom(&mut self, zoom_factor: f64, focal_x: f32) {
        let focal_sample = self.x_to_sample(focal_x);
        self.samples_per_pixel /= zoom_factor;

        // Clamp SPP to reasonable range
        self.samples_per_pixel = self.samples_per_pixel.clamp(1.0, 500_000.0);

        // Adjust scroll so the focal point stays at the same screen position
        self.scroll_x = focal_sample - (focal_x as f64 * self.samples_per_pixel) as i64;
        if self.scroll_x < 0 {
            self.scroll_x = 0;
        }
    }

    /// Scrolls horizontally by a delta in pixels.
    pub fn scroll_horizontal(&mut self, delta_pixels: f32) {
        let delta_samples = (delta_pixels as f64 * self.samples_per_pixel) as i64;
        self.scroll_x = (self.scroll_x + delta_samples).max(0);
    }

    /// Scrolls vertically by a delta in pixels.
    pub fn scroll_vertical(&mut self, delta_pixels: f32) {
        self.scroll_y = (self.scroll_y + delta_pixels).max(0.0);
    }

    /// Total visible duration in seconds at the given sample rate.
    pub fn visible_duration_seconds(&self, sample_rate: f64) -> f64 {
        (self.width as f64 * self.samples_per_pixel) / sample_rate
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_viewport() {
        let vp = Viewport::new(1400.0, 900.0);
        assert_eq!(vp.width, 1400.0);
        assert_eq!(vp.height, 900.0);
        assert_eq!(vp.scroll_x, 0);
        assert_eq!(vp.samples_per_pixel, 220.0);
    }

    #[test]
    fn sample_pixel_conversion_roundtrips() {
        let vp = Viewport::new(1400.0, 900.0);
        let sample = 44100_i64;
        let x = vp.sample_to_x(sample);
        let back = vp.x_to_sample(x);
        // Should be approximately equal (rounding)
        assert!((sample - back).abs() < 2);
    }

    #[test]
    fn visible_range_at_default_zoom() {
        let vp = Viewport::new(1400.0, 900.0);
        let (start, end) = vp.visible_sample_range();
        assert_eq!(start, 0);
        // 1400 * 220 = 308000 samples ≈ 7s at 44.1kHz
        assert_eq!(end, 308000);
    }

    #[test]
    fn zoom_in_clamps_spp() {
        let mut vp = Viewport::new(1400.0, 900.0);
        // Zoom in extensively
        for _ in 0..100 {
            vp.zoom(2.0, 700.0);
        }
        assert!(vp.samples_per_pixel >= 1.0);
    }

    #[test]
    fn zoom_out_clamps_spp() {
        let mut vp = Viewport::new(1400.0, 900.0);
        // Zoom out extensively
        for _ in 0..100 {
            vp.zoom(0.5, 700.0);
        }
        assert!(vp.samples_per_pixel <= 500_000.0);
    }

    #[test]
    fn horizontal_scroll_cannot_go_negative() {
        let mut vp = Viewport::new(1400.0, 900.0);
        vp.scroll_horizontal(-10000.0);
        assert!(vp.scroll_x >= 0);
    }

    #[test]
    fn visible_duration_is_correct() {
        let vp = Viewport::new(1000.0, 900.0);
        let duration = vp.visible_duration_seconds(44100.0);
        // 1000 pixels * 220 spp / 44100 Hz ≈ 4.99 seconds
        assert!((duration - 4.99).abs() < 0.1);
    }
}
