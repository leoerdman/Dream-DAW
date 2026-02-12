import Foundation

/// Defines atomic commands that can be sent from the UI/Controller thread
/// to the real-time audio thread without locking.
public enum AudioCommand: Sendable {
    case noteOn(pitch: Int, velocity: Int)
    case noteOff(pitch: Int)
    case allNotesOff
    case parameterChange(id: String, value: Float)
    case automationUpdate(id: String, value: Float, sampleOffset: Int)
}

/// A lightweight wrapper for a command sent to a specific track/instrument.
public struct AudioCommandEnvelope: Sendable {
    public let trackID: UUID
    public let command: AudioCommand
    
    public init(trackID: UUID, command: AudioCommand) {
        self.trackID = trackID
        self.command = command
    }
}
