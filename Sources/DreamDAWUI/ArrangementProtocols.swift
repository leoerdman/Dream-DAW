import Foundation
import CoreGraphics
import DreamDAWModels

// MARK: - Interaction Delegate
public protocol TimelineInteractionDelegate: AnyObject {
    /// Request to move a clip to a new start time.
    func interactionDidRequestClipMove(clipID: UUID, newPosition: TimePosition)
    
    /// Request to select a set of clips (replacing current selection).
    func interactionDidSelectClips(clipIDs: Set<UUID>)
    
    /// Request to show a context menu for a specific clip.
    func interactionDidRequestContextMenu(for clipID: UUID, at point: CGPoint)
}

// MARK: - Renderer Delegate
public protocol ArrangementRendererDelegate: AnyObject {
    /// Request to update the visible time range (e.g. during scroll/zoom).
    func rendererDidRequestVisibleTimeRangeUpdate(range: TimeRange)
}
