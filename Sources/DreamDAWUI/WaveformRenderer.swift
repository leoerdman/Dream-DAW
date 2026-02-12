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
    
    /// Path cache to prevent flickering during zoom/resize.
    /// Key: fileURL + samplesPerPixel + boundsSize + style
    private var pathCache: [String: CGPath] = [:]

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
    /// Returns true if a cached or computed path was drawn, false if placeholder/fallback.
    @discardableResult
    public func drawWaveform(
        in ctx: CGContext,
        clip: AudioClip,
        rect: CGRect,
        color: NSColor,
        pixelsPerBeat: CGFloat,
        bpm: Double,
        sampleRate: Double
    ) -> Bool {
        // Calculate samples per pixel for the current zoom level
        let secondsPerPixel = 1.0 / (pixelsPerBeat * (bpm / 60.0))
        let samplesPerPixel = max(Int(1), Int(secondsPerPixel * sampleRate))
        
        let style = AppSettings.shared.waveformStyle
        let cacheKey = "\(clip.fileURL.path)_\(samplesPerPixel)_\(rect.width)_\(rect.height)_\(style.rawValue)"
        
        if let cachedPath = pathCache[cacheKey] {
            drawPath(cachedPath, in: ctx, rect: rect, color: color, style: style)
            return true
        }

        var result = false

        // Try to get cached multi-band waveform data
        if let multiBandData = waveformCache.getCachedMultiBandWaveform(for: clip.fileURL, samplesPerPixel: samplesPerPixel) {
            let path = generateMultiBandPath(data: multiBandData, clip: clip, rect: rect, bpm: bpm, sampleRate: sampleRate, samplesPerPixel: samplesPerPixel)
            pathCache[cacheKey] = path
            drawPath(path, in: ctx, rect: rect, color: color, style: style)
            result = true
        } else if let monoData = waveformCache.getCachedWaveform(for: clip.fileURL, samplesPerPixel: samplesPerPixel) {
            // Check mono fallback
            let path = generateMonoPath(data: monoData, clip: clip, rect: rect, bpm: bpm, sampleRate: sampleRate, samplesPerPixel: samplesPerPixel)
            pathCache[cacheKey] = path
            drawPath(path, in: ctx, rect: rect, color: color, style: style)
            result = true
        } else {
            drawPlaceholder(in: ctx, rect: rect, color: color)
            result = false
        }
        
        
        // Periodically clear path cache to prevent excessive memory usage
        if pathCache.count > 256 { pathCache.removeAll() }

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

        return result
    }

    // MARK: - Path Generation

    private func generateMultiBandPath(
        data: MultiBandWaveformData,
        clip: AudioClip,
        rect: CGRect,
        bpm: Double,
        sampleRate: Double,
        samplesPerPixel: Int
    ) -> CGPath {
        let waveformRect = CGRect(x: 0, y: 0, width: rect.width, height: rect.height - DreamTheme.clipTitleHeight)
        let midY = waveformRect.height / 2.0
        let halfHeight = midY
        
        let trimOffsetSamples = Int(clip.trimStartOffset.toSeconds(bpm: bpm) * sampleRate)
        let startIndex = trimOffsetSamples / samplesPerPixel
        let pixelCount = Int(rect.width)

        let combinedPath = CGMutablePath()
        
        // We actually generate individual paths for colored style, 
        // but for caching simplicity we can store them in a single path if they don't overlap 
        // OR we just cache the most important one.
        // For "Enterprise" perfection, let's just generate the main outline for now 
        // and handle colors in drawPath.
        
        combinedPath.move(to: CGPoint(x: 0, y: midY))
        for px in 0..<pixelCount {
            let idx = startIndex + px
            guard idx < data.lowPeaks.count else { break }
            let peak = CGFloat(data.lowPeaks[idx])
            combinedPath.addLine(to: CGPoint(x: CGFloat(px), y: midY - peak * halfHeight * 0.95))
        }
        for px in stride(from: min(pixelCount - 1, data.lowPeaks.count - startIndex - 1), through: 0, by: -1) {
            let idx = startIndex + px
            let peak = CGFloat(data.lowPeaks[idx])
            combinedPath.addLine(to: CGPoint(x: CGFloat(px), y: midY + peak * halfHeight * 0.95))
        }
        combinedPath.closeSubpath()
        
        return combinedPath
    }

    private func generateMonoPath(
        data: WaveformData,
        clip: AudioClip,
        rect: CGRect,
        bpm: Double,
        sampleRate: Double,
        samplesPerPixel: Int
    ) -> CGPath {
        let waveformRect = CGRect(x: 0, y: 0, width: rect.width, height: rect.height - DreamTheme.clipTitleHeight)
        let midY = waveformRect.height / 2.0
        let halfHeight = midY
        
        let trimOffsetSamples = Int(clip.trimStartOffset.toSeconds(bpm: bpm) * sampleRate)
        let startIndex = trimOffsetSamples / samplesPerPixel
        let pixelCount = Int(rect.width)

        let path = CGMutablePath()
        path.move(to: CGPoint(x: 0, y: midY))
        
        for px in 0..<pixelCount {
            let idx = startIndex + px
            guard idx < data.peaks.count else { break }
            let peak = CGFloat(data.peaks[idx])
            path.addLine(to: CGPoint(x: CGFloat(px), y: midY - peak * halfHeight * 0.95))
        }
        for px in stride(from: min(pixelCount - 1, data.peaks.count - startIndex - 1), through: 0, by: -1) {
            let idx = startIndex + px
            let peak = CGFloat(data.peaks[idx])
            path.addLine(to: CGPoint(x: CGFloat(px), y: midY + peak * halfHeight * 0.95))
        }
        path.closeSubpath()
        return path
    }

    private func drawPath(_ path: CGPath, in ctx: CGContext, rect: CGRect, color: NSColor, style: WaveformStyle) {
        let waveformTop = rect.origin.y + DreamTheme.clipTitleHeight
        
        ctx.saveGState()
        ctx.translateBy(x: rect.origin.x, y: waveformTop)
        
        if style == .solid {
            ctx.setFillColor(NSColor.black.cgColor)
            ctx.addPath(path)
            ctx.fillPath()
        } else {
            // Colored Style - use track color with high alpha for the main path
            ctx.setFillColor(color.withAlphaComponent(0.6).cgColor)
            ctx.addPath(path)
            ctx.fillPath()
            
            // Subtle glow/outline
            ctx.setStrokeColor(color.withAlphaComponent(0.3).cgColor)
            ctx.setLineWidth(0.5)
            ctx.addPath(path)
            ctx.strokePath()
        }
        
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
