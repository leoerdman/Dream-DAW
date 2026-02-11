import AppKit
import Foundation
import DreamDAWModels

// MARK: - MiniEQCurveView

/// A compact EQ frequency response curve visualization for the effects chain.
/// Draws a simplified frequency response based on the EQ band configurations.
public final class MiniEQCurveView: NSView {

    // MARK: - Properties

    /// The EQ bands to visualize.
    public var bands: [EQBandConfig] = [] {
        didSet { needsDisplay = true }
    }

    public override var isFlipped: Bool { true }

    // MARK: - Drawing

    public override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }

        let w = bounds.width
        let h = bounds.height
        let midY = h / 2

        // Background grid lines
        ctx.setStrokeColor(NSColor(white: 0.2, alpha: 1.0).cgColor)
        ctx.setLineWidth(0.5)
        // Center line (0 dB)
        ctx.move(to: CGPoint(x: 0, y: midY))
        ctx.addLine(to: CGPoint(x: w, y: midY))
        ctx.strokePath()

        // Draw frequency response curve
        guard !bands.isEmpty else { return }

        let enabledBands = bands.filter { $0.isEnabled }
        guard !enabledBands.isEmpty else {
            // All bands disabled — draw flat line
            ctx.setStrokeColor(NSColor(red: 0.35, green: 0.55, blue: 0.85, alpha: 0.6).cgColor)
            ctx.setLineWidth(1.5)
            ctx.move(to: CGPoint(x: 0, y: midY))
            ctx.addLine(to: CGPoint(x: w, y: midY))
            ctx.strokePath()
            return
        }

        // Build response path by sampling at each pixel
        let path = CGMutablePath()
        let maxGain: CGFloat = 12.0  // ±12 dB range

        for px in 0...Int(w) {
            let x = CGFloat(px)
            // Map x to frequency (20Hz to 20kHz, logarithmic)
            let freqNorm = x / w  // 0..1
            let freq = 20.0 * pow(1000.0, freqNorm)  // 20 to 20000

            // Sum gain contributions from all enabled bands
            var totalGain: CGFloat = 0
            for band in enabledBands {
                let bandFreq = CGFloat(band.frequency)
                let bandGain = CGFloat(band.gain)
                let bandBW = CGFloat(band.bandwidth)

                // Simple bell curve approximation
                let octaveDist = log2(freq / bandFreq)
                let sigma = bandBW / 2.0
                let response = bandGain * exp(-(octaveDist * octaveDist) / (2 * sigma * sigma))
                totalGain += response
            }

            // Clamp and map to y coordinate
            let clampedGain = min(maxGain, max(-maxGain, totalGain))
            let y = midY - (clampedGain / maxGain) * (h / 2 - 2)

            if px == 0 {
                path.move(to: CGPoint(x: x, y: y))
            } else {
                path.addLine(to: CGPoint(x: x, y: y))
            }
        }

        // Fill under the curve (subtle)
        let fillPath = path.mutableCopy()!
        fillPath.addLine(to: CGPoint(x: w, y: midY))
        fillPath.addLine(to: CGPoint(x: 0, y: midY))
        fillPath.closeSubpath()
        ctx.addPath(fillPath)
        ctx.setFillColor(NSColor(red: 0.35, green: 0.55, blue: 0.85, alpha: 0.15).cgColor)
        ctx.fillPath()

        // Stroke the curve
        ctx.addPath(path)
        ctx.setStrokeColor(NSColor(red: 0.35, green: 0.55, blue: 0.85, alpha: 0.8).cgColor)
        ctx.setLineWidth(1.5)
        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)
        ctx.strokePath()

        // Draw band frequency dots
        for band in enabledBands {
            let freqNorm = log2(CGFloat(band.frequency) / 20.0) / log2(1000.0)
            let dotX = freqNorm * w
            let dotGain = CGFloat(band.gain)
            let dotY = midY - (dotGain / maxGain) * (h / 2 - 2)

            ctx.setFillColor(NSColor(red: 0.5, green: 0.7, blue: 1.0, alpha: 0.9).cgColor)
            ctx.fillEllipse(in: CGRect(x: dotX - 2, y: dotY - 2, width: 4, height: 4))
        }
    }
}
