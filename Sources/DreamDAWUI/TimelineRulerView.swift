import AppKit
import Foundation
import DreamDAWModels

// MARK: - TimelineRulerView

/// Renders the bar/beat ruler at the top of the arrangement.
/// Draws bar numbers, beat tick marks, and the loop region.
public final class TimelineRulerView: NSView {

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

    public var loopStart: TimePosition?
    public var loopEnd: TimePosition?
    public var isLooping: Bool = false {
        didSet { needsDisplay = true }
    }

    /// Callback when the user clicks on the ruler to set playhead position.
    public var onClickPosition: ((TimePosition) -> Void)?

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

        // Draw loop region
        if isLooping, let loopStart = loopStart, let loopEnd = loopEnd {
            let loopX1 = CGFloat(loopStart.beats) * pixelsPerBeat - scrollOffset
            let loopX2 = CGFloat(loopEnd.beats) * pixelsPerBeat - scrollOffset
            ctx.setFillColor(DreamTheme.accentSecondary.withAlphaComponent(0.15).cgColor)
            ctx.fill(CGRect(x: loopX1, y: 0, width: loopX2 - loopX1, height: height))

            // Loop region borders
            ctx.setStrokeColor(DreamTheme.accentSecondary.withAlphaComponent(0.6).cgColor)
            ctx.setLineWidth(1.5)
            ctx.move(to: CGPoint(x: loopX1, y: 0))
            ctx.addLine(to: CGPoint(x: loopX1, y: height))
            ctx.move(to: CGPoint(x: loopX2, y: 0))
            ctx.addLine(to: CGPoint(x: loopX2, y: height))
            ctx.strokePath()
        }

        // Draw bar/beat markers
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

        // Playhead indicator on ruler
        let playheadX = CGFloat(playheadPosition.beats) * pixelsPerBeat - scrollOffset
        if playheadX >= -5 && playheadX <= bounds.width + 5 {
            // Triangle marker
            ctx.setFillColor(DreamTheme.playhead.cgColor)
            ctx.move(to: CGPoint(x: playheadX - 5, y: 0))
            ctx.addLine(to: CGPoint(x: playheadX + 5, y: 0))
            ctx.addLine(to: CGPoint(x: playheadX, y: 8))
            ctx.closePath()
            ctx.fillPath()
        }
    }

    // MARK: - Mouse Interaction

    public override func mouseDown(with event: NSEvent) {
        let location = convert(event.locationInWindow, from: nil)
        let beatPosition = (location.x + scrollOffset) / pixelsPerBeat
        let snapped = max(0, beatPosition)
        onClickPosition?(TimePosition(beats: Double(snapped)))
    }
}
