import AppKit
import Foundation

// MARK: - SignalMeterView

/// Vertical signal level meter with configurable signal type coloring.
///
/// **Signal Types:**
/// - `.audio` (default): Standard green→yellow→red gradient
/// - `.midi`: Yellow→orange→red gradient (distinct from audio)
///
/// Level 0.0 = silence, 1.0 = 0 dBFS, >1.0 = clipping.
public final class SignalMeterView: NSView {

    // MARK: - Signal Type (Color Mode)

    /// Determines the color palette used for the meter fill.
    public enum SignalType {
        /// Audio signal — green base, yellow at high levels, red on clip.
        case audio
        /// MIDI signal — yellow/amber base, orange at high levels, red on clip.
        case midi
    }

    // MARK: - Properties

    /// Current level (0.0 = silence, 1.0 = 0 dBFS, >1.0 = clipping).
    public var level: Float = 0.0 {
        didSet { needsDisplay = true }
    }

    /// Signal type determines the color palette.
    public var signalType: SignalType = .audio {
        didSet { needsDisplay = true }
    }

    /// Whether this meter is animating.
    public var isActive: Bool = false

    /// The meter bar width.
    private let meterWidth: CGFloat = 4

    // MARK: - Color Palettes

    /// Returns the gradient segments for the current signal type.
    /// Each segment: (threshold in 0...1.2 range, fill color)
    private var colorSegments: [(threshold: CGFloat, color: NSColor)] {
        switch signalType {
        case .audio:
            return [
                (0.70, NSColor(red: 0.25, green: 0.80, blue: 0.35, alpha: 1.0)),  // Green
                (0.90, NSColor(red: 0.95, green: 0.80, blue: 0.15, alpha: 1.0)),  // Yellow
                (1.20, NSColor(red: 0.95, green: 0.25, blue: 0.20, alpha: 1.0)),  // Red
            ]
        case .midi:
            return [
                (0.70, NSColor(red: 0.95, green: 0.75, blue: 0.20, alpha: 1.0)),  // Amber/Yellow
                (0.90, NSColor(red: 0.95, green: 0.55, blue: 0.15, alpha: 1.0)),  // Orange
                (1.20, NSColor(red: 0.95, green: 0.25, blue: 0.20, alpha: 1.0)),  // Red
            ]
        }
    }

    // MARK: - Layout

    // Use standard (non-flipped) coordinate system: y=0 at bottom, y increases upward.
    // This ensures the meter naturally fills from bottom to top.
    public override var isFlipped: Bool { false }

    // MARK: - Drawing

    public override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }

        let meterX = (bounds.width - meterWidth) / 2
        let pad: CGFloat = 2
        let meterH = bounds.height - pad * 2
        let meterBottom: CGFloat = pad

        // Background groove
        ctx.setFillColor(DreamTheme.meterBackground.cgColor)
        let grooveRect = CGRect(x: meterX, y: meterBottom, width: meterWidth, height: meterH)
        let groovePath = CGPath(roundedRect: grooveRect, cornerWidth: meterWidth / 2,
                                cornerHeight: meterWidth / 2, transform: nil)
        ctx.addPath(groovePath)
        ctx.fillPath()

        // Active level — fills from bottom upward
        let clampedLevel = CGFloat(min(max(level, 0.0), 1.2))
        guard clampedLevel > 0 else { return }

        let fillNorm = clampedLevel / 1.2  // Normalized 0..1

        // Draw fill with rounded corners by clipping to groove shape
        ctx.saveGState()
        ctx.addPath(groovePath)
        ctx.clip()

        let segments = colorSegments
        var drawnH: CGFloat = 0

        for seg in segments {
            let segTopNorm = seg.threshold / 1.2
            let segBottomNorm = drawnH / meterH
            if fillNorm <= segBottomNorm { break }

            let segEndNorm = min(fillNorm, segTopNorm)
            let segH = (segEndNorm - segBottomNorm) * meterH
            guard segH > 0 else { continue }

            let segRect = CGRect(x: meterX, y: meterBottom + drawnH, width: meterWidth, height: segH)
            ctx.setFillColor(seg.color.cgColor)
            ctx.fill(segRect)

            drawnH += segH
        }

        ctx.restoreGState()
    }

    // MARK: - Level Helpers

    /// Decay levels toward zero (smooth visual falloff).
    public func decay() {
        level = max(0, level * 0.85)
        needsDisplay = true
    }
}
