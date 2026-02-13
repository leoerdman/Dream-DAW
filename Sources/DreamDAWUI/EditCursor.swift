import Foundation
import DreamDAWModels

// MARK: - EditCursor

/// Represents the "Insert Marker" position in the timeline.
/// This is separate from the playback playhead.
/// - trackID: The track where the cursor is located (for vertical drawing/pasting).
/// - position: The time position on the grid.
public struct EditCursor: Equatable {
    public let trackIDs: Set<UUID>
    public let position: TimePosition
    
    public init(trackIDs: Set<UUID>, position: TimePosition) {
        self.trackIDs = trackIDs
        self.position = position
    }
}
