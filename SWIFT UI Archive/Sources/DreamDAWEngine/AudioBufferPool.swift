import AVFoundation
import os.log

// MARK: - SPRINT 5 (Pillar 5): AudioBufferPool — Flyweight Pattern
//
// Solves the "100 kick drums = 100 file handles" problem.
// Short audio samples (< 5 seconds) are loaded once into RAM and shared
// by all clips referencing the same file URL. Zero-copy: 100 clips of
// the same kick get one pointer.
//
// Long samples (> 5 seconds) are NOT cached — they stream via TileEngine.

public final class AudioBufferPool {
    
    public static let shared = AudioBufferPool()
    
    // MARK: - Configuration
    
    /// Maximum sample duration (in seconds) that qualifies for RAM caching.
    /// Files longer than this are streamed from disk via TileEngine.
    private let maxCacheDurationSeconds: Double = 5.0
    
    /// Maximum total RAM budget for the pool (256 MB).
    private let maxPoolBytes: Int = 256 * 1024 * 1024
    
    // MARK: - Cache Storage
    
    /// URL-keyed buffer cache. Thread-safe via serial queue.
    private var bufferCache: [URL: AVAudioPCMBuffer] = [:]
    
    /// URL-keyed file handle cache for re-use.
    private var fileCache: [URL: AVAudioFile] = [:]
    
    /// Total bytes currently cached.
    private var currentPoolBytes: Int = 0
    
    /// Serial queue for thread-safe cache access.
    private let cacheQueue = DispatchQueue(label: "com.dreamdaw.audiobufferpool", qos: .userInitiated)
    
    private let logger = Logger(subsystem: "com.dreamdaw", category: "AudioBufferPool")
    
    private init() {
        logger.info("AudioBufferPool: Initialized (maxCache: \(self.maxCacheDurationSeconds)s, budget: \(self.maxPoolBytes / 1024 / 1024)MB)")
    }
    
    // MARK: - Public API
    
    /// Returns a cached AVAudioFile for the given URL, avoiding repeated file opens.
    /// Thread-safe. Creates the file handle on first access.
    public func getFile(for url: URL) throws -> AVAudioFile {
        try cacheQueue.sync {
            if let cached = fileCache[url] {
                // Reset frame position for fresh reads
                cached.framePosition = 0
                return cached
            }
            
            let file = try AVAudioFile(forReading: url)
            fileCache[url] = file
            return file
        }
    }
    
    /// Returns a cached PCM buffer for short samples, or nil if the file
    /// is too long for caching (should be streamed instead).
    ///
    /// **Thread Safety:** Synchronized via serial queue.
    /// **Zero-Copy:** Multiple clips referencing the same URL get the same buffer pointer.
    ///
    /// - Parameters:
    ///   - url: File URL of the audio sample.
    ///   - sampleRate: Project sample rate (for duration calculation).
    /// - Returns: Cached buffer, or nil if file exceeds cache threshold.
    public func getBuffer(for url: URL, sampleRate: Double = 44100.0) -> AVAudioPCMBuffer? {
        return cacheQueue.sync { () -> AVAudioPCMBuffer? in
            // 1. Return cached buffer if available
            if let cached = bufferCache[url] {
                return cached
            }
            
            // 2. Load and evaluate
            guard let file = try? AVAudioFile(forReading: url) else { return nil }
            
            let fileDuration = Double(file.length) / file.fileFormat.sampleRate
            guard fileDuration <= maxCacheDurationSeconds else {
                // Too long for RAM cache — caller should stream from disk
                return nil
            }
            
            let bufferBytes = Int(file.length) * Int(file.fileFormat.channelCount) * MemoryLayout<Float>.size
            guard currentPoolBytes + bufferBytes <= maxPoolBytes else {
                logger.warning("AudioBufferPool: RAM budget exceeded, skipping cache for \(url.lastPathComponent)")
                return nil
            }
            
            // 3. Load entire file into RAM buffer
            guard let buffer = AVAudioPCMBuffer(
                pcmFormat: file.processingFormat,
                frameCapacity: AVAudioFrameCount(file.length)
            ) else { return nil }
            
            do {
                try file.read(into: buffer)
                bufferCache[url] = buffer
                currentPoolBytes += bufferBytes
                logger.debug("AudioBufferPool: Cached \(url.lastPathComponent) (\(fileDuration, format: .fixed(precision: 1))s, \(bufferBytes / 1024)KB)")
                return buffer
            } catch {
                logger.error("AudioBufferPool: Failed to read \(url.lastPathComponent): \(error)")
                return nil
            }
        }
    }
    
    // MARK: - Cache Management
    
    /// Evicts all cached buffers and file handles. Call when closing a project.
    public func purge() {
        cacheQueue.sync {
            bufferCache.removeAll()
            fileCache.removeAll()
            currentPoolBytes = 0
            logger.info("AudioBufferPool: Cache purged")
        }
    }
    
    /// Evicts a specific URL from the cache (e.g., when a file is re-recorded).
    public func evict(url: URL) {
        cacheQueue.sync {
            if let buffer = bufferCache.removeValue(forKey: url) {
                let bytes = Int(buffer.frameLength) * Int(buffer.format.channelCount) * MemoryLayout<Float>.size
                currentPoolBytes -= bytes
            }
            fileCache.removeValue(forKey: url)
        }
    }
    
    /// Current cache statistics for diagnostics.
    public var stats: (cachedFiles: Int, totalBytes: Int) {
        cacheQueue.sync {
            (bufferCache.count, currentPoolBytes)
        }
    }
}
