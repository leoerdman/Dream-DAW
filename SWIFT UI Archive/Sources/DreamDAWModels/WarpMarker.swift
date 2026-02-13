import Foundation

/// Represents a synchronization point between an audio sample and the arrangement timeline.
/// Used by the Warping Engine (Stage 2.2) for real-time time-stretching.
public struct WarpMarker: Identifiable, Codable, Hashable, Sendable {

    /// Unique identifier for this marker.
    public let id: UUID

    /// Position within the source audio file (in samples or normalized 0.0...1.0).
    public var sourceSamplePosition: Double

    /// Corresponding position on the arrangement timeline (in beats).
    public var targetBeat: Double

    /// Whether this marker is 'pinned' (fixed anchor during warping).
    public var isPinned: Bool

    public init(
        id: UUID = UUID(),
        sourceSamplePosition: Double,
        targetBeat: Double,
        isPinned: Bool = true
    ) {
        self.id = id
        self.sourceSamplePosition = sourceSamplePosition
        self.targetBeat = targetBeat
        self.isPinned = isPinned
    }
}
