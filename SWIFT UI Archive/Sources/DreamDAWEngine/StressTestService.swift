import Foundation
import DreamDAWModels
import os.log

/// Enterprise service for massive project stress testing.
/// Generates layouts with 200+ tracks and optimized audio chains to verify stability.
public final class StressTestService {
    
    private let logger = Logger(subsystem: "com.dreamdaw", category: "StressTestService")
    
    public init() {}
    
    /// Populates the project with 200 tracks and multiple clips to stress the engine and UI.
    public func run200TrackStressTest(on project: Project) {
        logger.info("Starting 200+ Track Stress Test population...")
        
        // 1. Clear existing tracks
        project.tracks.removeAll()
        
        // 2. Generate 200 tracks
        for i in 0..<200 {
            let isAudio = i % 2 == 0
            let trackType: TrackType = isAudio ? .audio : .midi
            let trackName = "\(isAudio ? "Stress Audio" : "Stress MIDI") \(i + 1)"
            
            let track = Track(
                name: trackName,
                trackType: trackType,
                color: TrackColor.forIndex(i)
            )
            
            // Add a default effect to stress the audio graph (Reverb/Delay)
            let effectType: AudioEffectType = (i % 3 == 0) ? .reverb : .delay
            let effect = AudioEffectConfig(effectType: effectType)
            track.effects.append(effect)
            
            // 3. Add clips to each track
            if isAudio {
                // Add 4 bars of dummy audio clips every 8 bars
                for bar in stride(from: 0, to: 100, by: 8) {
                    let clip = AudioClip(
                        name: "Clip \(bar)",
                        fileURL: URL(fileURLWithPath: "/dummy/path.wav"),
                        position: TimePosition(bars: bar, beatsPerBar: project.timeSignature.beatsPerBar),
                        duration: TimePosition(bars: 4, beatsPerBar: project.timeSignature.beatsPerBar)
                    )
                    track.clips.append(clip)
                }
            } else {
                // Add 4 bars of MIDI clips every 8 bars
                for bar in stride(from: 0, to: 100, by: 8) {
                    var clip = MidiClip(
                        name: "MIDI \(bar)",
                        position: TimePosition(bars: bar, beatsPerBar: project.timeSignature.beatsPerBar),
                        duration: TimePosition(bars: 4, beatsPerBar: project.timeSignature.beatsPerBar)
                    )
                    // Add some dummy notes
                    for n in 0..<8 {
                        clip.notes.append(MidiNote(
                            pitch: 60 + n,
                            velocity: 100,
                            position: TimePosition(beats: Double(n) * 0.5),
                            duration: TimePosition(beats: 0.25)
                        ))
                    }
                    track.midiClips.append(clip)
                }
            }
            
            project.tracks.append(track)
        }
        
        project.isDirty = true
        logger.info("Stress Test population complete: 200 tracks created.")
    }
}
