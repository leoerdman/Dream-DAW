import AppKit
import Foundation
import DreamDAWModels
import DreamDAWEngine

// MARK: - WaveformRenderer

/// High-performance Core Graphics waveform renderer.
/// Draws peak envelope waveforms with gradient fills inside clip rectangles.
public final class WaveformRenderer {

    // MARK: - Properties

    private let waveformCache: WaveformCache

    // MARK: - Initialization

    public init(waveformCache: WaveformCache) {
        self.waveformCache = waveformCache
    }

    // MARK: - Drawing

    /// Draw waveform for a clip within the given rect.
    ///
    /// - Parameters:
    ///   - ctx: Core Graphics context.
    ///   - clip: The audio clip to draw waveform for.
    ///   - rect: The rect where the waveform should be drawn (clip bounds on canvas).
    ///   - color: Track color for the waveform fill.
    ///   - pixelsPerBeat: Current zoom level.
    ///   - bpm: Current BPM.
    ///   - sampleRate: Audio sample rate.
    public func drawWaveform(
        in ctx: CGContext,
        clip: AudioClip,
        rect: CGRect,
        color: NSColor,
        pixelsPerBeat: CGFloat,
        bpm: Double,
        sampleRate: Double
    ) {
        // Calculate samples per pixel for the current zoom level
        let secondsPerPixel = 1.0 / (pixelsPerBeat * (bpm / 60.0))
        let samplesPerPixel = max(1, Int(secondsPerPixel * sampleRate))

        // Try to get cached waveform data
        guard let waveformData = waveformCache.getCachedWaveform(for: clip.fileURL, samplesPerPixel: samplesPerPixel) else {
            // Trigger async computation if not cached
            waveformCache.getWaveform(for: clip.fileURL, samplesPerPixel: samplesPerPixel) { _ in
                // Will redraw on next frame when data is available
                DispatchQueue.main.async {
                    // Trigger redisplay — the parent view should handle this
                }
            }

            // Draw placeholder
            drawPlaceholder(in: ctx, rect: rect, color: color)
            return
        }

        // Draw the waveform
        let waveformRect = CGRect(
            x: rect.origin.x,
            y: rect.origin.y + DreamTheme.clipTitleHeight,
            width: rect.width,
            height: rect.height - DreamTheme.clipTitleHeight
        )

        let midY = waveformRect.midY
        let halfHeight = waveformRect.height / 2.0

        // Calculate which samples correspond to the visible portion
        let trimOffsetSamples = Int(clip.trimStartOffset.toSeconds(bpm: bpm) * sampleRate)
        let startIndex = trimOffsetSamples / samplesPerPixel

        ctx.saveGState()
        ctx.clip(to: waveformRect)

        // Build the waveform path
        let path = CGMutablePath()
        let pixelCount = Int(rect.width)

        // Top half (positive peaks)
        path.move(to: CGPoint(x: waveformRect.origin.x, y: midY))

        for px in 0..<pixelCount {
            let sampleIndex = startIndex + px
            guard sampleIndex < waveformData.peaks.count else { break }

            let peak = CGFloat(waveformData.peaks[sampleIndex])
            let x = waveformRect.origin.x + CGFloat(px)
            let y = midY - peak * halfHeight * 0.9
            path.addLine(to: CGPoint(x: x, y: y))
        }

        // Bottom half (mirror)
        for px in stride(from: min(pixelCount - 1, waveformData.peaks.count - startIndex - 1), through: 0, by: -1) {
            let sampleIndex = startIndex + px
            guard sampleIndex < waveformData.peaks.count else { continue }

            let peak = CGFloat(waveformData.peaks[sampleIndex])
            let x = waveformRect.origin.x + CGFloat(px)
            let y = midY + peak * halfHeight * 0.9
            path.addLine(to: CGPoint(x: x, y: y))
        }

        path.closeSubpath()

        // Fill with gradient
        let fillColor = color.withAlphaComponent(0.55)
        ctx.setFillColor(fillColor.cgColor)
        ctx.addPath(path)
        ctx.fillPath()

        // Thin center line
        ctx.setStrokeColor(color.withAlphaComponent(0.3).cgColor)
        ctx.setLineWidth(0.5)
        ctx.move(to: CGPoint(x: waveformRect.origin.x, y: midY))
        ctx.addLine(to: CGPoint(x: waveformRect.maxX, y: midY))
        ctx.strokePath()

        ctx.restoreGState()
    }

    /// Draw a placeholder when waveform data is not yet available.
    private func drawPlaceholder(in ctx: CGContext, rect: CGRect, color: NSColor) {
        let waveformRect = CGRect(
            x: rect.origin.x,
            y: rect.origin.y + DreamTheme.clipTitleHeight,
            width: rect.width,
            height: rect.height - DreamTheme.clipTitleHeight
        )
        let midY = waveformRect.midY

        ctx.setStrokeColor(color.withAlphaComponent(0.3).cgColor)
        ctx.setLineWidth(0.5)
        ctx.setLineDash(phase: 0, lengths: [4, 4])
        ctx.move(to: CGPoint(x: waveformRect.origin.x, y: midY))
        ctx.addLine(to: CGPoint(x: waveformRect.maxX, y: midY))
        ctx.strokePath()
        ctx.setLineDash(phase: 0, lengths: [])
    }
}
