import Foundation
import CoreGraphics
import DreamDAWModels

// MARK: - Timeline Interaction

/// Protocol for decoupling mouse/drag interactions from the ArrangementViewController.
public protocol TimelineInteractionDelegate: AnyObject {
    /// Called when a user moves a clip to a new position.
    func interactionDidRequestClipMove(clipID: UUID, newPosition: TimePosition)
    
    /// Called when the selection set of clips changes.
    func interactionDidSelectClips(clipIDs: Set<UUID>)
    
    /// Called when a context menu is requested for a specific clip.
    func interactionDidRequestContextMenu(for clipID: UUID, at point: CGPoint)
}

// MARK: - Arrangement Renderer

/// Protocol for decoupling Metal rendering lifecycle from the ArrangementViewController.
public protocol ArrangementRendererDelegate: AnyObject {
    /// Called when the visible time range changes (e.g., via scrolling).
    func rendererDidRequestVisibleTimeRangeUpdate(range: TimeRange)
}
