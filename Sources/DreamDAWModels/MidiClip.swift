import Foundation

// MARK: - MidiNote

/// A single MIDI note event within a clip.
public struct MidiNote: Identifiable, Codable, Hashable, Sendable {
    public let id: UUID
    
    /// MIDI note number (0-127, where 60 = Middle C).
    public var pitch: Int
    
    /// Note-on velocity (0-127).
    public var velocity: Int
    
    /// Start position relative to the clip's start (in beats).
    public var position: TimePosition
    
    /// Duration of the note (in beats).
    public var duration: TimePosition
    
    public init(
        id: UUID = UUID(),
        pitch: Int = 60,
        velocity: Int = 100,
        position: TimePosition = .zero,
        duration: TimePosition = TimePosition(beats: 1)
    ) {
        self.id = id
        self.pitch = min(127, max(0, pitch))
        self.velocity = min(127, max(0, velocity))
        self.position = position
        self.duration = duration
    }
    
    /// End position relative to clip start.
    public var endPosition: TimePosition {
        position + duration
    }
    
    /// Human-readable note name (e.g. "C4", "F#3").
    public var noteName: String {
        let noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
        let octave = (pitch / 12) - 1
        let note = noteNames[pitch % 12]
        return "\(note)\(octave)"
    }
}

// MARK: - MidiClip

/// Represents a MIDI clip placed on a track in the arrangement.
/// Contains MIDI note data that can be edited in a piano roll.
public struct MidiClip: Identifiable, Codable, Hashable, Sendable {
    
    // MARK: - Properties
    
    /// Unique identifier for this clip.
    public let id: UUID
    
    /// Display name for the clip.
    public var name: String
    
    /// Position of the clip's start on the arrangement timeline (in beats).
    public var position: TimePosition
    
    /// Total duration of the clip on the timeline (in beats).
    public var duration: TimePosition
    
    /// MIDI notes contained in this clip.
    public var notes: [MidiNote]
    
    /// Whether the clip is currently selected in the UI.
    public var isSelected: Bool
    
    /// Clip color override (nil = use track color).
    public var colorOverride: TrackColor?
    
    // MARK: - Initialization
    
    public init(
        id: UUID = UUID(),
        name: String = "MIDI Clip",
        position: TimePosition,
        duration: TimePosition = TimePosition(beats: 4),
        notes: [MidiNote] = [],
        isSelected: Bool = false,
        colorOverride: TrackColor? = nil
    ) {
        self.id = id
        self.name = name
        self.position = position
        self.duration = duration
        self.notes = notes
        self.isSelected = isSelected
        self.colorOverride = colorOverride
    }
    
    // MARK: - Computed
    
    /// End position of the clip on the timeline.
    public var endPosition: TimePosition {
        position + duration
    }
    
    /// Whether a given timeline position falls within this clip.
    public func contains(beat: Double) -> Bool {
        beat >= position.beats && beat < endPosition.beats
    }
    
    /// Whether this clip overlaps with a given range.
    public func overlaps(start: TimePosition, end: TimePosition) -> Bool {
        position.beats < end.beats && endPosition.beats > start.beats
    }
}
