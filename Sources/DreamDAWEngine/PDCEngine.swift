import Foundation
import DreamDAWModels

/// Responsible for calculating Plugin Delay Compensation (PDC) across the audio graph.
/// It builds a latency map by traversing the routing tree and identifying processing delays.
public final class PDCEngine {
    
    public init() {}
    
    /// Calculates the total latency for each track in the project.
    /// - Parameters:
    ///   - tracks: All tracks in the project.
    /// - Returns: A dictionary mapping Track ID to its cumulative latency in seconds.
    public func calculateLatencies(tracks: [Track]) -> [UUID: Double] {
        var localLatencies: [UUID: Double] = [:]
        
        // 1. Calculate local latency for each track (instrument + internal effects)
        for track in tracks {
            localLatencies[track.id] = calculateLocalTrackLatency(track: track)
        }
        
        // 2. Resolve total path latencies (Path to output)
        var totalPathLatencies: [UUID: Double] = [:]
        for track in tracks {
            totalPathLatencies[track.id] = calculateTotalPathLatency(trackID: track.id, tracks: tracks, localLatencies: localLatencies)
        }
        
        return totalPathLatencies
    }
    
    private func calculateLocalTrackLatency(track: Track) -> Double {
        var total: Double = 0
        
        // Instrument latency
        if let instr = track.instrument, (instr.instrumentType == .vst2 || instr.instrumentType == .vst3) {
            total += PluginHost.shared.getLatency(for: track.id)
        }
        
        // Effects chain latency
        for effect in track.effects where effect.isEnabled {
            if effect.effectType == .vst2 || effect.effectType == .vst3 {
                total += PluginHost.shared.getLatency(for: effect.id)
            }
        }
        
        return total
    }
    
    private func calculateTotalPathLatency(trackID: UUID, tracks: [Track], localLatencies: [UUID: Double]) -> Double {
        var currentTrackID = trackID
        var total: Double = 0
        var visited = Set<UUID>()
        
        while true {
            if visited.contains(currentTrackID) { break } // Circular routing safety
            visited.insert(currentTrackID)
            
            total += localLatencies[currentTrackID] ?? 0.0
            
            guard let track = tracks.first(where: { $0.id == currentTrackID }),
                  let destID = track.outputDestinationID else {
                break
            }
            currentTrackID = destID
        }
        
        return total
    }
}
