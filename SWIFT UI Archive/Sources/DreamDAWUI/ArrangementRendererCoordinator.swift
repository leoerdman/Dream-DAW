import Foundation
import AppKit
import DreamDAWModels

/// Coordinator responsible for managing the Metal rendering lifecycle and spatial indexing.
///
/// **Architectural Compliance**: Order #5 (Enterprise Audit).
/// Centralizes rendering-related logic to keep the ViewController thin.
public final class ArrangementRendererCoordinator: NSObject {
    
    // MARK: - Properties
    
    public weak var delegate: ArrangementRendererDelegate?
    private let metalCanvas: TimelineCanvasView
    
    // MARK: - Initialization
    
    public init(metalCanvas: TimelineCanvasView) {
        self.metalCanvas = metalCanvas
        super.init()
        setupNotifications()
    }
    
    // MARK: - Spatial Indexing
    
    /// Rebuilds the QuadTree index for fast hit-testing and culling.
    /// This logic is moved from the ViewController to centralize the "Rendering Source of Truth".
    public func rebuildSpatialIndex(with project: Project) {
        // In the current implementation, we delegate actual rebuilding to the canvas
        // as it owns the layers and QuadTree instance.
        metalCanvas.refreshUI() 
        // Note: TimelineCanvasView.refreshUI() calls its internal rebuildQuadTree()
    }
    
    // MARK: - Rendering Lifecycle
    
    public func refreshRendering() {
        metalCanvas.updateArrangementLayers(fullRedraw: true)
    }
    
    private func setupNotifications() {
        // Listen to scroll events to trigger range-based updates if necessary
        // In the actual project, TimelineCanvasView already listens to its parent scroll view.
    }
    
    @objc private func handleScrollUpdate(_ notification: Notification) {
        // Request visual updates for viewport-relative layers (like clip titles)
        metalCanvas.updateArrangementLayers(fullRedraw: false)
    }
}
