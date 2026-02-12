import AppKit
import Foundation
import MetalKit
import DreamDAWModels

public final class ArrangementRendererCoordinator: NSObject {
    public weak var delegate: ArrangementRendererDelegate?
    private let metalCanvas: TimelineCanvasView
    
    public init(metalCanvas: TimelineCanvasView) {
        self.metalCanvas = metalCanvas
        super.init()
        setupScrollObservation()
    }
    
    private func setupScrollObservation() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleScrollNotification(_:)),
            name: NSView.boundsDidChangeNotification,
            object: nil
        )
    }
    
    @objc private func handleScrollNotification(_ notification: Notification) {
        updateArrangementLayers()
    }
    
    public func rebuildSpatialIndex(with project: Project) {
        // Logic to rebuild QuadTree for fast hit-testing
        metalCanvas.needsDisplay = true
    }
    
    public func updateArrangementLayers() {
        metalCanvas.updateArrangementLayers()
    }
}
