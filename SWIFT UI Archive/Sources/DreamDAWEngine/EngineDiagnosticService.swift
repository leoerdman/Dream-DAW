import Foundation
import os.log
import DreamDAWModels
import AVFoundation

/// High-fidelity diagnostic service for monitoring the audio engine's internal state.
/// Designed to pinpoint synchronization and gating issues at sub-second precision.
public final class EngineDiagnosticService {
    
    public static let shared = EngineDiagnosticService()
    
    private let logger = Logger(subsystem: "com.dreamdaw", category: "EngineDiagnostics")
    private var lastLogTime: TimeInterval = 0
    private let logInterval: TimeInterval = 0.5 // 500ms granularity
    
    public struct TrackSnapshot {
        public let id: UUID
        public let name: String
        public let type: TrackType
        public let hasClipAtPlayhead: Bool
        public let isPlayerPlaying: Bool
        public let volume: Float
    }
    
    public struct EngineSnapshot {
        public let absolutePlayhead: Int64
        public let playheadBeats: Double
        public let isTransportPlaying: Bool
        public let tracks: [TrackSnapshot]
    }
    
    private init() {}
    
    /// Dumps a detailed snapshot of the engine state to the console.
    public func logSnapshot(_ snapshot: EngineSnapshot) {
        let now = Date().timeIntervalSince1970
        guard now - lastLogTime >= logInterval else { return }
        lastLogTime = now
        
        let transportStr = snapshot.isTransportPlaying ? "PLAYING" : "STOPPED"
        let timeStr = String(format: "%.3f", snapshot.playheadBeats)
        
        let header = "--- [ENGINE SNAPSHOT] Time: \(timeStr) beats (\(snapshot.absolutePlayhead) frames) | Transport: \(transportStr) ---"
        logger.info("\(header)")
        print(header)
        
        for track in snapshot.tracks {
            let clipStr = track.hasClipAtPlayhead ? "CLIP_PRESENT" : "EMPTY"
            let playStr = track.isPlayerPlaying ? "NODE_ACTIVE" : "NODE_IDLE"
            let volStr = String(format: "%.2f", track.volume)
            
            let line = "  >> Track: [\(track.name)] (\(track.type.rawValue)) | State: \(clipStr) & \(playStr) | Vol: \(volStr)"
            logger.info("\(line)")
            print(line)
        }
        logger.info("--- [/ENGINE SNAPSHOT] ---")
        print("--- [/ENGINE SNAPSHOT] ---")
    }
    
    /// Specialized logging for scheduling events.
    public func logScheduling(trackName: String, clipStart: Double, clipEnd: Double, atHostTime: UInt64) {
        let msg = "[SCHEDULER] Track: \(trackName) | Scheduling clip: \(clipStart) -> \(clipEnd) beats | HostTime: \(atHostTime)"
        logger.info("\(msg)")
        print(msg)
    }
}
