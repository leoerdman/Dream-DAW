import Foundation
import AVFoundation
import os.log

/// Enterprise-Grade TileEngine: Lock-Free Disk Streaming
/// Implements Order #1 of Phase 8: Foundation Hardening.
/// Uses SPSC Ring Buffer to decouple Disk I/O (Producer) from Audio Thread (Consumer).
public final class TileEngine: @unchecked Sendable {
    public static let shared = TileEngine()
    
    // Configuration
    // 65536 frames @ 44.1kHz = ~1.5s buffer
    // Ring buffer holds 8 tiles = ~12s of audio per track, plenty for safety
    public let tileSize: AVAudioFrameCount = 65536
    private let ringBufferCapacity = 8 
    
    private let logger = Logger(subsystem: "com.dreamdaw", category: "TileEngine")
    
    // State
    // Map URL -> RingBuffer
    // One RingBuffer per active file stream
    private var streams: [URL: SPSCRingBuffer<AVAudioPCMBuffer>] = [:]
    
    // Active Producer Tasks (keep references to cancel them)
    private var producers: [URL: Task<Void, Never>] = [:]
    
    // We strictly use a Serial Queue for management (Start/Stop streams)
    // Audio Thread ONLY calls `readNextBuffer()` which is lock-free.
    private let managementQueue = DispatchQueue(label: "com.dreamdaw.tileengine.management")
    
    private init() {}
    
    // MARK: - Audio Thread API (Consumer)
    
    /// Fetches the next buffer for the given URL from the ring buffer.
    /// NON-BLOCKING. REAL-TIME SAFE.
    public func readNextBuffer(url: URL) -> AVAudioPCMBuffer? {
        guard let buffer = streams[url] else { return nil }
        return buffer.pop()
    }
    
    // MARK: - Offline / Tools API
    
    /// Synchronously loads a tile. 
    /// WARNING: BLOCKS THREAD. DO NOT CALL FROM REAL-TIME THREAD.
    public func readTileSynchronous(url: URL, startFrame: Int64, count: AVAudioFrameCount) -> AVAudioPCMBuffer? {
        do {
            let file = try AVAudioFile(forReading: url)
            file.framePosition = startFrame
            guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: count) else { return nil }
            try file.read(into: buffer, frameCount: count)
            return buffer
        } catch {
            return nil
        }
    }
    
    // MARK: - Management API (Main/Background Thread)
    
    /// Prepares a file for streaming.
    /// 1. Reads Header (Synchronous or async, caller waits).
    /// 2. Spins up Background Producer Task.
    public func prepare(url: URL) -> (header: AVAudioPCMBuffer, totalFrames: AVAudioFramePosition)? {
        // Sync check: Stop existing producer if any
        stopStreaming(url: url)
        
        do {
            let file = try AVAudioFile(forReading: url)
            let format = file.processingFormat
            let totalFrames = file.length
            
            // 1. Read Initial Header (Instant Start)
            let headerSize: AVAudioFrameCount = 16384
            let startLoad = min(headerSize, AVAudioFrameCount(totalFrames))
            guard let header = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: startLoad) else { return nil }
            try file.read(into: header, frameCount: startLoad)
            
            // 2. Setup Ring Buffer
            let ringBuffer = SPSCRingBuffer<AVAudioPCMBuffer>(capacity: ringBufferCapacity)
            
            // 3. Start Producer Task for the rest
            let producerTask = Task.detached(priority: .userInitiated) { [weak self] in
                guard let self = self else { return }
                await self.producerLoop(url: url, file: file, startFrame: Int64(startLoad), buffer: ringBuffer)
            }
            
            managementQueue.sync {
                self.streams[url] = ringBuffer
                self.producers[url] = producerTask
            }
            
            return (header, totalFrames)
            
        } catch {
            logger.error("TileEngine: Failed to prepare \(url.lastPathComponent): \(error.localizedDescription)")
            return nil
        }
    }
    
    public func stopStreaming(url: URL) {
        managementQueue.sync {
            if let task = producers.removeValue(forKey: url) {
                task.cancel()
            }
            streams.removeValue(forKey: url)
        }
    }
    
    public func stopAll() {
        managementQueue.sync {
            for (_, task) in producers {
                task.cancel()
            }
            producers.removeAll()
            streams.removeAll()
        }
    }
    
    // MARK: - Producer Logic (Background Thread)
    
    private func producerLoop(url: URL, file: AVAudioFile, startFrame: Int64, buffer: SPSCRingBuffer<AVAudioPCMBuffer>) async {
        var readPosition = startFrame
        let total = file.length
        
        logger.info("TileEngine: Producer started for \(url.lastPathComponent)")
        
        while !Task.isCancelled {
            // Check if we reached end of file
            if readPosition >= total {
                break
            }
            
            // Create buffer
            let remaining = total - readPosition
            let framesToRead = min(AVAudioFrameCount(remaining), tileSize)
            
            guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: framesToRead) else { break }
            
            do {
                // Seek & Read (Ok to block here, we are in background task)
                file.framePosition = readPosition
                try file.read(into: pcmBuffer, frameCount: framesToRead)
                
                // Push to Ring Buffer
                var pushed = false
                while !pushed && !Task.isCancelled {
                    pushed = buffer.push(pcmBuffer)
                    if !pushed {
                        // Buffer full, wait a bit
                        try? await Task.sleep(nanoseconds: 1_000_000) // 1ms
                    }
                }
                
                if Task.isCancelled { break }
                readPosition += Int64(framesToRead)
                
            } catch {
                logger.error("TileEngine: Read error: \(error.localizedDescription)")
                break
            }
        }
        
        logger.info("TileEngine: Producer finished for \(url.lastPathComponent)")
    }
}
