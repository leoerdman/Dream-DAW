import AppKit
import Foundation

// MARK: - KnobView

/// A reusable rotary knob control (NSView subclass) for DAW-style parameter adjustment.
///
/// - Drag vertically to change value (up = increase, down = decrease)
/// - Draws a 270° arc with a position indicator
/// - Shows value label below the knob
public final class KnobView: NSView {

    // MARK: - Configuration

    /// The current value of the knob.
    public var value: Float = 0.0 {
        didSet {
            value = min(maxValue, max(minValue, value))
            needsDisplay = true
            onValueChanged?(value)
        }
    }

    /// Minimum allowed value.
    public var minValue: Float = -60.0

    /// Maximum allowed value.
    public var maxValue: Float = 6.0

    /// Default value (double-click to reset).
    public var defaultValue: Float = 0.0

    /// Format string for the value label.
    public var valueSuffix: String = " dB"

    /// Knob arc color.
    public var arcColor: NSColor = DreamTheme.warning

    /// Inactive arc color.
    public var inactiveArcColor: NSColor = DreamTheme.knobArcInactive

    /// Callback when value changes.
    public var onValueChanged: ((Float) -> Void)?

    // MARK: - State

    private var isDragging = false
    private var dragStartY: CGFloat = 0
    private var dragStartValue: Float = 0

    // MARK: - Layout Constants

    private let knobDiameter: CGFloat = 32
    private let arcLineWidth: CGFloat = 2.5
    private let labelHeight: CGFloat = 12

    // MARK: - Drawing

    public override var isFlipped: Bool { true }
    public override var acceptsFirstResponder: Bool { true }

    public override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }

        let knobSize = min(bounds.width, bounds.height - labelHeight - 4)
        let knobRadius = knobSize / 2 - arcLineWidth
        let centerX = bounds.midX
        let centerY = knobSize / 2

        // Arc angles: 135° to 405° (sweep = 270°) — in flipped coordinates
        let startAngle: CGFloat = CGFloat.pi * 0.75  // 135°
        let endAngle: CGFloat = CGFloat.pi * 2.25    // 405° = 45°

        // Normalized position [0..1]
        let range = maxValue - minValue
        let normalized = CGFloat((value - minValue) / range)

        // Value angle
        let valueAngle = startAngle + normalized * (endAngle - startAngle)

        // --- Draw inactive arc (full sweep) ---
        ctx.setStrokeColor(inactiveArcColor.cgColor)
        ctx.setLineWidth(arcLineWidth)
        ctx.setLineCap(.round)
        ctx.addArc(center: CGPoint(x: centerX, y: centerY),
                   radius: knobRadius,
                   startAngle: startAngle,
                   endAngle: endAngle,
                   clockwise: false)
        ctx.strokePath()

        // --- Draw active arc (up to current value) ---
        ctx.setStrokeColor(arcColor.cgColor)
        ctx.setLineWidth(arcLineWidth)
        ctx.setLineCap(.round)
        ctx.addArc(center: CGPoint(x: centerX, y: centerY),
                   radius: knobRadius,
                   startAngle: startAngle,
                   endAngle: valueAngle,
                   clockwise: false)
        ctx.strokePath()

        // --- Draw knob indicator dot ---
        let dotRadius: CGFloat = 3
        let dotX = centerX + (knobRadius - 4) * cos(valueAngle)
        let dotY = centerY + (knobRadius - 4) * sin(valueAngle)
        ctx.setFillColor(NSColor.white.cgColor)
        ctx.fillEllipse(in: CGRect(x: dotX - dotRadius, y: dotY - dotRadius,
                                   width: dotRadius * 2, height: dotRadius * 2))

        // --- Draw center circle ---
        let innerRadius: CGFloat = knobRadius * 0.35
        ctx.setFillColor(DreamTheme.knobFill.cgColor)
        ctx.fillEllipse(in: CGRect(x: centerX - innerRadius, y: centerY - innerRadius,
                                   width: innerRadius * 2, height: innerRadius * 2))

        // --- Draw value label ---
        let labelStr: String
        if value <= minValue {
            labelStr = "-∞\(valueSuffix)"
        } else {
            labelStr = String(format: "%.1f%@", value, valueSuffix)
        }

        let attrs: [NSAttributedString.Key: Any] = [
            .font: DreamTheme.fontMonoSmall,
            .foregroundColor: DreamTheme.knobValueText
        ]
        let attrStr = NSAttributedString(string: labelStr, attributes: attrs)
        let textSize = attrStr.size()
        let textX = bounds.midX - textSize.width / 2
        let textY = knobSize + 2
        attrStr.draw(at: NSPoint(x: textX, y: textY))
    }

    // MARK: - Mouse Interaction

    public override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            // Double-click → reset to default
            value = defaultValue
            return
        }
        isDragging = true
        dragStartY = event.locationInWindow.y
        dragStartValue = value
    }

    public override func mouseDragged(with event: NSEvent) {
        guard isDragging else { return }
        let deltaY = event.locationInWindow.y - dragStartY
        let sensitivity: Float = (maxValue - minValue) / 150.0
        let newValue = dragStartValue + Float(deltaY) * sensitivity
        value = min(maxValue, max(minValue, newValue))
    }

    public override func mouseUp(with event: NSEvent) {
        isDragging = false
    }

    // MARK: - Scroll Wheel

    public override func scrollWheel(with event: NSEvent) {
        let sensitivity: Float = (maxValue - minValue) / 300.0
        let delta = Float(event.scrollingDeltaY) * sensitivity
        value = min(maxValue, max(minValue, value + delta))
    }
}
