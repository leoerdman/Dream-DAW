import Foundation
import DreamDAWModels

/// Responsible for calculating Plugin Delay Compensation (PDC) across the audio graph.
/// It builds a latency map by traversing the routing tree and identifying processing delays.
public final class PDCEngine {
    
    public init() {}
    
    /// Calculates the total latency for each track in the project.
    /// - Parameters:
    ///   - tracks: All tracks in the project.
    ///   - pluginHost: The host to query for individual plugin latencies.
    /// - Returns: A dictionary mapping Track ID to its cumulative latency in seconds.
    public func calculateLatencies(tracks: [Track]) -> [UUID: Double] {
        var latencyMap: [UUID: Double] = [:]
        
        // 1. Calculate base latency for each track (instrument + internal effects)
        for track in tracks {
            latencyMap[track.id] = calculateLocalTrackLatency(track: track)
        }
        
        // 2. Resolve routing latencies (Buses/Groups)
        // We do this by iteratively adding destination latencies until no more changes occur.
        // This handles recursive/nested routing without complex graph sorting.
        var changed = true
        var iterations = 0
        let maxIterations = tracks.count // Safety cap
        
        while changed && iterations < maxIterations {
            changed = false
            iterations += 1
            
            for track in tracks {
                guard let destID = track.outputDestinationID else { continue }
                let currentLatency = latencyMap[track.id] ?? 0.0
                let destLatency = latencyMap[destID] ?? 0.0
                
                // If the track routes to a destination that has its own latency,
                // that latency must be added to the track's total path latency.
                // But wait, PDC logic usually means tracks arriving at the same bus
                // are aligned relative to that bus's input.
                // Actually, for global output alignment, we need the total path to Master.
            }
        }
        
        // Enterprise PDC logic implementation:
        // We need the "Arrival Time" at Master for each track.
        // Let's use a simpler recursive approach.
        var totalPathLatencies: [UUID: Double] = [:]
        for track in tracks {
            totalPathLatencies[track.id] = calculateTotalPathLatency(trackID: track.id, tracks: tracks, localLatencies: latencyMap)
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
