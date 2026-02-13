import Foundation
import simd
import DreamDAWModels

// MARK: - ViewportMatrix

/// The mathematical core of the arrangement viewport.
///
/// Replaces the old `pixelsPerBeat + NSScrollView.scrollOffset` system with a
/// sample-based coordinate matrix. All positions are computed relative to the
/// left edge of the screen, so GPU coordinates stay small (no Float32 overflow
/// at extreme zoom levels).
///
/// **Key Properties**:
/// - `visibleStartSample`: The sample frame at the left edge of the viewport
/// - `samplesPerPixel`: The zoom level (lower = more zoomed in)
///
/// **Anchor Zoom**: `applyAnchorZoom()` keeps the sample under the mouse cursor
/// stationary while changing zoom level — zero jitter, zero drift.
public struct ViewportMatrix: Sendable {

    // MARK: - Properties

    /// The sample frame at the left edge of the visible viewport.
    public var visibleStartSample: Double = 0

    /// Zoom level: how many audio samples correspond to one screen pixel.
    /// Lower = more zoomed in. Higher = more zoomed out.
    ///
    /// Reference values (at 44100 Hz):
    /// - `1.0` = maximum zoom (sub-sample level)
    /// - `441.0` = ~100 pixels per second (moderate zoom)
    /// - `44100.0` = 1 pixel per second (1x)
    /// - `44100 * 3600` = 1 pixel per hour (maximum zoom out)
    public var samplesPerPixel: Double = 441.0

    /// The vertical scroll offset in pixels (top edge).
    public var visibleStartY: Double = 0

    /// The width of the viewport in pixels.
    public var viewportWidth: Double = 1258.0

    /// The height of the viewport in pixels.
    public var viewportHeight: Double = 800.0

    // MARK: - Zoom Limits

    /// Maximum zoom in: 0.01 samples per pixel (sub-sample editing).
    public static let minSamplesPerPixel: Double = 0.01

    /// Maximum zoom out: 1 pixel per hour at 44100 Hz.
    public static let maxSamplesPerPixel: Double = 44100.0 * 3600.0

    // MARK: - Initialization

    public init(
        visibleStartSample: Double = 0,
        samplesPerPixel: Double = 441.0,
        visibleStartY: Double = 0,
        viewportWidth: Double = 1258.0,
        viewportHeight: Double = 800.0
    ) {
        self.visibleStartSample = visibleStartSample
        self.samplesPerPixel = samplesPerPixel
        self.visibleStartY = visibleStartY
        self.viewportWidth = viewportWidth
        self.viewportHeight = viewportHeight
    }

    /// Creates a ViewportMatrix from the legacy pixelsPerBeat system.
    /// Useful during migration.
    public init(pixelsPerBeat: Double, scrollOffsetPixels: Double, bpm: Double, sampleRate: Double = 44100) {
        // pixelsPerBeat → samplesPerPixel conversion:
        // 1 beat = (60/bpm) seconds = (60/bpm) * sampleRate samples
        // 1 pixel = 1/pixelsPerBeat beats = (60/bpm/pixelsPerBeat) * sampleRate samples
        let samplesPerBeat = (60.0 / bpm) * sampleRate
        self.samplesPerPixel = samplesPerBeat / pixelsPerBeat
        self.visibleStartSample = scrollOffsetPixels * self.samplesPerPixel
    }

    // MARK: - Anchor Zoom (Pivot Zoom)

    /// Applies zoom centered on a specific pixel position (mouse cursor).
    /// The sample under `focalPixelX` remains at the same screen position after zoom.
    ///
    /// - Parameters:
    ///   - zoomFactor: Multiplier (> 1 zooms out, < 1 zooms in)
    ///   - focalPixelX: The X pixel position to anchor the zoom on
    public mutating func applyAnchorZoom(zoomFactor: Double, focalPixelX: Double) {
        // 1. Pin the sample under the cursor
        let sampleUnderCursor = visibleStartSample + (focalPixelX * samplesPerPixel)

        // 2. Apply new scale with hard limits
        let newSPP = (samplesPerPixel * zoomFactor)
            .clamped(to: Self.minSamplesPerPixel...Self.maxSamplesPerPixel)

        // 3. Shift viewport so the pinned sample stays under the cursor
        let newVisibleStart = sampleUnderCursor - (focalPixelX * newSPP)

        self.samplesPerPixel = newSPP
        self.visibleStartSample = max(0, newVisibleStart)
    }

    // MARK: - Coordinate Conversion (Sample ↔ Pixel)

    /// Converts a sample frame to a viewport-relative X pixel position.
    /// Result is always small (relative to screen), so Float32 is safe for Metal.
    @inlinable
    public func pixelX(for sampleFrame: Int64) -> Float {
        Float((Double(sampleFrame) - visibleStartSample) / samplesPerPixel)
    }

    /// Converts a viewport-relative X pixel to a sample frame.
    @inlinable
    public func sampleFrame(atPixelX pixelX: Double) -> Int64 {
        Int64(visibleStartSample + (pixelX * samplesPerPixel))
    }

    /// Converts a width in samples to a width in pixels.
    @inlinable
    public func pixelWidth(forSamples samples: Int64) -> Float {
        Float(Double(samples) / samplesPerPixel)
    }

    /// Converts a document-relative Y position to a viewport-relative Y pixel position.
    @inlinable
    public func pixelY(forDocumentY documentY: Float) -> Float {
        documentY - Float(visibleStartY)
    }

    // MARK: - Beat-Based Convenience (for Grid/UI)

    /// Converts a beat position to a viewport-relative pixel X using a PulseMap.
    @inlinable
    public func pixelX(forBeat beat: Double, pulseMap: PulseMap) -> Float {
        let sample = pulseMap.sampleFrame(at: beat)
        return pixelX(for: sample)
    }

    /// Converts a pixel X to a beat position using a PulseMap.
    @inlinable
    public func beat(atPixelX pixelX: Double, pulseMap: PulseMap) -> Double {
        let sample = sampleFrame(atPixelX: pixelX)
        return pulseMap.beats(at: sample)
    }

    // MARK: - Visible Range

    /// The sample frame at the right edge of the viewport.
    @inlinable
    public var visibleEndSample: Double {
        visibleStartSample + (viewportWidth * samplesPerPixel)
    }

    /// The visible range in sample frames.
    @inlinable
    public var visibleSampleRange: ClosedRange<Int64> {
        Int64(visibleStartSample)...Int64(visibleEndSample)
    }

    /// The visible range in beats (for culling clips).
    @inlinable
    public func visibleBeatRange(pulseMap: PulseMap) -> ClosedRange<Double> {
        let startBeat = pulseMap.beats(at: Int64(visibleStartSample))
        let endBeat = pulseMap.beats(at: Int64(visibleEndSample))
        return startBeat...endBeat
    }

    // MARK: - Scrolling

    /// Scrolls the viewport by a pixel delta.
    public mutating func scroll(deltaPixels: Double) {
        visibleStartSample = max(0, visibleStartSample + deltaPixels * samplesPerPixel)
    }

    /// Scrolls to a specific sample frame (left edge).
    public mutating func scrollTo(sample: Int64) {
        visibleStartSample = max(0, Double(sample))
    }

    // MARK: - Legacy Bridge

    /// Returns the equivalent `pixelsPerBeat` for legacy code compatibility.
    public func pixelsPerBeat(bpm: Double, sampleRate: Double = 44100) -> Double {
        let samplesPerBeat = (60.0 / bpm) * sampleRate
        return samplesPerBeat / samplesPerPixel
    }

    /// Returns the equivalent scroll offset in pixels for legacy code.
    public func scrollOffsetPixels() -> Double {
        visibleStartSample / samplesPerPixel
    }
}

// MARK: - Comparable Clamping Helper

extension Comparable {
    @inlinable
    func clamped(to range: ClosedRange<Self>) -> Self {
        min(max(self, range.lowerBound), range.upperBound)
    }
}
