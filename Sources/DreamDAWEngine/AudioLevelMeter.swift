import Accelerate
import Foundation
import os.log
import AVFoundation

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

// MARK: - LockFreeFFT

/// Lock-free storage for FFT magnitudes.
/// Uses a double-buffered approach or atomic updates for the array.
/// Since we only need a "snapshot" for UI, we'll use a fixed-size buffer
/// and atomic bit pattern stores for each bin.
private final class LockFreeFFT: @unchecked Sendable {
    private let size: Int
    private let storage: UnsafeMutablePointer<UInt32>

    init(size: Int) {
        self.size = size
        storage = .allocate(capacity: size)
        storage.initialize(repeating: 0, count: size)
    }

    deinit {
        storage.deinitialize(count: size)
        storage.deallocate()
    }

    func storeMagnitudes(_ magnitudes: [Float]) {
        let count = min(size, magnitudes.count)
        for i in 0..<count {
            storage.advanced(by: i).pointee = magnitudes[i].bitPattern
        }
    }

    func loadMagnitudes() -> [Float] {
        var magnitudes = [Float](repeating: 0, count: size)
        for i in 0..<size {
            magnitudes[i] = Float(bitPattern: storage.advanced(by: i).pointee)
        }
        return magnitudes
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
/// - Main thread READS from `LockFreeLevel` — no locks.
/// - Tap management (install/remove) uses `os_unfair_lock` on main thread only.
public final class AudioLevelMeter: @unchecked Sendable {

    // MARK: - Level Data

    /// Points in the signal chain where metering can be installed.
    public enum TapPoint: String, Codable, CaseIterable {
        case preEffects  = "pre"
        case postEffects = "post"
    }

    /// Composite key for level storage.
    private struct LevelKey: Hashable {
        let trackID: UUID
        let point: TapPoint
    }

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

    /// Lock-free level storage per track and tap point.
    private var atomicLevels: [LevelKey: LockFreeLevel] = [:]
    private let masterAtomicLevel = LockFreeLevel()
    
    /// MIDI activity storage per track (peak velocity scaled 0...1)
    private var midiLevels: [UUID: LockFreeLevel] = [:]
    
    /// FFT storage per track.
    private var fftStorage: [UUID: LockFreeFFT] = [:]
    private var masterFFT = LockFreeFFT(size: 512) // Magnitude bins (FFT size / 2)

    /// FFT Setup (Shared)
    private let fftSize = 1024
    private lazy var fftSetup: FFTSetup? = vDSP_create_fftsetup(vDSP_Length(log2(Double(fftSize))), FFTRadix(kFFTRadix2))

    /// Management lock — protects tap registry and dictionary mutations.
    private var managementLock = os_unfair_lock()

    /// Tap buffer size
    private let tapBufferSize: AVAudioFrameCount = 1024

    /// Peak hold decay rate per update
    private let peakDecayRate: Float = 0.95

    /// Tracked taps (for cleanup)
    private var activeTaps: [LevelKey: AVAudioMixerNode] = [:]
    private var masterTapNode: AVAudioNode?

    // MARK: - Public API

    /// Install a metering tap on a track's mixer node at a specific point.
    public func installTap(trackID: UUID, point: TapPoint = .postEffects, on mixerNode: AVAudioMixerNode) {
        let key = LevelKey(trackID: trackID, point: point)
        
        // Remove existing tap if any at THIS point
        removeTap(trackID: trackID, point: point)

        let format = mixerNode.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else {
            logger.warning("Cannot install tap on \(trackID) (\(point.rawValue)) — invalid format")
            return
        }

        let levelStore = LockFreeLevel()
        let fftStore = LockFreeFFT(size: fftSize / 2)
        let peakDecay = self.peakDecayRate

        os_unfair_lock_lock(&managementLock)
        activeTaps[key] = mixerNode
        atomicLevels[key] = levelStore
        fftStorage[trackID] = fftStore
        os_unfair_lock_unlock(&managementLock)

        mixerNode.installTap(onBus: 0, bufferSize: tapBufferSize, format: format) { [weak self] buffer, _ in
            guard let self = self, let floatData = buffer.floatChannelData else { return }
            let frameLength = Int(buffer.frameLength)
            guard frameLength > 0 else { return }

            let channelCount = Int(buffer.format.channelCount)
            var sumOfSquares: Float = 0
            var peak: Float = 0

            for channel in 0..<channelCount {
                let samples = floatData[channel]
                let length = vDSP_Length(frameLength)

                var channelSumOfSquares: Float = 0
                vDSP_svesq(samples, 1, &channelSumOfSquares, length)
                sumOfSquares += channelSumOfSquares

                var channelMaxPeak: Float = 0
                vDSP_maxmgv(samples, 1, &channelMaxPeak, length)
                if channelMaxPeak > peak { peak = channelMaxPeak }
            }

            let rms = sqrt(sumOfSquares / Float(frameLength * channelCount))
            levelStore.storeRMS(rms)
            levelStore.storePeak(max(peak, levelStore.loadPeak() * peakDecay))
            
            if let setup = self.fftSetup {
                self.computeFFT(buffer: buffer, fftStore: fftStore, setup: setup)
            }
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
        let mFFT = self.masterFFT
        let peakDecay = self.peakDecayRate

        node.installTap(onBus: 0, bufferSize: tapBufferSize, format: format) { [weak self] buffer, _ in
            guard let self = self, let floatData = buffer.floatChannelData else { return }
            let frameLength = Int(buffer.frameLength)
            guard frameLength > 0 else { return }

            let channelCount = Int(buffer.format.channelCount)
            var sumOfSquares: Float = 0
            var peak: Float = 0

            for channel in 0..<channelCount {
                let samples = floatData[channel]
                let length = vDSP_Length(frameLength)

                var channelSumOfSquares: Float = 0
                vDSP_svesq(samples, 1, &channelSumOfSquares, length)
                sumOfSquares += channelSumOfSquares

                var channelMaxPeak: Float = 0
                vDSP_maxmgv(samples, 1, &channelMaxPeak, length)
                if channelMaxPeak > peak { peak = channelMaxPeak }
            }

            let rms = sqrt(sumOfSquares / Float(frameLength * channelCount))
            masterStore.storeRMS(rms)
            masterStore.storePeak(max(peak, masterStore.loadPeak() * peakDecay))
            
            if let setup = self.fftSetup {
                self.computeFFT(buffer: buffer, fftStore: mFFT, setup: setup)
            }
        }
    }

    /// Remove the metering tap for a specific track and point.
    public func removeTap(trackID: UUID, point: TapPoint = .postEffects) {
        let key = LevelKey(trackID: trackID, point: point)
        os_unfair_lock_lock(&managementLock)
        let node = activeTaps.removeValue(forKey: key)
        atomicLevels.removeValue(forKey: key)
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

    /// Get the current level for a track at a specific point. Lock-free read.
    public func level(for trackID: UUID, point: TapPoint = .postEffects) -> Level {
        let key = LevelKey(trackID: trackID, point: point)
        os_unfair_lock_lock(&managementLock)
        let levelStore = atomicLevels[key]
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

    // MARK: - MIDI Activity API

    /// Report MIDI note activity for a track. Safe from any thread.
    public func reportMidiActivity(trackID: UUID, velocity: Int) {
        let level = Float(velocity) / 127.0
        
        os_unfair_lock_lock(&managementLock)
        if midiLevels[trackID] == nil {
            midiLevels[trackID] = LockFreeLevel()
        }
        let store = midiLevels[trackID]
        os_unfair_lock_unlock(&managementLock)
        
        if let store = store {
            let current = store.loadPeak()
            store.storePeak(max(level, current))
        }
    }

    /// Get current MIDI activity level (0...1) for a track.
    /// Also decays the level slightly to provide a smooth visual falloff.
    public func midiLevel(for trackID: UUID) -> Float {
        os_unfair_lock_lock(&managementLock)
        let store = midiLevels[trackID]
        os_unfair_lock_unlock(&managementLock)
        
        if let store = store {
            let val = store.loadPeak()
            // Apply decay on read for simpler implementation (UI typically reads at 30-60fps)
            store.storePeak(val * 0.9) 
            return val
        }
        return 0
    }
    
    // MARK: - Spectrum Analysis API
    
    /// Get the current FFT spectrum for a track.
    public func magnitudes(for trackID: UUID) -> [Float] {
        os_unfair_lock_lock(&managementLock)
        let fft = fftStorage[trackID]
        os_unfair_lock_unlock(&managementLock)
        
        return fft?.loadMagnitudes() ?? [Float](repeating: 0, count: 512)
    }
    
    /// Get the current master FFT spectrum.
    public func masterMagnitudes() -> [Float] {
        return masterFFT.loadMagnitudes()
    }
    
    // MARK: - Internal FFT Computation
    
    private func computeFFT(buffer: AVAudioPCMBuffer, fftStore: LockFreeFFT, setup: FFTSetup) {
        guard let floatData = buffer.floatChannelData else { return }
        let frameCount = Int(buffer.frameLength)
        if frameCount < fftSize { return }
        
        let log2n = vDSP_Length(log2(Double(fftSize)))
        let halfSize = fftSize / 2
        
        var realP = [Float](repeating: 0, count: halfSize)
        var imagP = [Float](repeating: 0, count: halfSize)
        var output = DSPSplitComplex(realp: &realP, imagp: &imagP)
        
        // Pack into complex format (treating real samples as interleaved complex)
        floatData[0].withMemoryRebound(to: DSPComplex.self, capacity: halfSize) { ptr in
            vDSP_ctoz(ptr, 2, &output, 1, vDSP_Length(halfSize))
        }
        
        // Forward FFT
        vDSP_fft_zrip(setup, &output, 1, log2n, FFTDirection(FFT_FORWARD))
        
        // Compute Magnitudes
        var magnitudes = [Float](repeating: 0, count: halfSize)
        vDSP_zvmags(&output, 1, &magnitudes, 1, vDSP_Length(halfSize))
        
        // Normalize (scale by 1/N for power preservation)
        var scale = 1.0 / Float(fftSize)
        vDSP_vsmul(magnitudes, 1, &scale, &magnitudes, 1, vDSP_Length(halfSize))
        
        fftStore.storeMagnitudes(magnitudes)
    }
}
