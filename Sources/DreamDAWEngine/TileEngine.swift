import Foundation
import AVFoundation
import os.log

/// Manages high-performance disk streaming for audio samples.
/// This prevents RAM exhaustion by only loading the 'Header' (first N frames)
/// into memory and streaming subsequent 'Tiles' on demand.
public final class TileEngine {
    public static let shared = TileEngine()
    
    /// Size of each streaming tile in frames.
    /// 65536 frames is approx 1.5s at 44.1kHz - a good balance for disk latency vs RAM.
    public let tileSize: AVAudioFrameCount = 65536
    
    /// Pre-allocate a small cache for active streaming files.
    private var activeFiles: [URL: AVAudioFile] = [:]
    private let logger = Logger(subsystem: "com.dreamdaw", category: "TileEngine")
    private let lock = NSLock()
    
    private init() {}
    
    /// Prepares a sample for streaming. 
    /// Returns the 'Header' buffer (instant trigger) and total frame count.
    public func prepare(url: URL, headerSize: AVAudioFrameCount = 16384) -> (header: AVAudioPCMBuffer, totalFrames: AVAudioFramePosition)? {
        do {
            let file = try getFile(for: url)
            let format = file.processingFormat
            let total = file.length
            
            let loadSize = min(headerSize, AVAudioFrameCount(total))
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: loadSize) else { return nil }
            
            try file.read(into: buffer, frameCount: loadSize)
            return (buffer, total)
        } catch {
            logger.error("D-Stream: Failed to prepare sample \(url.lastPathComponent): \(error.localizedDescription)")
            return nil
        }
    }
    
    /// Loads a specific tile (chunk) of an audio file.
    /// Thread Safety: CALL ONLY FROM BACKGROUND LOADER THREAD.
    public func loadTile(url: URL, startFrame: AVAudioFramePosition, count: AVAudioFrameCount) -> AVAudioPCMBuffer? {
        do {
            let file = try getFile(for: url)
            let format = file.processingFormat
            
            // Safety clamp
            let actualStart = max(0, min(startFrame, file.length - 1))
            let actualCount = min(count, AVAudioFrameCount(file.length - actualStart))
            
            guard actualCount > 0 else { return nil }
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: actualCount) else { return nil }
            
            file.framePosition = actualStart
            try file.read(into: buffer, frameCount: actualCount)
            return buffer
        } catch {
            logger.error("D-Stream: Tile load failed for \(url.lastPathComponent) at \(startFrame): \(error.localizedDescription)")
            return nil
        }
    }
    
    private func getFile(for url: URL) throws -> AVAudioFile {
        lock.lock()
        defer { lock.unlock() }
        
        if let existing = activeFiles[url] {
            return existing
        }
        
        let file = try AVAudioFile(forReading: url)
        activeFiles[url] = file
        return file
    }
    
    public func purgeCache() {
        lock.lock()
        activeFiles.removeAll()
        lock.unlock()
    }
}
