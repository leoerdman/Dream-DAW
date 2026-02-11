import AVFoundation
import Accelerate
import Foundation
import os.log

// MARK: - WaveformData

/// Pre-computed waveform visualization data at a specific resolution.
public struct WaveformData: Sendable {
    /// Peak amplitude values for each sample block (-1...1 range).
    public let peaks: [Float]
    /// RMS values for each sample block.
    public let rmsValues: [Float]
    /// Number of source samples per one peak/rms entry.
    public let samplesPerPixel: Int
    /// Total number of source samples.
    public let totalSamples: Int64

    public init(peaks: [Float], rmsValues: [Float], samplesPerPixel: Int, totalSamples: Int64) {
        self.peaks = peaks
        self.rmsValues = rmsValues
        self.samplesPerPixel = samplesPerPixel
        self.totalSamples = totalSamples
    }
}

// MARK: - MultiBandWaveformData

/// Three-band waveform data for colored frequency visualization.
/// Band split: Low (20-300 Hz), Mid (300-4000 Hz), High (4000+ Hz).
public struct MultiBandWaveformData: Sendable {
    public let lowPeaks: [Float]   // Bass band (20-300 Hz)
    public let midPeaks: [Float]   // Mid band (300-4000 Hz)
    public let highPeaks: [Float]  // High band (4000+ Hz)
    public let samplesPerPixel: Int
    public let totalSamples: Int64

    public init(lowPeaks: [Float], midPeaks: [Float], highPeaks: [Float], samplesPerPixel: Int, totalSamples: Int64) {
        self.lowPeaks = lowPeaks
        self.midPeaks = midPeaks
        self.highPeaks = highPeaks
        self.samplesPerPixel = samplesPerPixel
        self.totalSamples = totalSamples
    }
}

// MARK: - WaveformCache

/// Generates and caches multi-resolution waveform data for audio files.
/// Uses a background dispatch queue for non-blocking computation.
/// Supports both mono and multi-band (bass/mid/high) waveform data.
public final class WaveformCache: @unchecked Sendable {

    // MARK: - Types

    private struct CacheKey: Hashable {
        let url: URL
        let samplesPerPixel: Int
    }

    // MARK: - Properties

    private let logger = Logger(subsystem: "com.dreamdaw", category: "WaveformCache")
    private let processingQueue = DispatchQueue(label: "com.dreamdaw.waveform", qos: .userInitiated, attributes: .concurrent)
    private var cache: [CacheKey: WaveformData] = [:]
    private var multiBandCache: [CacheKey: MultiBandWaveformData] = [:]
    private let lock = NSLock()

    /// Maximum number of cached entries per type.
    private let maxCacheSize = 128

    // MARK: - Initialization

    public init() {}

    // MARK: - Public API — Mono

    /// Get waveform data for a file at a given resolution.
    /// Returns cached data immediately if available, otherwise computes in background.
    public func getWaveform(
        for url: URL,
        samplesPerPixel: Int,
        completion: @escaping @Sendable (WaveformData?) -> Void
    ) {
        let key = CacheKey(url: url, samplesPerPixel: samplesPerPixel)

        lock.lock()
        if let cached = cache[key] {
            lock.unlock()
            completion(cached)
            return
        }
        lock.unlock()

        processingQueue.async { [weak self] in
            guard let self = self else { return }

            do {
                let file = try AVAudioFile(forReading: url)
                let data = try self.computeWaveform(file: file, samplesPerPixel: samplesPerPixel)

                self.lock.lock()
                if self.cache.count >= self.maxCacheSize {
                    self.cache.removeAll()
                }
                self.cache[key] = data
                self.lock.unlock()

                completion(data)
            } catch {
                self.logger.error("Failed to compute waveform for \(url.lastPathComponent): \(error.localizedDescription)")
                completion(nil)
            }
        }
    }

    /// Synchronously get cached waveform data (returns nil if not cached).
    public func getCachedWaveform(for url: URL, samplesPerPixel: Int) -> WaveformData? {
        let key = CacheKey(url: url, samplesPerPixel: samplesPerPixel)
        lock.lock()
        defer { lock.unlock() }
        return cache[key]
    }

    // MARK: - Public API — Multi-Band

    /// Get multi-band (bass/mid/high) waveform data for colored frequency visualization.
    public func getMultiBandWaveform(
        for url: URL,
        samplesPerPixel: Int,
        completion: @escaping @Sendable (MultiBandWaveformData?) -> Void
    ) {
        let key = CacheKey(url: url, samplesPerPixel: samplesPerPixel)

        lock.lock()
        if let cached = multiBandCache[key] {
            lock.unlock()
            completion(cached)
            return
        }
        lock.unlock()

        processingQueue.async { [weak self] in
            guard let self = self else { return }

            do {
                let file = try AVAudioFile(forReading: url)
                let data = try self.computeMultiBandWaveform(file: file, samplesPerPixel: samplesPerPixel)

                self.lock.lock()
                if self.multiBandCache.count >= self.maxCacheSize {
                    self.multiBandCache.removeAll()
                }
                self.multiBandCache[key] = data
                self.lock.unlock()

                completion(data)
            } catch {
                self.logger.error("Failed to compute multi-band waveform for \(url.lastPathComponent): \(error.localizedDescription)")
                completion(nil)
            }
        }
    }

    /// Synchronously get cached multi-band waveform data.
    public func getCachedMultiBandWaveform(for url: URL, samplesPerPixel: Int) -> MultiBandWaveformData? {
        let key = CacheKey(url: url, samplesPerPixel: samplesPerPixel)
        lock.lock()
        defer { lock.unlock() }
        return multiBandCache[key]
    }

    /// Clear all cached waveform data.
    public func clearCache() {
        lock.lock()
        defer { lock.unlock() }
        cache.removeAll()
        multiBandCache.removeAll()
    }

    // MARK: - Computation — Mono

    private func computeWaveform(file: AVAudioFile, samplesPerPixel: Int) throws -> WaveformData {
        let totalFrames = file.length
        let format = file.processingFormat
        let channelCount = Int(format.channelCount)

        guard channelCount > 0, totalFrames > 0 else {
            return WaveformData(peaks: [], rmsValues: [], samplesPerPixel: samplesPerPixel, totalSamples: totalFrames)
        }

        let numBlocks = Int(ceil(Double(totalFrames) / Double(samplesPerPixel)))
        var peaks = [Float](repeating: 0, count: numBlocks)
        var rmsValues = [Float](repeating: 0, count: numBlocks)

        let chunkSize: AVAudioFrameCount = 65536
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunkSize) else {
            throw NSError(domain: "WaveformCache", code: -1, userInfo: [NSLocalizedDescriptionKey: "Failed to create PCM buffer"])
        }

        file.framePosition = 0
        var globalSampleIndex: Int64 = 0

        while file.framePosition < totalFrames {
            let framesToRead = min(chunkSize, AVAudioFrameCount(totalFrames - file.framePosition))
            try file.read(into: buffer, frameCount: framesToRead)

            guard let channelData = buffer.floatChannelData else { break }
            let frameCount = Int(buffer.frameLength)

            for i in 0..<frameCount {
                let blockIndex = Int(globalSampleIndex) / samplesPerPixel
                guard blockIndex < numBlocks else { break }

                var sampleSum: Float = 0
                for ch in 0..<channelCount {
                    sampleSum += channelData[ch][i]
                }
                let monoSample = sampleSum / Float(channelCount)
                let absSample = abs(monoSample)

                peaks[blockIndex] = max(peaks[blockIndex], absSample)
                rmsValues[blockIndex] += monoSample * monoSample

                globalSampleIndex += 1
            }
        }

        for i in 0..<numBlocks {
            let samplesInBlock: Float
            if i == numBlocks - 1 {
                let remaining = Int(totalFrames) - i * samplesPerPixel
                samplesInBlock = Float(max(remaining, 1))
            } else {
                samplesInBlock = Float(samplesPerPixel)
            }
            rmsValues[i] = sqrt(rmsValues[i] / samplesInBlock)
        }

        logger.debug("Computed waveform: \(numBlocks) blocks at \(samplesPerPixel) spp for \(file.url.lastPathComponent)")

        return WaveformData(
            peaks: peaks,
            rmsValues: rmsValues,
            samplesPerPixel: samplesPerPixel,
            totalSamples: totalFrames
        )
    }

    // MARK: - Computation — Multi-Band (Biquad IIR Filters)

    /// Computes 3-band waveform data using cascaded biquad filters.
    /// Bands: Low (20-300 Hz), Mid (300-4000 Hz), High (4000+ Hz).
    private func computeMultiBandWaveform(file: AVAudioFile, samplesPerPixel: Int) throws -> MultiBandWaveformData {
        let totalFrames = file.length
        let format = file.processingFormat
        let channelCount = Int(format.channelCount)
        let sampleRate = format.sampleRate

        guard channelCount > 0, totalFrames > 0 else {
            return MultiBandWaveformData(
                lowPeaks: [], midPeaks: [], highPeaks: [],
                samplesPerPixel: samplesPerPixel, totalSamples: totalFrames
            )
        }

        // Read entire file into mono buffer
        let monoSamples = try readMonoSamples(file: file, totalFrames: totalFrames, channelCount: channelCount)

        // Design biquad filters
        let lowCutoff: Double = 300.0
        let highCutoff: Double = 4000.0

        // Low-pass filter for bass band
        let lowBand = applyLowPassFilter(samples: monoSamples, cutoff: lowCutoff, sampleRate: sampleRate)

        // High-pass filter for high band
        let highBand = applyHighPassFilter(samples: monoSamples, cutoff: highCutoff, sampleRate: sampleRate)

        // Mid band = original - low - high (subtraction method)
        var midBand = [Float](repeating: 0, count: monoSamples.count)
        for i in 0..<monoSamples.count {
            midBand[i] = monoSamples[i] - lowBand[i] - highBand[i]
        }

        // Downsample to peaks
        let numBlocks = Int(ceil(Double(totalFrames) / Double(samplesPerPixel)))

        let lowPeaks = downsampleToPeaks(samples: lowBand, numBlocks: numBlocks, samplesPerPixel: samplesPerPixel)
        let midPeaks = downsampleToPeaks(samples: midBand, numBlocks: numBlocks, samplesPerPixel: samplesPerPixel)
        let highPeaks = downsampleToPeaks(samples: highBand, numBlocks: numBlocks, samplesPerPixel: samplesPerPixel)

        logger.debug("Computed multi-band waveform: \(numBlocks) blocks for \(file.url.lastPathComponent)")

        return MultiBandWaveformData(
            lowPeaks: lowPeaks,
            midPeaks: midPeaks,
            highPeaks: highPeaks,
            samplesPerPixel: samplesPerPixel,
            totalSamples: totalFrames
        )
    }

    // MARK: - Filter Helpers

    private func readMonoSamples(file: AVAudioFile, totalFrames: Int64, channelCount: Int) throws -> [Float] {
        let format = file.processingFormat
        let chunkSize: AVAudioFrameCount = 65536
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunkSize) else {
            throw NSError(domain: "WaveformCache", code: -1, userInfo: [NSLocalizedDescriptionKey: "Buffer creation failed"])
        }

        var monoSamples = [Float]()
        monoSamples.reserveCapacity(Int(totalFrames))
        file.framePosition = 0

        while file.framePosition < totalFrames {
            let framesToRead = min(chunkSize, AVAudioFrameCount(totalFrames - file.framePosition))
            try file.read(into: buffer, frameCount: framesToRead)

            guard let channelData = buffer.floatChannelData else { break }
            let frameCount = Int(buffer.frameLength)

            for i in 0..<frameCount {
                var sum: Float = 0
                for ch in 0..<channelCount {
                    sum += channelData[ch][i]
                }
                monoSamples.append(sum / Float(channelCount))
            }
        }
        return monoSamples
    }

    /// Second-order IIR low-pass filter (Butterworth).
    private func applyLowPassFilter(samples: [Float], cutoff: Double, sampleRate: Double) -> [Float] {
        let omega = 2.0 * Double.pi * cutoff / sampleRate
        let cosOmega = cos(omega)
        let sinOmega = sin(omega)
        let alpha = sinOmega / (2.0 * sqrt(2.0)) // Q = sqrt(2)/2 for Butterworth

        let b0 = Float((1.0 - cosOmega) / 2.0)
        let b1 = Float(1.0 - cosOmega)
        let b2 = b0
        let a0 = Float(1.0 + alpha)
        let a1 = Float(-2.0 * cosOmega)
        let a2 = Float(1.0 - alpha)

        return applyBiquad(samples: samples, b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0)
    }

    /// Second-order IIR high-pass filter (Butterworth).
    private func applyHighPassFilter(samples: [Float], cutoff: Double, sampleRate: Double) -> [Float] {
        let omega = 2.0 * Double.pi * cutoff / sampleRate
        let cosOmega = cos(omega)
        let sinOmega = sin(omega)
        let alpha = sinOmega / (2.0 * sqrt(2.0))

        let b0 = Float((1.0 + cosOmega) / 2.0)
        let b1 = Float(-(1.0 + cosOmega))
        let b2 = b0
        let a0 = Float(1.0 + alpha)
        let a1 = Float(-2.0 * cosOmega)
        let a2 = Float(1.0 - alpha)

        return applyBiquad(samples: samples, b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0)
    }

    /// Direct Form II biquad filter.
    private func applyBiquad(samples: [Float], b0: Float, b1: Float, b2: Float, a1: Float, a2: Float) -> [Float] {
        let count = samples.count
        var output = [Float](repeating: 0, count: count)

        var x1: Float = 0, x2: Float = 0
        var y1: Float = 0, y2: Float = 0

        for i in 0..<count {
            let x = samples[i]
            let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            output[i] = y
            x2 = x1; x1 = x
            y2 = y1; y1 = y
        }
        return output
    }

    /// Downsample filtered samples to peak values per block.
    private func downsampleToPeaks(samples: [Float], numBlocks: Int, samplesPerPixel: Int) -> [Float] {
        var peaks = [Float](repeating: 0, count: numBlocks)
        for block in 0..<numBlocks {
            let start = block * samplesPerPixel
            let end = min(start + samplesPerPixel, samples.count)
            var peak: Float = 0
            for i in start..<end {
                peak = max(peak, abs(samples[i]))
            }
            peaks[block] = peak
        }
        return peaks
    }
}
