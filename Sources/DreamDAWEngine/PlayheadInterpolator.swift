import Foundation
import os

// MARK: - PlayheadInterpolator

/// Zero-jitter playhead position interpolator for 120 FPS Metal rendering.
///
/// **Problem**: `AVAudioEngine` delivers position updates every ~11ms (buffer callback),
/// but the screen refreshes every ~8.3ms (120Hz ProMotion). This mismatch causes the
/// playhead to "jump" between frames, creating visible jitter.
///
/// **Solution**: Use `mach_absolute_time()` to extrapolate the playhead position between
/// audio callbacks. The audio thread periodically "anchors" the true position, and the
/// render thread smoothly interpolates between anchors using the system's monotonic clock.
///
/// **Thread Safety**: The anchor is written from the audio callback thread and read from
/// the Metal render thread. We use an atomic-style double-buffered approach with `os_unfair_lock`
/// to guarantee tear-free reads.
///
/// **Usage**:
/// ```swift
/// // Audio thread (every ~11ms):
/// interpolator.anchorUpdate(sampleFrame: engine.currentSampleFrame)
///
/// // Metal render thread (every ~8.3ms):
/// let visualSample = interpolator.currentVisualSample()
/// let playheadX = Float(visualSample / viewport.samplesPerPixel)
/// ```
public final class PlayheadInterpolator: @unchecked Sendable {

    // MARK: - State

    /// The last confirmed sample frame from the audio engine.
    private var anchorSampleFrame: Int64 = 0

    /// The `mach_absolute_time()` at which `anchorSampleFrame` was recorded.
    private var anchorMachTime: UInt64 = 0

    /// Whether playback is active (interpolation is only meaningful during playback).
    private var isPlaying: Bool = false

    /// Cached mach timebase info for nanosecond conversion.
    private let timebaseNumer: UInt64
    private let timebaseDenom: UInt64

    /// Audio sample rate for time→sample conversion.
    public var sampleRate: Double = 44100.0

    /// Spin lock for thread-safe anchor access.
    private var lock = os_unfair_lock()

    // MARK: - Initialization

    public init(sampleRate: Double = 44100.0) {
        self.sampleRate = sampleRate

        // Cache timebase info once at init (it never changes per-process)
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        self.timebaseNumer = UInt64(info.numer)
        self.timebaseDenom = UInt64(info.denom)
    }

    // MARK: - Anchor Updates (called from audio/main thread)

    /// Update the anchor point with a confirmed position from the audio engine.
    /// Call this from `TransportController.applyPlayheadUpdates()`.
    ///
    /// - Parameter sampleFrame: The audio engine's current sample frame (source of truth).
    public func anchorUpdate(sampleFrame: Int64) {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }

        anchorSampleFrame = sampleFrame
        anchorMachTime = mach_absolute_time()
    }

    /// Backward-compatible anchor update API used by transport.
    /// Also updates sample-rate and transport state atomically.
    public func updateAnchor(sampleFrame: Int64, sampleRate: Double, isPlaying: Bool) {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }

        anchorSampleFrame = sampleFrame
        anchorMachTime = mach_absolute_time()
        self.sampleRate = sampleRate
        self.isPlaying = isPlaying
    }

    /// Signal that playback has started.
    public func start() {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }

        isPlaying = true
        anchorMachTime = mach_absolute_time()
    }

    /// Signal that playback has stopped or paused.
    public func stop() {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }

        isPlaying = false
    }

    /// Reset the interpolator (e.g., on seek or project change).
    public func reset(sampleFrame: Int64 = 0) {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }

        anchorSampleFrame = sampleFrame
        anchorMachTime = mach_absolute_time()
    }

    // MARK: - Visual Position (called from Metal render thread at 120 FPS)

    /// Returns the extrapolated playhead position for the current frame.
    ///
    /// Between audio callbacks (~11ms intervals), this method smoothly interpolates
    /// the playhead position using high-resolution system time, eliminating the
    /// visible "stepping" artifact.
    ///
    /// - Returns: The visual sample position as a `Double` for sub-sample accuracy.
    public func currentVisualSample() -> Double {
        os_unfair_lock_lock(&lock)
        let anchor = anchorSampleFrame
        let anchorTime = anchorMachTime
        let playing = isPlaying
        let rate = sampleRate
        let numer = timebaseNumer
        let denom = timebaseDenom
        os_unfair_lock_unlock(&lock)

        guard playing, anchorTime > 0 else {
            return Double(anchor)
        }

        let currentMach = mach_absolute_time()
        let elapsedMach = currentMach - anchorTime

        // Convert mach ticks → nanoseconds → seconds
        // Formula: seconds = (ticks * numer / denom) / 1e9
        let elapsedNanos = elapsedMach * numer / denom
        let elapsedSeconds = Double(elapsedNanos) / 1_000_000_000.0

        // Clamp extrapolation to 50ms max to prevent runaway during stalls
        let clampedSeconds = min(elapsedSeconds, 0.050)

        // Extrapolate: anchor + elapsed * sampleRate
        return Double(anchor) + (clampedSeconds * rate)
    }

    /// Returns the extrapolated playhead position as an integer sample frame.
    /// Use when sub-sample precision is not needed.
    public func currentVisualSampleFrame() -> Int64 {
        return Int64(currentVisualSample())
    }
}
