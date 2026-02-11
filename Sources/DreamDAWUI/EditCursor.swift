import Foundation
import DreamDAWModels

// MARK: - EditCursor

/// Represents the "Insert Marker" position in the timeline.
/// This is separate from the playback playhead.
/// - trackID: The track where the cursor is located (for vertical drawing/pasting).
/// - position: The time position on the grid.
public struct EditCursor: Equatable {
    public let trackID: UUID
    public let position: TimePosition
    
    public init(trackID: UUID, position: TimePosition) {
        self.trackID = trackID
        self.position = position
    }
}
