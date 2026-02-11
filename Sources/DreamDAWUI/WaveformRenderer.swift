import AppKit
import Foundation
import DreamDAWModels
import DreamDAWEngine

// MARK: - WaveformRenderer

/// High-performance Core Graphics waveform renderer.
/// Draws multi-band colored waveforms (Bass = warm, Mid = bright, High = shimmer)
/// layered on top of each other inside clip rectangles.
public final class WaveformRenderer: @unchecked Sendable {

    // MARK: - Properties

    private let waveformCache: WaveformCache

    /// Callback to trigger canvas redraw when waveform data becomes available.
    public var onWaveformReady: (() -> Void)?

    // MARK: - Band Colors

    /// Bass band color (warm low-end).
    private static let bassColor = NSColor(red: 0.85, green: 0.25, blue: 0.15, alpha: 0.75)
    /// Mid band color (body/presence).
    private static let midColor = NSColor(red: 0.15, green: 0.75, blue: 0.35, alpha: 0.70)
    /// High band color (air/shimmer).
    private static let highColor = NSColor(red: 0.35, green: 0.65, blue: 0.95, alpha: 0.65)

    // MARK: - Initialization

    public init(waveformCache: WaveformCache) {
        self.waveformCache = waveformCache
    }

    // MARK: - Drawing

    /// Draw multi-band colored waveform for a clip within the given rect.
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

        // Try to get cached multi-band waveform data
        if let multiBandData = waveformCache.getCachedMultiBandWaveform(for: clip.fileURL, samplesPerPixel: samplesPerPixel) {
            drawMultiBandWaveform(ctx: ctx, data: multiBandData, clip: clip, rect: rect, bpm: bpm, sampleRate: sampleRate, samplesPerPixel: samplesPerPixel)
            return
        }

        // Check mono fallback
        if let monoData = waveformCache.getCachedWaveform(for: clip.fileURL, samplesPerPixel: samplesPerPixel) {
            drawMonoWaveform(ctx: ctx, data: monoData, clip: clip, rect: rect, color: color, bpm: bpm, sampleRate: sampleRate, samplesPerPixel: samplesPerPixel)
        } else {
            drawPlaceholder(in: ctx, rect: rect, color: color)
        }

        // Trigger async multi-band computation
        waveformCache.getMultiBandWaveform(for: clip.fileURL, samplesPerPixel: samplesPerPixel) { [weak self] _ in
            DispatchQueue.main.async {
                self?.onWaveformReady?()
            }
        }

        // Also trigger mono as interim fallback
        waveformCache.getWaveform(for: clip.fileURL, samplesPerPixel: samplesPerPixel) { [weak self] _ in
            DispatchQueue.main.async {
                self?.onWaveformReady?()
            }
        }
    }

    // MARK: - Multi-Band Drawing

    private func drawMultiBandWaveform(
        ctx: CGContext,
        data: MultiBandWaveformData,
        clip: AudioClip,
        rect: CGRect,
        bpm: Double,
        sampleRate: Double,
        samplesPerPixel: Int
    ) {
        let waveformRect = CGRect(
            x: rect.origin.x,
            y: rect.origin.y + DreamTheme.clipTitleHeight,
            width: rect.width,
            height: rect.height - DreamTheme.clipTitleHeight
        )

        let midY = waveformRect.midY
        let halfHeight = waveformRect.height / 2.0

        let trimOffsetSamples = Int(clip.trimStartOffset.toSeconds(bpm: bpm) * sampleRate)
        let startIndex = trimOffsetSamples / samplesPerPixel

        ctx.saveGState()
        ctx.clip(to: waveformRect)

        let pixelCount = Int(rect.width)

        // Draw bands back-to-front: Bass (largest), then Mid, then High on top
        // This creates the layered frequency visualization

        // 1. Bass band (warm red/orange) — drawn first, widest
        drawBandPath(
            ctx: ctx, peaks: data.lowPeaks, startIndex: startIndex,
            pixelCount: pixelCount, midY: midY, halfHeight: halfHeight,
            originX: waveformRect.origin.x, color: Self.bassColor, scale: 0.95
        )

        // 2. Mid band (green) — middle layer
        drawBandPath(
            ctx: ctx, peaks: data.midPeaks, startIndex: startIndex,
            pixelCount: pixelCount, midY: midY, halfHeight: halfHeight,
            originX: waveformRect.origin.x, color: Self.midColor, scale: 0.85
        )

        // 3. High band (blue/cyan) — top layer, thinnest
        drawBandPath(
            ctx: ctx, peaks: data.highPeaks, startIndex: startIndex,
            pixelCount: pixelCount, midY: midY, halfHeight: halfHeight,
            originX: waveformRect.origin.x, color: Self.highColor, scale: 0.70
        )

        // Thin center line
        ctx.setStrokeColor(NSColor.white.withAlphaComponent(0.15).cgColor)
        ctx.setLineWidth(0.5)
        ctx.move(to: CGPoint(x: waveformRect.origin.x, y: midY))
        ctx.addLine(to: CGPoint(x: waveformRect.maxX, y: midY))
        ctx.strokePath()

        ctx.restoreGState()
    }

    /// Draw a single band envelope path.
    private func drawBandPath(
        ctx: CGContext,
        peaks: [Float],
        startIndex: Int,
        pixelCount: Int,
        midY: CGFloat,
        halfHeight: CGFloat,
        originX: CGFloat,
        color: NSColor,
        scale: CGFloat
    ) {
        let path = CGMutablePath()

        // Top half (positive)
        path.move(to: CGPoint(x: originX, y: midY))

        for px in 0..<pixelCount {
            let sampleIndex = startIndex + px
            guard sampleIndex < peaks.count else { break }

            let peak = CGFloat(peaks[sampleIndex])
            let x = originX + CGFloat(px)
            let y = midY - peak * halfHeight * scale
            path.addLine(to: CGPoint(x: x, y: y))
        }

        // Bottom half (mirror)
        for px in stride(from: min(pixelCount - 1, peaks.count - startIndex - 1), through: 0, by: -1) {
            let sampleIndex = startIndex + px
            guard sampleIndex < peaks.count else { continue }

            let peak = CGFloat(peaks[sampleIndex])
            let x = originX + CGFloat(px)
            let y = midY + peak * halfHeight * scale
            path.addLine(to: CGPoint(x: x, y: y))
        }

        path.closeSubpath()

        ctx.setFillColor(color.cgColor)
        ctx.addPath(path)
        ctx.fillPath()
    }

    // MARK: - Mono Fallback

    private func drawMonoWaveform(
        ctx: CGContext,
        data: WaveformData,
        clip: AudioClip,
        rect: CGRect,
        color: NSColor,
        bpm: Double,
        sampleRate: Double,
        samplesPerPixel: Int
    ) {
        let waveformRect = CGRect(
            x: rect.origin.x,
            y: rect.origin.y + DreamTheme.clipTitleHeight,
            width: rect.width,
            height: rect.height - DreamTheme.clipTitleHeight
        )

        let midY = waveformRect.midY
        let halfHeight = waveformRect.height / 2.0

        let trimOffsetSamples = Int(clip.trimStartOffset.toSeconds(bpm: bpm) * sampleRate)
        let startIndex = trimOffsetSamples / samplesPerPixel

        ctx.saveGState()
        ctx.clip(to: waveformRect)

        let path = CGMutablePath()
        let pixelCount = Int(rect.width)

        path.move(to: CGPoint(x: waveformRect.origin.x, y: midY))

        for px in 0..<pixelCount {
            let sampleIndex = startIndex + px
            guard sampleIndex < data.peaks.count else { break }

            let peak = CGFloat(data.peaks[sampleIndex])
            let x = waveformRect.origin.x + CGFloat(px)
            let y = midY - peak * halfHeight * 0.9
            path.addLine(to: CGPoint(x: x, y: y))
        }

        for px in stride(from: min(pixelCount - 1, data.peaks.count - startIndex - 1), through: 0, by: -1) {
            let sampleIndex = startIndex + px
            guard sampleIndex < data.peaks.count else { continue }

            let peak = CGFloat(data.peaks[sampleIndex])
            let x = waveformRect.origin.x + CGFloat(px)
            let y = midY + peak * halfHeight * 0.9
            path.addLine(to: CGPoint(x: x, y: y))
        }

        path.closeSubpath()

        let fillColor = color.withAlphaComponent(0.55)
        ctx.setFillColor(fillColor.cgColor)
        ctx.addPath(path)
        ctx.fillPath()

        ctx.setStrokeColor(color.withAlphaComponent(0.3).cgColor)
        ctx.setLineWidth(0.5)
        ctx.move(to: CGPoint(x: waveformRect.origin.x, y: midY))
        ctx.addLine(to: CGPoint(x: waveformRect.maxX, y: midY))
        ctx.strokePath()

        ctx.restoreGState()
    }

    // MARK: - Placeholder

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
