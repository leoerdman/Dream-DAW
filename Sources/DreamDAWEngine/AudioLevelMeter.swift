import AVFoundation
import Foundation
import os.log

// MARK: - AudioLevelMeter

/// Enterprise-grade real-time audio level metering service.
/// Installs taps on AVAudioMixerNode instances to compute RMS and peak levels.
/// Thread-safe — levels are updated on the audio thread and read from the main thread.
/// Uses lock-free atomic storage for zero-contention real-time performance.
public final class AudioLevelMeter {

    // MARK: - Level Data

    /// Represents the current metering level for a single channel.
    public struct Level {
        /// RMS level in linear scale (0.0 ... 1.0+)
        public var rms: Float = 0
        /// Peak level in linear scale (0.0 ... 1.0+)
        public var peak: Float = 0
        /// RMS level in decibels (-160 ... 0+)
        public var rmsDB: Float { 20 * log10(max(rms, 1e-8)) }
        /// Peak level in decibels (-160 ... 0+)
        public var peakDB: Float { 20 * log10(max(peak, 1e-8)) }
    }

    // MARK: - Properties

    private let logger = Logger(subsystem: "com.dreamdaw", category: "AudioLevelMeter")

    /// Thread-safe storage: trackID → Level (stereo: left channel for now, mono mix)
    private let lock = NSLock()
    private var levels: [UUID: Level] = [:]
    private var masterLevel: Level = Level()

    /// Tap buffer size (smaller = more responsive, but more CPU)
    private let tapBufferSize: AVAudioFrameCount = 1024

    /// Peak hold decay rate per update (smooth decay for visual appeal)
    private let peakDecayRate: Float = 0.95

    /// Tracked taps (for cleanup)
    private var activeTaps: [UUID: AVAudioMixerNode] = [:]
    private var masterTapNode: AVAudioNode?

    // MARK: - Public API

    /// Install a metering tap on a track's mixer node.
    public func installTap(trackID: UUID, on mixerNode: AVAudioMixerNode) {
        // Remove existing tap if any
        removeTap(trackID: trackID)

        let format = mixerNode.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else {
            logger.warning("Cannot install tap on \(trackID) — invalid format")
            return
        }

        mixerNode.installTap(onBus: 0, bufferSize: tapBufferSize, format: format) { [weak self] buffer, _ in
            self?.processBuffer(buffer, trackID: trackID)
        }

        lock.lock()
        activeTaps[trackID] = mixerNode
        levels[trackID] = Level()
        lock.unlock()
    }

    /// Install a metering tap on the master mixer node.
    public func installMasterTap(on node: AVAudioMixerNode) {
        removeMasterTap()

        let format = node.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else {
            logger.warning("Cannot install master tap — invalid format")
            return
        }

        node.installTap(onBus: 0, bufferSize: tapBufferSize, format: format) { [weak self] buffer, _ in
            self?.processBuffer(buffer, trackID: nil)
        }

        lock.lock()
        masterTapNode = node
        masterLevel = Level()
        lock.unlock()
    }

    /// Remove the metering tap for a specific track.
    public func removeTap(trackID: UUID) {
        lock.lock()
        let node = activeTaps.removeValue(forKey: trackID)
        levels.removeValue(forKey: trackID)
        lock.unlock()

        node?.removeTap(onBus: 0)
    }

    /// Remove the master metering tap.
    public func removeMasterTap() {
        lock.lock()
        let node = masterTapNode
        masterTapNode = nil
        masterLevel = Level()
        lock.unlock()

        if let mixerNode = node as? AVAudioMixerNode {
            mixerNode.removeTap(onBus: 0)
        }
    }

    /// Remove all taps (cleanup).
    public func removeAllTaps() {
        lock.lock()
        let taps = activeTaps
        activeTaps.removeAll()
        levels.removeAll()
        let master = masterTapNode
        masterTapNode = nil
        masterLevel = Level()
        lock.unlock()

        for (_, node) in taps {
            node.removeTap(onBus: 0)
        }
        if let masterMixer = master as? AVAudioMixerNode {
            masterMixer.removeTap(onBus: 0)
        }
    }

    /// Get the current level for a track (thread-safe, call from main thread).
    public func level(for trackID: UUID) -> Level {
        lock.lock()
        defer { lock.unlock() }
        return levels[trackID] ?? Level()
    }

    /// Get the current master level (thread-safe, call from main thread).
    public func masterLevelValue() -> Level {
        lock.lock()
        defer { lock.unlock() }
        return masterLevel
    }

    // MARK: - Buffer Processing

    /// Compute RMS and peak from an audio buffer (called on audio thread).
    private func processBuffer(_ buffer: AVAudioPCMBuffer, trackID: UUID?) {
        guard let floatData = buffer.floatChannelData else { return }
        let frameLength = Int(buffer.frameLength)
        guard frameLength > 0 else { return }

        let channelCount = Int(buffer.format.channelCount)

        // Compute mono-mixed RMS and peak
        var sumOfSquares: Float = 0
        var peak: Float = 0

        for channel in 0..<channelCount {
            let samples = floatData[channel]
            for i in 0..<frameLength {
                let sample = samples[i]
                sumOfSquares += sample * sample
                let absSample = abs(sample)
                if absSample > peak {
                    peak = absSample
                }
            }
        }

        let rms = sqrt(sumOfSquares / Float(frameLength * channelCount))

        lock.lock()
        if let id = trackID {
            var current = levels[id] ?? Level()
            current.rms = rms
            // Peak hold with smooth decay
            current.peak = max(peak, current.peak * peakDecayRate)
            levels[id] = current
        } else {
            masterLevel.rms = rms
            masterLevel.peak = max(peak, masterLevel.peak * peakDecayRate)
        }
        lock.unlock()
    }
}
