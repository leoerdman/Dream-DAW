import AppKit
import Foundation
import DreamDAWModels

/// A pinned background lane for the Master track that stays synced with the horizontal grid.
internal class MasterLaneView: NSView {
    var trackID: UUID?
    var onTrackClicked: (() -> Void)?
    var onEditCursorChanged: ((TimePosition) -> Void)?
    var onBrowserItemDropped: ((UUID, String, String, URL?) -> Void)?
    var isSelected: Bool = false { didSet { needsDisplay = true } }
    
    var scrollOffset: CGFloat = 0 {
        didSet {
            gridLayer.scrollOffset = scrollOffset
        }
    }
    
    var pixelsPerBeat: CGFloat = DreamTheme.defaultPixelsPerBeat {
        didSet {
            gridLayer.pixelsPerBeat = pixelsPerBeat
        }
    }
    
    var timeSignature: TimeSignature = TimeSignature() {
        didSet {
            gridLayer.timeSignature = timeSignature
        }
    }
    
    private let gridLayer = GridLayer()
    
    override init(frame: NSRect = .zero) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = DreamTheme.bgSecondary.cgColor
        
        gridLayer.actions = ["position": NSNull(), "bounds": NSNull()]
        gridLayer.pixelsPerBeat = self.pixelsPerBeat
        gridLayer.timeSignature = self.timeSignature
        layer?.addSublayer(gridLayer)
        
        registerForDraggedTypes([.browserItem])
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self, userInfo: nil))
    }
    
    required init?(coder: NSCoder) { fatalError() }
    
    override func layout() {
        super.layout()
        gridLayer.frame = bounds
        gridLayer.setNeedsDisplay()
    }
    
    override func draw(_ dirtyRect: NSRect) {
        let ctx = NSGraphicsContext.current?.cgContext
        
        // 1. Divider (Bottom) to match standard tracks
        ctx?.setStrokeColor(DreamTheme.divider.cgColor)
        ctx?.setLineWidth(0.5)
        ctx?.move(to: CGPoint(x: 0, y: bounds.height - 0.5))
        ctx?.addLine(to: CGPoint(x: bounds.width, y: bounds.height - 0.5))
        ctx?.strokePath()

        // 2. Selection Highlight
        if isSelected {
            let path = NSBezierPath(rect: bounds)
            NSColor.systemBlue.withAlphaComponent(0.12).set()
            path.fill()
            
            ctx?.setStrokeColor(NSColor.systemBlue.cgColor)
            ctx?.setLineWidth(2.0)
            ctx?.move(to: CGPoint(x: 1, y: 0))
            ctx?.addLine(to: CGPoint(x: 1, y: bounds.height))
            ctx?.strokePath()
        }
    }
    
    override func mouseDown(with event: NSEvent) {
        let location = convert(event.locationInWindow, from: nil)
        let rawBeat = (location.x + scrollOffset) / pixelsPerBeat
        let snapInterval: Double = pixelsPerBeat > 40 ? 0.25 : 1.0
        let clickBeat = (Double(rawBeat) / snapInterval).rounded() * snapInterval
        
        onEditCursorChanged?(TimePosition(beats: max(0, clickBeat)))
        onTrackClicked?()
    }
    
    override func mouseMoved(with event: NSEvent) {
        NSCursor.crosshair.set()
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        return .copy
    }
}
