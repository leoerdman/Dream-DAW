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

    // MARK: - Warping & Elastic Time (Sprint 3)

    /// Whether the clip has warping enabled.
    public var isWarped: Bool = false

    /// List of warp markers for sample-accurate time-stretching.
    public var warpMarkers: [WarpMarker] = []

    /// Time-stretch factor. 1.0 = original speed, 0.5 = 2× slower, 2.0 = 2× faster.
    /// Connected to `AVAudioUnitTimePitch.rate` via `TrackMixer`.
    /// Hard limits: 0.25 ... 4.0 (engine safety clamp).
    public var stretchFactor: Double = 1.0

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
        case isWarped, warpMarkers, stretchFactor
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
        stretchFactor = try container.decodeIfPresent(Double.self, forKey: .stretchFactor) ?? 1.0
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
        try container.encode(stretchFactor, forKey: .stretchFactor)
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

    // MARK: - Synchronization

    /// Synchronizes sample-accurate bounds with beat-based positions.
    /// Critical for Metal rendering and engine scheduling.
    public mutating func synchronize(with pulseMap: PulseMap) {
        self.absolutePosition = AbsoluteTime(sampleFrame: pulseMap.sampleFrame(at: position.beats))
        self.absoluteDuration = AbsoluteTime(sampleFrame: pulseMap.durationInSamples(beats: duration.beats, startingAt: absolutePosition.sampleFrame))
    }

    // MARK: - Trim & Warp (Sprint 3: Elastic Time)

    /// Apply a trim operation (no Option key held).
    /// Trim reveals/hides the underlying audio without changing playback speed.
    ///
    /// - Left edge: shifts timeline start, source offset, and reduces duration.
    /// - Right edge: extends or reduces duration only.
    public mutating func applyTrim(deltaBeats: Double, edge: TrimEdge) {
        switch edge {
        case .left:
            // Move start forward/backward + adjust source read offset
            let newPosition = TimePosition(beats: max(0, position.beats + deltaBeats))
            let actualDelta = newPosition.beats - position.beats
            self.position = newPosition
            self.trimStartOffset = TimePosition(beats: max(0, trimStartOffset.beats + actualDelta))
            self.duration = TimePosition(beats: max(0.01, duration.beats - actualDelta))
        case .right:
            // Only change the visible duration
            self.duration = TimePosition(beats: max(0.01, duration.beats + deltaBeats))
        }
    }

    /// Apply an elastic warp/stretch operation (Option key held).
    /// Changes the clip's visual duration and playback rate without altering the source offset.
    /// Pitch is preserved via `AVAudioUnitTimePitch`.
    ///
    /// - Parameters:
    ///   - deltaBeats: Change in beats for the dragged edge.
    ///   - edge: Which edge is being stretched.
    ///   - sourceDurationBeats: Total duration of the source file in beats (for rate calculation).
    public mutating func applyWarp(deltaBeats: Double, edge: TrimEdge, sourceDurationBeats: Double) {
        let newDurationBeats: Double

        switch edge {
        case .right:
            newDurationBeats = max(0.125, duration.beats + deltaBeats) // Minimum 1/8 beat
        case .left:
            // Left-edge warp: adjust position and duration inversely
            let newPosition = TimePosition(beats: max(0, position.beats + deltaBeats))
            let actualDelta = newPosition.beats - position.beats
            self.position = newPosition
            newDurationBeats = max(0.125, duration.beats - actualDelta)
        }

        // Calculate new stretch factor: original source beats / new visual beats
        guard sourceDurationBeats > 0 else { return }
        let newRate = sourceDurationBeats / newDurationBeats

        // Hard limits: protect the audio engine from extreme rates
        guard newRate >= 0.25 && newRate <= 4.0 else { return }

        self.duration = TimePosition(beats: newDurationBeats)
        self.stretchFactor = newRate
        self.isWarped = true
    }
}
