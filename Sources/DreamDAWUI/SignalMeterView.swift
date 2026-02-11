import AppKit
import Foundation

// MARK: - SignalMeterView

/// Vertical signal level meter with green→yellow→red gradient.
/// Sits between effect slots to visualize signal level at each point in the chain.
public final class SignalMeterView: NSView {

    // MARK: - Properties

    /// Current level (0.0 = silence, 1.0 = 0 dBFS, >1.0 = clipping).
    public var level: Float = 0.0 {
        didSet { needsDisplay = true }
    }

    /// Peak hold level (decays slowly).
    public var peakLevel: Float = 0.0

    /// Whether this meter is animating.
    public var isActive: Bool = false

    /// The meter width.
    private let meterWidth: CGFloat = 4

    // MARK: - Layout

    public override var isFlipped: Bool { true }

    // MARK: - Drawing

    public override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }

        let meterX = (bounds.width - meterWidth) / 2
        let meterH = bounds.height - 4
        let meterY: CGFloat = 2

        // Background groove
        ctx.setFillColor(NSColor(white: 0.10, alpha: 1.0).cgColor)
        let grooveRect = CGRect(x: meterX, y: meterY, width: meterWidth, height: meterH)
        let groovePath = CGPath(roundedRect: grooveRect, cornerWidth: meterWidth / 2,
                                cornerHeight: meterWidth / 2, transform: nil)
        ctx.addPath(groovePath)
        ctx.fillPath()

        // Active level — draw from bottom (in flipped coords, bottom = meterY + meterH)
        let clampedLevel = CGFloat(min(max(level, 0.0), 1.2))
        let fillH = meterH * clampedLevel / 1.2
        if fillH > 0 {
            let fillY = meterY + meterH - fillH  // bottom-up in flipped coords
            let fillRect = CGRect(x: meterX, y: fillY, width: meterWidth, height: fillH)

            // Color based on level
            let color: NSColor
            if level > 1.0 {
                color = NSColor(red: 0.95, green: 0.25, blue: 0.20, alpha: 1.0) // Red — clipping
            } else if level > 0.75 {
                color = NSColor(red: 0.95, green: 0.80, blue: 0.15, alpha: 1.0) // Yellow
            } else {
                color = NSColor(red: 0.25, green: 0.80, blue: 0.35, alpha: 1.0) // Green
            }

            ctx.setFillColor(color.cgColor)
            let fillPath = CGPath(roundedRect: fillRect, cornerWidth: meterWidth / 2,
                                  cornerHeight: meterWidth / 2, transform: nil)
            ctx.addPath(fillPath)
            ctx.fillPath()
        }

        // Peak indicator line
        if peakLevel > 0.01 {
            let peakNorm = CGFloat(min(peakLevel, 1.2)) / 1.2
            let peakY = meterY + meterH - meterH * peakNorm
            ctx.setStrokeColor(NSColor.white.withAlphaComponent(0.6).cgColor)
            ctx.setLineWidth(1)
            ctx.move(to: CGPoint(x: meterX, y: peakY))
            ctx.addLine(to: CGPoint(x: meterX + meterWidth, y: peakY))
            ctx.strokePath()
        }
    }

    // MARK: - Animation

    /// Simulate a random level for visualization.
    public func simulateLevel() {
        let target = Float.random(in: 0.2...0.85)
        level = level * 0.7 + target * 0.3
        peakLevel = max(peakLevel * 0.98, level)
        if peakLevel < 0.01 { peakLevel = 0 }
    }

    /// Decay levels toward zero.
    public func decay() {
        level = max(0, level * 0.85)
        peakLevel = max(0, peakLevel * 0.97)
        needsDisplay = true
    }
}
