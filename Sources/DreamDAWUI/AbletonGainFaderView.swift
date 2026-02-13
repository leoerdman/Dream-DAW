import AppKit
import Foundation
import DreamDAWModels

/// A custom fader view that mimics Ableton Live's volume control.
/// It supports bidirectional dragging (horizontal + vertical) and double-click to reset.
public final class AbletonGainFaderView: NSView {
    
    // MARK: - Properties
    
    public var value: Double = 0.0 {
        didSet {
            value = max(Double(Track.minFaderDecibels), min(Double(Track.maxFaderDecibels), value))
            needsDisplay = true
        }
    }
    
    public var onValueChanged: ((Double) -> Void)?
    
    private var lastMouseLocation: NSPoint?
    private let sensitivity: Double = 0.4
    
    // MARK: - Initialization
    
    public override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setupUI()
    }
    
    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupUI()
    }
    
    private func setupUI() {
        wantsLayer = true
        layer?.cornerRadius = 2
        layer?.backgroundColor = NSColor(white: 0.15, alpha: 1.0).cgColor
    }
    
    // MARK: - Drawing
    
    public override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        
        let bounds = self.bounds
        
        // Background
        ctx.setFillColor(NSColor(white: 0.12, alpha: 1.0).cgColor)
        ctx.fill(bounds)
        
        // Calculate fill width based on dB value
        // Range: -inf (-60) to +6 dB
        let minDB = Double(Track.minFaderDecibels)
        let maxDB = Double(Track.maxFaderDecibels)
        let normalized = (value - minDB) / (maxDB - minDB)
        
        let fillWidth = bounds.width * CGFloat(normalized)
        let fillRect = NSRect(x: 0, y: 0, width: fillWidth, height: bounds.height)
        
        // Fader color (Ableton teal)
        ctx.setFillColor(NSColor(red: 0.0, green: 0.5, blue: 0.5, alpha: 1.0).cgColor)
        ctx.fill(fillRect)
        
        // Inner rectangle (handle indicator)
        let handleWidth: CGFloat = 2
        let handleX = max(0, min(bounds.width - handleWidth, fillWidth - (handleWidth / 2)))
        let handleRect = NSRect(x: handleX, y: 0, width: handleWidth, height: bounds.height)
        ctx.setFillColor(NSColor.white.withAlphaComponent(0.6).cgColor)
        ctx.fill(handleRect)
        
        // Text label
        let dbString: String
        if value <= minDB + 0.1 {
            dbString = "-inf"
        } else {
            dbString = String(format: "%.1f", value)
        }
        
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 9, weight: .semibold),
            .foregroundColor: NSColor.white
        ]
        
        let stringSize = dbString.size(withAttributes: attributes)
        let textRect = NSRect(
            x: (bounds.width - stringSize.width) / 2,
            y: (bounds.height - stringSize.height) / 2,
            width: stringSize.width,
            height: stringSize.height
        )
        dbString.draw(in: textRect, withAttributes: attributes)
    }
    
    // MARK: - Interaction
    
    public override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            value = 0.0
            onValueChanged?(value)
            return
        }
        lastMouseLocation = event.locationInWindow
    }
    
    public override func mouseDragged(with event: NSEvent) {
        guard let lastLoc = lastMouseLocation else { return }
        
        let currentLoc = event.locationInWindow
        let deltaX = Double(currentLoc.x - lastLoc.x)
        let deltaY = Double(currentLoc.y - lastLoc.y)
        
        // Accumulate both X and Y movement for bidirectional feel
        // Positive X or Positive Y = Increase
        let totalDelta = (deltaX + deltaY) * sensitivity
        
        let oldValue = value
        value += totalDelta
        
        if value != oldValue {
            onValueChanged?(value)
        }
        
        lastMouseLocation = currentLoc
    }
    
    public override func mouseUp(with event: NSEvent) {
        lastMouseLocation = nil
    }
}
