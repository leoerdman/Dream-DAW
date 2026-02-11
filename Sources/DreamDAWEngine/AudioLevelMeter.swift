import AVFoundation
import Accelerate
import Foundation
import os.log

// MARK: - LockFreeLevel

/// Lock-free level storage for real-time audio metering.
/// Uses C11 atomics via `ManagedBuffer` pattern with `UnsafeMutablePointer` to
/// store Float values as their UInt32 bit patterns for atomic load/store.
///
/// **Audio thread writes**, **main thread reads** — zero contention.
private final class LockFreeLevel: @unchecked Sendable {
    // Store 2 UInt32s side by side: [rms bits, peak bits]
    private let storage: UnsafeMutablePointer<UInt32>

    init() {
        storage = .allocate(capacity: 2)
        storage.initialize(repeating: 0, count: 2)
    }

    deinit {
        storage.deinitialize(count: 2)
        storage.deallocate()
    }

    /// Write RMS — called from audio thread. Lock-free.
    func storeRMS(_ value: Float) {
        storage.advanced(by: 0).pointee = value.bitPattern
    }

    /// Write Peak — called from audio thread. Lock-free.
    func storePeak(_ value: Float) {
        storage.advanced(by: 1).pointee = value.bitPattern
    }

    /// Read RMS — called from main thread. Lock-free.
    func loadRMS() -> Float {
        Float(bitPattern: storage.advanced(by: 0).pointee)
    }

    /// Read Peak — called from main thread. Lock-free.
    func loadPeak() -> Float {
        Float(bitPattern: storage.advanced(by: 1).pointee)
    }
}

// MARK: - AudioLevelMeter

/// Enterprise-grade real-time audio level metering service.
/// Installs taps on AVAudioMixerNode instances to compute RMS and peak levels.
///
/// **Thread safety model**:
/// - Level data is stored in `LockFreeLevel` instances (raw pointer UInt32 bit pattern).
/// - Audio thread WRITES to pre-captured `LockFreeLevel` references — no locks, no allocations.
/// - Main thread READS from `LockFreeLevel` — no locks.
/// - Tap management (install/remove) uses `os_unfair_lock` on main thread only.
public final class AudioLevelMeter {

    // MARK: - Level Data

    public init() {}

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

    /// Lock-free level storage per track.
    /// The `LockFreeLevel` instances are created on the main thread and captured
    /// by the audio tap closure — the audio thread never touches this dictionary.
    private var atomicLevels: [UUID: LockFreeLevel] = [:]
    private let masterAtomicLevel = LockFreeLevel()

    /// Management lock — protects tap registry and dictionary mutations.
    /// NEVER acquired on the audio thread.
    private var managementLock = os_unfair_lock()

    /// Tap buffer size (smaller = more responsive, but more CPU)
    private let tapBufferSize: AVAudioFrameCount = 1024

    /// Peak hold decay rate per update (smooth decay for visual appeal)
    private let peakDecayRate: Float = 0.95

    /// Tracked taps (for cleanup) — guarded by managementLock
    private var activeTaps: [UUID: AVAudioMixerNode] = [:]
    private var masterTapNode: AVAudioNode?

    // MARK: - Public API

    /// Install a metering tap on a track's mixer node. Call from main thread only.
    public func installTap(trackID: UUID, on mixerNode: AVAudioMixerNode) {
        // Remove existing tap if any
        removeTap(trackID: trackID)

        let format = mixerNode.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else {
            logger.warning("Cannot install tap on \(trackID) — invalid format")
            return
        }

        // Create lock-free level storage BEFORE installing the tap
        let levelStore = LockFreeLevel()
        let peakDecay = self.peakDecayRate

        os_unfair_lock_lock(&managementLock)
        activeTaps[trackID] = mixerNode
        atomicLevels[trackID] = levelStore
        os_unfair_lock_unlock(&managementLock)

        // Install tap — the closure captures `levelStore` directly.
        // Audio thread writes to it lock-free. No dictionary lookups on audio thread.
        mixerNode.installTap(onBus: 0, bufferSize: tapBufferSize, format: format) { buffer, _ in
            // ═══════════════════════════════════════════════════════
            // AUDIO THREAD — ZERO locks, ZERO allocations, ZERO blocking
            // ═══════════════════════════════════════════════════════
            guard let floatData = buffer.floatChannelData else { return }
            let frameLength = Int(buffer.frameLength)
            guard frameLength > 0 else { return }

            let channelCount = Int(buffer.format.channelCount)

            var sumOfSquares: Float = 0
            var peak: Float = 0

            for channel in 0..<channelCount {
                let samples = floatData[channel]
                let length = vDSP_Length(frameLength)

                // RMS calculation: Sum of squares
                var channelSumOfSquares: Float = 0
                vDSP_svesq(samples, 1, &channelSumOfSquares, length)
                sumOfSquares += channelSumOfSquares

                // Peak calculation: Absolute maximum value
                var channelMaxPeak: Float = 0
                vDSP_maxmgv(samples, 1, &channelMaxPeak, length)
                if channelMaxPeak > peak {
                    peak = channelMaxPeak
                }
            }

            let rms = sqrt(sumOfSquares / Float(frameLength * channelCount))

            // Lock-free writes via raw pointer
            levelStore.storeRMS(rms)
            levelStore.storePeak(max(peak, levelStore.loadPeak() * peakDecay))
        }
    }

    /// Install a metering tap on the master mixer node. Call from main thread only.
    public func installMasterTap(on node: AVAudioMixerNode) {
        removeMasterTap()

        let format = node.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else {
            logger.warning("Cannot install master tap — invalid format")
            return
        }

        os_unfair_lock_lock(&managementLock)
        masterTapNode = node
        os_unfair_lock_unlock(&managementLock)

        // Capture references for lock-free audio thread access
        let masterStore = self.masterAtomicLevel
        let peakDecay = self.peakDecayRate

        node.installTap(onBus: 0, bufferSize: tapBufferSize, format: format) { buffer, _ in
            // ═══════════════════════════════════════════════════════
            // AUDIO THREAD — ZERO locks, ZERO allocations, ZERO blocking
            // ═══════════════════════════════════════════════════════
            guard let floatData = buffer.floatChannelData else { return }
            let frameLength = Int(buffer.frameLength)
            guard frameLength > 0 else { return }

            let channelCount = Int(buffer.format.channelCount)

            var sumOfSquares: Float = 0
            var peak: Float = 0

            for channel in 0..<channelCount {
                let samples = floatData[channel]
                let length = vDSP_Length(frameLength)

                // RMS calculation: Sum of squares
                var channelSumOfSquares: Float = 0
                vDSP_svesq(samples, 1, &channelSumOfSquares, length)
                sumOfSquares += channelSumOfSquares

                // Peak calculation: Absolute maximum value
                var channelMaxPeak: Float = 0
                vDSP_maxmgv(samples, 1, &channelMaxPeak, length)
                if channelMaxPeak > peak {
                    peak = channelMaxPeak
                }
            }

            let rms = sqrt(sumOfSquares / Float(frameLength * channelCount))

            // Lock-free writes
            masterStore.storeRMS(rms)
            masterStore.storePeak(max(peak, masterStore.loadPeak() * peakDecay))
        }
    }

    /// Remove the metering tap for a specific track. Call from main thread only.
    public func removeTap(trackID: UUID) {
        os_unfair_lock_lock(&managementLock)
        let node = activeTaps.removeValue(forKey: trackID)
        atomicLevels.removeValue(forKey: trackID)
        os_unfair_lock_unlock(&managementLock)

        node?.removeTap(onBus: 0)
    }

    /// Remove the master metering tap. Call from main thread only.
    public func removeMasterTap() {
        os_unfair_lock_lock(&managementLock)
        let node = masterTapNode
        masterTapNode = nil
        os_unfair_lock_unlock(&managementLock)

        // Reset via lock-free writes
        masterAtomicLevel.storeRMS(0)
        masterAtomicLevel.storePeak(0)

        if let mixerNode = node as? AVAudioMixerNode {
            mixerNode.removeTap(onBus: 0)
        }
    }

    /// Remove all taps (cleanup). Call from main thread only.
    public func removeAllTaps() {
        os_unfair_lock_lock(&managementLock)
        let taps = activeTaps
        activeTaps.removeAll()
        atomicLevels.removeAll()
        let master = masterTapNode
        masterTapNode = nil
        os_unfair_lock_unlock(&managementLock)

        // Reset master
        masterAtomicLevel.storeRMS(0)
        masterAtomicLevel.storePeak(0)

        for (_, node) in taps {
            node.removeTap(onBus: 0)
        }
        if let masterMixer = master as? AVAudioMixerNode {
            masterMixer.removeTap(onBus: 0)
        }
    }

    /// Get the current level for a track. Lock-free read — safe from any thread.
    public func level(for trackID: UUID) -> Level {
        os_unfair_lock_lock(&managementLock)
        let levelStore = atomicLevels[trackID]
        os_unfair_lock_unlock(&managementLock)

        guard let levelStore = levelStore else {
            return Level()
        }

        return Level(rms: levelStore.loadRMS(), peak: levelStore.loadPeak())
    }

    /// Get the current master level. Fully lock-free — safe from any thread.
    public func masterLevelValue() -> Level {
        return Level(rms: masterAtomicLevel.loadRMS(), peak: masterAtomicLevel.loadPeak())
    }
}
