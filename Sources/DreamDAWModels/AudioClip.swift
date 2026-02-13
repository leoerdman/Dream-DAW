import Foundation

// MARK: - AudioClip

/// Represents an audio clip placed on a track in the arrangement.
/// A clip references a source audio file and defines a region within it.
public struct AudioClip: Identifiable, Codable, Hashable, Sendable {

    // MARK: - Properties

    /// Unique identifier for this clip.
    public let id: UUID

    /// Display name for the clip (derived from filename or user-defined).
    public var name: String

    /// URL to the source audio file.
    public var fileURL: URL

    /// Position of the clip's start on the arrangement timeline (in beats).
    public var position: TimePosition

    /// Total duration of the clip on the timeline (in beats).
    public var duration: TimePosition
    
    // PHASE 9.2: Sample-Accurate Clip Bounds
    // These are the engine's source of truth for scheduling.
    // They are kept in sync with `position`/`duration` via PulseMap.
    
    /// Sample-accurate position (engine source of truth).
    public var absolutePosition: AbsoluteTime
    
    /// Sample-accurate duration (engine source of truth).
    public var absoluteDuration: AbsoluteTime

    /// Offset into the source audio file (trim start). In beats.
    public var trimStartOffset: TimePosition

    /// Gain adjustment for this clip (linear, 1.0 = unity).
    public var gain: Float

    /// Whether the clip is currently selected in the UI.
    public var isSelected: Bool

    /// Optional specific color for this clip (overrides track color).
    public var colorOverride: TrackColor?

    /// Total duration of the source audio file in seconds.
    public var sourceDurationSeconds: Double

    // MARK: - Warping (Stage 2)

    /// Whether the clip has warping enabled.
    public var isWarped: Bool = false

    /// List of warp markers for sample-accurate time-stretching.
    public var warpMarkers: [WarpMarker] = []

    // MARK: - Initialization

    public init(
        id: UUID = UUID(),
        name: String,
        fileURL: URL,
        position: TimePosition,
        duration: TimePosition,
        absolutePosition: AbsoluteTime = AbsoluteTime(sampleFrame: 0),
        absoluteDuration: AbsoluteTime = AbsoluteTime(sampleFrame: 0),
        sourceDurationSeconds: Double = 0,
        trimStartOffset: TimePosition = .zero,
        gain: Float = 1.0,
        isSelected: Bool = false,
        colorOverride: TrackColor? = nil
    ) {
        self.id = id
        self.name = name
        self.fileURL = fileURL
        self.position = position
        self.duration = duration
        self.absolutePosition = absolutePosition
        self.absoluteDuration = absoluteDuration
        self.sourceDurationSeconds = sourceDurationSeconds
        self.trimStartOffset = trimStartOffset
        self.gain = gain
        self.isSelected = isSelected
        self.colorOverride = colorOverride
    }

    // MARK: - Codable (Migration support)

    enum CodingKeys: String, CodingKey {
        case id, name, fileURL, position, duration, trimStartOffset, gain, isSelected, colorOverride, sourceDurationSeconds
        case isWarped, warpMarkers
        case absolutePosition, absoluteDuration
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? "Untitled Clip"
        fileURL = try container.decodeIfPresent(URL.self, forKey: .fileURL) ?? URL(fileURLWithPath: "/")
        position = try container.decodeIfPresent(TimePosition.self, forKey: .position) ?? .zero
        duration = try container.decodeIfPresent(TimePosition.self, forKey: .duration) ?? .zero
        
        // PHASE 9.2: Backward-compatible AbsoluteTime deserialization
        absolutePosition = try container.decodeIfPresent(AbsoluteTime.self, forKey: .absolutePosition) ?? AbsoluteTime(sampleFrame: 0)
        absoluteDuration = try container.decodeIfPresent(AbsoluteTime.self, forKey: .absoluteDuration) ?? AbsoluteTime(sampleFrame: 0)
        
        // Migration: Fields added later (Stage 1 & 2)
        trimStartOffset = try container.decodeIfPresent(TimePosition.self, forKey: .trimStartOffset) ?? .zero
        gain = try container.decodeIfPresent(Float.self, forKey: .gain) ?? 1.0
        isSelected = try container.decodeIfPresent(Bool.self, forKey: .isSelected) ?? false
        colorOverride = try container.decodeIfPresent(TrackColor.self, forKey: .colorOverride)
        sourceDurationSeconds = try container.decodeIfPresent(Double.self, forKey: .sourceDurationSeconds) ?? 0.0
        
        isWarped = try container.decodeIfPresent(Bool.self, forKey: .isWarped) ?? false
        warpMarkers = try container.decodeIfPresent([WarpMarker].self, forKey: .warpMarkers) ?? []
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(fileURL, forKey: .fileURL)
        try container.encode(position, forKey: .position)
        try container.encode(duration, forKey: .duration)
        try container.encode(absolutePosition, forKey: .absolutePosition)
        try container.encode(absoluteDuration, forKey: .absoluteDuration)
        try container.encode(trimStartOffset, forKey: .trimStartOffset)
        try container.encode(gain, forKey: .gain)
        try container.encode(isSelected, forKey: .isSelected)
        try container.encodeIfPresent(colorOverride, forKey: .colorOverride)
        try container.encode(sourceDurationSeconds, forKey: .sourceDurationSeconds)
        try container.encode(isWarped, forKey: .isWarped)
        try container.encode(warpMarkers, forKey: .warpMarkers)
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
