import Foundation
import CoreGraphics
import DreamDAWModels

// MARK: - Interaction Delegate
public protocol TimelineInteractionDelegate: AnyObject {
    /// Request to set the playhead/seek position.
    func interactionDidRequestSeek(to position: TimePosition, on trackID: UUID?)
    
    /// Update selection state for clips.
    func interactionDidUpdateSelection(clipIDs: [UUID], isShift: Bool)
    
    /// Update selection state for tracks.
    func interactionDidRequestTrackSelection(id: UUID, isShift: Bool)
    
    /// Finalize current interaction (e.g. on MouseUp).
    func interactionDidCommitClipsModification(finalState: InteractionState)
    
    /// Adjust loop region start.
    func interactionDidRequestLoopStartChange(to position: TimePosition)
    
    /// Adjust loop region end.
    func interactionDidRequestLoopEndChange(to position: TimePosition)
}

// MARK: - Renderer Delegate
public protocol ArrangementRendererDelegate: AnyObject {
    /// Request to update the visible time range (e.g. during scroll/zoom).
    func rendererDidRequestVisibleTimeRangeUpdate(range: TimeRange)
}
