import Foundation

// MARK: - MidiNote

/// Represents a single MIDI note.
public struct MidiNote: Identifiable, Codable, Hashable, Sendable {
    public let id: UUID
    public var pitch: Int     // 0-127 (60 = C3)
    public var velocity: Int  // 0-127
    public var position: TimePosition
    public var duration: TimePosition

    public init(
        id: UUID = UUID(),
        pitch: Int,
        velocity: Int = 100,
        position: TimePosition,
        duration: TimePosition = TimePosition(beats: 0.25)
    ) {
        self.id = id
        self.pitch = pitch
        self.velocity = velocity
        self.position = position
        self.duration = duration
    }

    // MARK: - Codable (Migration support)

    private enum CodingKeys: String, CodingKey {
        case id, pitch, velocity, position, duration
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        pitch = try container.decodeIfPresent(Int.self, forKey: .pitch) ?? 60
        velocity = try container.decodeIfPresent(Int.self, forKey: .velocity) ?? 100
        position = try container.decodeIfPresent(TimePosition.self, forKey: .position) ?? .zero
        duration = try container.decodeIfPresent(TimePosition.self, forKey: .duration) ?? TimePosition(beats: 0.25)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(pitch, forKey: .pitch)
        try container.encode(velocity, forKey: .velocity)
        try container.encode(position, forKey: .position)
        try container.encode(duration, forKey: .duration)
    }
}

// MARK: - MidiClip

/// Represents a MIDI clip in the arrangement.
public struct MidiClip: Identifiable, Codable, Hashable, Sendable {
    public let id: UUID
    public var name: String
    public var position: TimePosition
    public var duration: TimePosition
    public var notes: [MidiNote]
    
    // Selection state (not persisted to file, usually, but here it is for simplicity)
    public var isSelected: Bool
    public var colorOverride: TrackColor?

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
    
    // MARK: - Codable (Migration support)

    private enum CodingKeys: String, CodingKey {
        case id, name, position, duration, notes, isSelected, colorOverride
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? "MIDI Clip"
        position = try container.decodeIfPresent(TimePosition.self, forKey: .position) ?? .zero
        duration = try container.decodeIfPresent(TimePosition.self, forKey: .duration) ?? TimePosition(beats: 4)
        notes = try container.decodeIfPresent([MidiNote].self, forKey: .notes) ?? []
        isSelected = try container.decodeIfPresent(Bool.self, forKey: .isSelected) ?? false
        colorOverride = try container.decodeIfPresent(TrackColor.self, forKey: .colorOverride)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(position, forKey: .position)
        try container.encode(duration, forKey: .duration)
        try container.encode(notes, forKey: .notes)
        try container.encode(isSelected, forKey: .isSelected)
        try container.encodeIfPresent(colorOverride, forKey: .colorOverride)
    }

    // MARK: - Computed
    
    /// End position of the clip on the timeline.
    public var endPosition: TimePosition {
        position + duration
    }
    
    /// Check if a given beat is within the clip range.
    public func contains(beat: Double) -> Bool {
        beat >= position.beats && beat < endPosition.beats
    }
}
