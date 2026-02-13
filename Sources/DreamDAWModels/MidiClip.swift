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
    
    // PHASE 9.2: Sample-Accurate Clip Bounds
    /// Sample-accurate position (engine source of truth).
    public var absolutePosition: AbsoluteTime
    /// Sample-accurate duration (engine source of truth).
    public var absoluteDuration: AbsoluteTime
    
    // Selection state
    public var isSelected: Bool
    public var colorOverride: TrackColor?

    public init(
        id: UUID = UUID(),
        name: String = "MIDI Clip",
        position: TimePosition,
        duration: TimePosition = TimePosition(beats: 4),
        notes: [MidiNote] = [],
        absolutePosition: AbsoluteTime = AbsoluteTime(sampleFrame: 0),
        absoluteDuration: AbsoluteTime = AbsoluteTime(sampleFrame: 0),
        isSelected: Bool = false,
        colorOverride: TrackColor? = nil
    ) {
        self.id = id
        self.name = name
        self.position = position
        self.duration = duration
        self.notes = notes
        self.absolutePosition = absolutePosition
        self.absoluteDuration = absoluteDuration
        self.isSelected = isSelected
        self.colorOverride = colorOverride
    }
    
    // MARK: - Codable (Migration support)

    private enum CodingKeys: String, CodingKey {
        case id, name, position, duration, notes, isSelected, colorOverride
        case absolutePosition, absoluteDuration
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? "MIDI Clip"
        position = try container.decodeIfPresent(TimePosition.self, forKey: .position) ?? .zero
        duration = try container.decodeIfPresent(TimePosition.self, forKey: .duration) ?? TimePosition(beats: 4)
        notes = try container.decodeIfPresent([MidiNote].self, forKey: .notes) ?? []
        // PHASE 9.2: Backward-compatible AbsoluteTime deserialization
        absolutePosition = try container.decodeIfPresent(AbsoluteTime.self, forKey: .absolutePosition) ?? AbsoluteTime(sampleFrame: 0)
        absoluteDuration = try container.decodeIfPresent(AbsoluteTime.self, forKey: .absoluteDuration) ?? AbsoluteTime(sampleFrame: 0)
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
        try container.encode(absolutePosition, forKey: .absolutePosition)
        try container.encode(absoluteDuration, forKey: .absoluteDuration)
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

    // MARK: - Synchronization

    /// Synchronizes sample-accurate bounds with beat-based positions.
    /// Critical for Metal rendering and engine scheduling.
    public mutating func synchronize(with pulseMap: PulseMap) {
        self.absolutePosition = AbsoluteTime(sampleFrame: pulseMap.sampleFrame(at: position.beats))
        self.absoluteDuration = AbsoluteTime(sampleFrame: pulseMap.durationInSamples(beats: duration.beats, startingAt: absolutePosition.sampleFrame))
    }
}
