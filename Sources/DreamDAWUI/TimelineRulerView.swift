import AppKit
import Foundation
import DreamDAWModels

// MARK: - TimelineRulerView

/// Renders the bar/beat ruler at the top of the arrangement.
/// Draws bar numbers, beat tick marks, the loop region, and draggable loop markers.
///
/// **Loop Markers:**
/// Two triangular flag markers sit on the ruler — one at `loopStart`, one at `loopEnd`.
/// The user can drag either marker along the ruler to adjust the loop region.
/// The right marker is constrained to never cross the left marker (minimum 1 beat gap).
/// Both markers are always visible (dimmed when loop is off, fully saturated when on).
///
/// **Mouse Interaction:**
/// - Click on a marker → begin dragging that marker.
/// - Click on empty ruler area → set playhead position.
/// - Markers snap to beat boundaries for precision.
public final class TimelineRulerView: NSView {

    // MARK: - Constants

    /// Triangle marker dimensions.
    private static let markerWidth: CGFloat = 8
    private static let markerHeight: CGFloat = 10

    /// Minimum gap between loop markers in beats.
    private static let minimumLoopBeats: Double = 1.0

    /// Hit-test tolerance around marker triangle (pixels).
    private static let markerHitTolerance: CGFloat = 6

    // MARK: - Properties

    public var pixelsPerBeat: CGFloat = DreamTheme.defaultPixelsPerBeat {
        didSet { needsDisplay = true }
    }

    public var scrollOffset: CGFloat = 0 {
        didSet { needsDisplay = true }
    }

    public var bpm: Double = 120.0 {
        didSet { needsDisplay = true }
    }

    public var timeSignature: TimeSignature = TimeSignature() {
        didSet { needsDisplay = true }
    }

    public var playheadPosition: TimePosition = .zero {
        didSet { needsDisplay = true }
    }

    /// Loop region start position. Always valid (defaults to beat 0).
    public var loopStart: TimePosition = .zero {
        didSet { needsDisplay = true }
    }

    /// Loop region end position. Always valid (defaults to 4 bars).
    public var loopEnd: TimePosition = TimePosition(bars: 4) {
        didSet { needsDisplay = true }
    }

    /// Whether looping is currently active (driven by transport controller).
    public var isLooping: Bool = false {
        didSet { needsDisplay = true }
    }

    /// Callback when the user clicks on the ruler to set playhead position.
    public var onClickPosition: ((TimePosition) -> Void)?

    /// Callback when loop start marker is dragged to a new position.
    public var onLoopStartChanged: ((TimePosition) -> Void)?

    /// Callback when loop end marker is dragged to a new position.
    public var onLoopEndChanged: ((TimePosition) -> Void)?

    /// Coordinator for all mouse/gestures logic (Injected by ViewController)
    public var interactionCoordinator: TimelineInteractionCoordinator?

    // MARK: - Drawing

    public override var isFlipped: Bool { true }

    public override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }

        let height = bounds.height
        let beatsPerBar = timeSignature.beatsPerBar

        // Background
        ctx.setFillColor(DreamTheme.bgHeader.cgColor)
        ctx.fill(bounds)

        // Bottom divider line
        ctx.setStrokeColor(DreamTheme.divider.cgColor)
        ctx.setLineWidth(1)
        ctx.move(to: CGPoint(x: 0, y: height - 0.5))
        ctx.addLine(to: CGPoint(x: bounds.width, y: height - 0.5))
        ctx.strokePath()

        // Calculate visible range
        let visibleStartBeat = scrollOffset / pixelsPerBeat
        let visibleEndBeat = (scrollOffset + bounds.width) / pixelsPerBeat

        let startBar = max(0, Int(floor(visibleStartBeat / Double(beatsPerBar))))
        let endBar = Int(ceil(visibleEndBeat / Double(beatsPerBar))) + 1

        // ━━━━━ Loop Region ━━━━━
        drawLoopRegion(ctx: ctx, height: height)

        // ━━━━━ Bar/Beat Markers ━━━━━
        for bar in startBar...endBar {
            let barBeat = Double(bar * beatsPerBar)
            let barX = CGFloat(barBeat) * pixelsPerBeat - scrollOffset

            // Bar line (major tick)
            ctx.setStrokeColor(DreamTheme.textSecondary.cgColor)
            ctx.setLineWidth(1)
            ctx.move(to: CGPoint(x: barX, y: height * 0.3))
            ctx.addLine(to: CGPoint(x: barX, y: height))
            ctx.strokePath()

            // Bar number
            let barNumber = "\(bar + 1)"
            let attrs: [NSAttributedString.Key: Any] = [
                .font: DreamTheme.fontSmall,
                .foregroundColor: DreamTheme.textSecondary
            ]
            let attrString = NSAttributedString(string: barNumber, attributes: attrs)
            attrString.draw(at: CGPoint(x: barX + 4, y: 3))

            // Beat ticks within bar
            if pixelsPerBeat > 15 {
                for beat in 1..<beatsPerBar {
                    let beatX = barX + CGFloat(beat) * pixelsPerBeat
                    ctx.setStrokeColor(DreamTheme.textMuted.cgColor)
                    ctx.setLineWidth(0.5)
                    ctx.move(to: CGPoint(x: beatX, y: height * 0.6))
                    ctx.addLine(to: CGPoint(x: beatX, y: height))
                    ctx.strokePath()
                }
            }

            // Subdivision ticks (sixteenth notes) at high zoom
            if pixelsPerBeat > 40 {
                for beat in 0..<beatsPerBar {
                    for sub in 1..<4 {
                        let subBeat = barBeat + Double(beat) + Double(sub) * 0.25
                        let subX = CGFloat(subBeat) * pixelsPerBeat - scrollOffset
                        ctx.setStrokeColor(DreamTheme.textMuted.withAlphaComponent(0.3).cgColor)
                        ctx.setLineWidth(0.5)
                        ctx.move(to: CGPoint(x: subX, y: height * 0.75))
                        ctx.addLine(to: CGPoint(x: subX, y: height))
                        ctx.strokePath()
                    }
                }
            }
        }

        // ━━━━━ Playhead Indicator ━━━━━
        let playheadX = CGFloat(playheadPosition.beats) * pixelsPerBeat - scrollOffset
        if playheadX >= -5 && playheadX <= bounds.width + 5 {
            // Triangle marker (pointing down)
            ctx.setFillColor(DreamTheme.playhead.cgColor)
            ctx.move(to: CGPoint(x: playheadX - 5, y: 0))
            ctx.addLine(to: CGPoint(x: playheadX + 5, y: 0))
            ctx.addLine(to: CGPoint(x: playheadX, y: 8))
            ctx.closePath()
            ctx.fillPath()
        }

        // ━━━━━ Loop Markers (drawn last — on top of everything) ━━━━━
        drawLoopMarker(ctx: ctx, position: loopStart, side: .left, height: height)
        drawLoopMarker(ctx: ctx, position: loopEnd, side: .right, height: height)
    }

    // MARK: - Loop Region Drawing

    /// Draw the shaded loop region between the two markers.
    private func drawLoopRegion(ctx: CGContext, height: CGFloat) {
        let loopX1 = CGFloat(loopStart.beats) * pixelsPerBeat - scrollOffset
        let loopX2 = CGFloat(loopEnd.beats) * pixelsPerBeat - scrollOffset

        guard loopX2 > loopX1 else { return }

        // Shaded region — more prominent when looping is active
        let regionAlpha: CGFloat = isLooping ? 0.18 : 0.06
        ctx.setFillColor(DreamTheme.accentSecondary.withAlphaComponent(regionAlpha).cgColor)
        ctx.fill(CGRect(x: loopX1, y: 0, width: loopX2 - loopX1, height: height))

        // Top bar (Ableton-style colored strip at the very top of the ruler)
        let barAlpha: CGFloat = isLooping ? 0.7 : 0.25
        ctx.setFillColor(DreamTheme.accentSecondary.withAlphaComponent(barAlpha).cgColor)
        ctx.fill(CGRect(x: loopX1, y: 0, width: loopX2 - loopX1, height: 3))
    }

    // MARK: - Loop Marker Drawing

    /// Marker side determines which direction the flag points.
    private enum MarkerSide { case left, right }

    /// Draw a single loop marker as a triangular flag.
    ///
    /// Left marker (▶|): triangle pointing right, sits on the left edge of the loop.
    /// Right marker (|◀): triangle pointing left, sits on the right edge of the loop.
    private func drawLoopMarker(ctx: CGContext, position: TimePosition, side: MarkerSide, height: CGFloat) {
        let x = CGFloat(position.beats) * pixelsPerBeat - scrollOffset
        let w = Self.markerWidth
        let h = Self.markerHeight

        // Only draw if visible (with tolerance for partial rendering)
        guard x >= -w && x <= bounds.width + w else { return }

        let markerAlpha: CGFloat = isLooping ? 1.0 : 0.4
        let color = DreamTheme.accentSecondary.withAlphaComponent(markerAlpha)

        ctx.saveGState()

        // Draw triangular flag at top of ruler
        ctx.setFillColor(color.cgColor)
        ctx.beginPath()

        switch side {
        case .left:
            // ▶| shape: triangle point on the right, flat edge on the left
            ctx.move(to: CGPoint(x: x, y: 0))          // top-left
            ctx.addLine(to: CGPoint(x: x + w, y: 0))   // top-right (point)
            ctx.addLine(to: CGPoint(x: x, y: h))        // bottom-left
        case .right:
            // |◀ shape: triangle point on the left, flat edge on the right
            ctx.move(to: CGPoint(x: x, y: 0))           // top-right
            ctx.addLine(to: CGPoint(x: x - w, y: 0))    // top-left (point)
            ctx.addLine(to: CGPoint(x: x, y: h))         // bottom-right
        }

        ctx.closePath()
        ctx.fillPath()

        // Vertical line extending down from the marker to the bottom of the ruler
        let lineAlpha: CGFloat = isLooping ? 0.6 : 0.2
        ctx.setStrokeColor(DreamTheme.accentSecondary.withAlphaComponent(lineAlpha).cgColor)
        ctx.setLineWidth(1.5)
        ctx.move(to: CGPoint(x: x, y: 0))
        ctx.addLine(to: CGPoint(x: x, y: height))
        ctx.strokePath()

        ctx.restoreGState()
    }

    // MARK: - Mouse Interaction

    public override func mouseDown(with event: NSEvent) {
        let location = convert(event.locationInWindow, from: nil)
        
        interactionCoordinator?.mouseDownRuler(
            with: event,
            at: location,
            pixelsPerBeat: pixelsPerBeat,
            loopStart: loopStart.beats,
            loopEnd: loopEnd.beats
        )
    }

    public override func mouseDragged(with event: NSEvent) {
        let location = convert(event.locationInWindow, from: nil)

        interactionCoordinator?.mouseDraggedRuler(
            with: event,
            at: location,
            pixelsPerBeat: pixelsPerBeat,
            loopStart: loopStart.beats,
            loopEnd: loopEnd.beats
        )
    }

    public override func mouseUp(with event: NSEvent) {
        interactionCoordinator?.mouseUp(with: event, in: self)
    }

    // MARK: - Hit Testing Logic Removed (Moved to Coordinator)
    
    // MARK: - Cursor Feedback
    // Note: Temporary commented out to avoid using local hit-testing state.
    // In Sprint 2, the Coordinator will provide the cursor state.
    public override func resetCursorRects() {
        // addCursorRect(markerRect(for: loopStart, side: .left), cursor: .resizeLeftRight)
        // addCursorRect(markerRect(for: loopEnd, side: .right), cursor: .resizeLeftRight)
    }
}
