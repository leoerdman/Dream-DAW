import Foundation
import CoreGraphics
import DreamDAWModels

// MARK: - Timeline Interaction

/// Protocol for decoupling mouse/drag interactions from the ArrangementViewController.
public protocol TimelineInteractionDelegate: AnyObject {
    /// Called when the user clicks on a track header or empty lane space.
    func interactionDidRequestTrackSelection(id: UUID, isShift: Bool)
    
    /// Called when the user clicks to set the edit cursor / seek.
    func interactionDidRequestSeek(to position: TimePosition, on trackID: UUID?)
    
    /// Called when the user selection of clips changes (marquee or single click).
    func interactionDidUpdateSelection(clipIDs: Set<UUID>, isShift: Bool)
    
    /// Called when a MIDI clip is double-clicked for opening the editor.
    func interactionDidRequestMidiEditor(trackID: UUID, clipID: UUID)
    
    /// Called when clips have been moved or resized (interaction finalized).
    func interactionDidCommitClipsModification()
    
    /// Called when the user drags the loop start marker.
    func interactionDidRequestLoopStartChange(to position: TimePosition)
    
    /// Called when the user drags the loop end marker.
    func interactionDidRequestLoopEndChange(to position: TimePosition)
    
    /// Called when a context menu is requested for a specific clip.
    func interactionDidRequestContextMenu(for clipID: UUID, at point: CGPoint)
}

// MARK: - Arrangement Renderer

/// Protocol for decoupling Metal rendering lifecycle from the ArrangementViewController.
public protocol ArrangementRendererDelegate: AnyObject {
    /// Called when the visible time range changes (e.g., via scrolling).
    func rendererDidRequestVisibleTimeRangeUpdate(range: TimeRange)
}
