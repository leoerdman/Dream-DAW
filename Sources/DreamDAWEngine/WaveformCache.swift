import AVFoundation
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

// MARK: - WaveformCache

/// Generates and caches multi-resolution waveform data for audio files.
/// Uses a background dispatch queue for non-blocking computation.
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
    private let lock = NSLock()

    /// Maximum number of cached entries.
    private let maxCacheSize = 128

    // MARK: - Initialization

    public init() {}

    // MARK: - Public API

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
                // LRU eviction if cache is full
                if self.cache.count >= self.maxCacheSize {
                    self.cache.removeAll() // Simple eviction — clear all
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

    /// Clear all cached waveform data.
    public func clearCache() {
        lock.lock()
        defer { lock.unlock() }
        cache.removeAll()
    }

    // MARK: - Computation

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

        // Read in chunks
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

                // Mix down to mono by averaging channels
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

        // Finalize RMS
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
}
