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

    /// Offset into the source audio file (trim start). In beats.
    public var trimStartOffset: TimePosition

    /// Gain adjustment for this clip (linear, 1.0 = unity).
    public var gain: Float

    /// Whether the clip is currently selected in the UI.
    public var isSelected: Bool

    /// Optional specific color for this clip (overrides track color).
    public var colorOverride: TrackColor?

    // MARK: - Initialization

    public init(
        id: UUID = UUID(),
        name: String,
        fileURL: URL,
        position: TimePosition,
        duration: TimePosition,
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
        self.trimStartOffset = trimStartOffset
        self.gain = gain
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
