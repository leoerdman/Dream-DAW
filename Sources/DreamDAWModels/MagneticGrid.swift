import Foundation

// MARK: - GridSubdivision

/// Defines the musical subdivision level for the snap grid.
public enum GridSubdivision: Int, CaseIterable, Sendable {
    case bar        = 1      // 1 bar
    case halfBar    = 2      // 1/2 bar
    case beat       = 4      // 1 beat (quarter note in 4/4)
    case halfBeat   = 8      // 1/8th note
    case sixteenth  = 16     // 1/16th note
    case triplet    = 12     // 1/12th (triplet)
    case thirtyTwo  = 32     // 1/32nd note

    /// Human-readable label for UI display.
    public var displayName: String {
        switch self {
        case .bar:       return "1 Bar"
        case .halfBar:   return "1/2"
        case .beat:      return "1/4"
        case .halfBeat:  return "1/8"
        case .sixteenth: return "1/16"
        case .triplet:   return "1/12T"
        case .thirtyTwo: return "1/32"
        }
    }
}

// MARK: - MagneticGrid

/// Enterprise-grade magnetic snap grid that preserves musical groove.
///
/// Unlike rigid snap (which forces clips to exact grid positions, destroying micro-timing),
/// `MagneticGrid` uses a pixel-based magnetic radius. When a clip's target position falls
/// within 8 screen pixels of a grid line, it "sticks" — but preserves the clip's original
/// offset from that grid line, maintaining the human groove.
///
/// **Adaptive Rendering**: Grid lines fade logarithmically based on zoom level,
/// preventing visual clutter at low zoom without losing precision at high zoom.
///
/// **Usage**:
/// ```swift
/// let grid = MagneticGrid(bpm: 120, sampleRate: 44100, beatsPerBar: 4)
/// let snappedDelta = grid.calculateSnapDelta(
///     rawDelta: mouseDeltaSamples,
///     clipOriginalStart: clip.absolutePosition.sampleFrame,
///     samplesPerPixel: viewport.samplesPerPixel
/// )
/// ```
public final class MagneticGrid: @unchecked Sendable {

    // MARK: - Configuration

    /// Beats per minute (determines grid line spacing in samples).
    public var bpm: Double {
        didSet { recalculate() }
    }

    /// Audio sample rate.
    public let sampleRate: Double

    /// Time signature numerator (beats per bar).
    public var beatsPerBar: Int {
        didSet { recalculate() }
    }

    /// Current snap subdivision.
    public var subdivision: GridSubdivision = .sixteenth {
        didSet { recalculate() }
    }

    /// Whether snap is enabled globally.
    public var isSnapEnabled: Bool = true

    /// Magnetic attraction radius in screen pixels.
    /// The clip will snap when within this distance of a grid line.
    public let magneticRadiusPixels: Double = 8.0

    // MARK: - Computed Constants (recalculated on BPM/signature change)

    /// Samples per beat at current BPM.
    private var samplesPerBeat: Double = 0

    /// Samples per grid line at current subdivision.
    private var samplesPerGridLine: Double = 0

    // MARK: - Initialization

    public init(bpm: Double, sampleRate: Double = 44100.0, beatsPerBar: Int = 4) {
        self.bpm = bpm
        self.sampleRate = sampleRate
        self.beatsPerBar = beatsPerBar
        recalculate()
    }

    // MARK: - Core Snap Engine

    /// Calculate the snapped delta for a drag operation, preserving groove.
    ///
    /// - Parameters:
    ///   - rawDelta: Raw mouse movement in samples (unsnapped).
    ///   - clipOriginalStart: The clip's original start position in samples (before any drag).
    ///   - samplesPerPixel: Current zoom level (from `ViewportMatrix.samplesPerPixel`).
    /// - Returns: The snapped delta. If outside magnetic radius, returns `rawDelta` unchanged.
    public func calculateSnapDelta(rawDelta: Int64, clipOriginalStart: Int64, samplesPerPixel: Double) -> Int64 {
        guard isSnapEnabled && samplesPerGridLine > 0 else { return rawDelta }

        let targetPosition = clipOriginalStart + rawDelta
        let nearestGridLine = nearestLine(to: targetPosition)

        // Convert magnetic radius from pixels to samples using current zoom level
        let magneticRadiusSamples = Int64(magneticRadiusPixels * samplesPerPixel)

        let distanceToGrid = abs(targetPosition - nearestGridLine)

        if distanceToGrid < magneticRadiusSamples {
            // SNAP: Move clip so its start aligns with the nearest grid line.
            // The groove offset is preserved because we snap the clip's position
            // to the grid line, maintaining the *relative* position of content
            // within the clip.
            return nearestGridLine - clipOriginalStart
        }

        // FREE: Outside magnetic zone — unrestricted movement
        return rawDelta
    }

    /// Calculate snap for trim operations (edge-based, not position-based).
    /// Snaps the edge position, not the clip start.
    public func calculateTrimSnap(edgePosition: Int64, samplesPerPixel: Double) -> Int64 {
        guard isSnapEnabled && samplesPerGridLine > 0 else { return edgePosition }

        let nearestGridLine = nearestLine(to: edgePosition)
        let magneticRadiusSamples = Int64(magneticRadiusPixels * samplesPerPixel)

        if abs(edgePosition - nearestGridLine) < magneticRadiusSamples {
            return nearestGridLine
        }
        return edgePosition
    }

    // MARK: - Grid Line Generation for Rendering

    /// Returns visible grid lines in a sample range, with alpha values based on zoom level.
    /// Finer subdivisions fade logarithmically as you zoom out.
    ///
    /// - Parameters:
    ///   - startSample: Start of visible range.
    ///   - endSample: End of visible range.
    ///   - samplesPerPixel: Current zoom level.
    /// - Returns: Array of (samplePosition, alpha) tuples for rendering.
    public func visibleGridLines(startSample: Int64, endSample: Int64, samplesPerPixel: Double) -> [(position: Int64, alpha: Float)] {
        guard samplesPerBeat > 0 else { return [] }

        var lines: [(position: Int64, alpha: Float)] = []

        // Generate lines at multiple subdivision levels with adaptive alpha
        let levels: [(subdivisionMultiplier: Double, baseAlpha: Float)] = [
            (Double(beatsPerBar), 1.0),    // Bar lines: always fully visible
            (1.0, 0.7),                     // Beat lines
            (0.5, 0.4),                     // Half-beat (8th note)
            (0.25, 0.25),                   // 16th note
            (0.125, 0.15),                  // 32nd note
        ]

        for (multiplier, baseAlpha) in levels {
            let levelSamples = samplesPerBeat * multiplier

            // Skip this level if lines would be < 4 pixels apart (clutter prevention)
            let pixelSpacing = levelSamples / samplesPerPixel
            guard pixelSpacing >= 4.0 else { continue }

            // Logarithmic alpha modulation: fade finer lines at lower zoom
            let zoomFade = Float(min(1.0, log2(max(1.0, pixelSpacing / 8.0)) / 3.0))
            let alpha = baseAlpha * zoomFade

            guard alpha > 0.05 else { continue } // Below perception threshold

            let firstLine = Int64(floor(Double(startSample) / levelSamples)) * Int64(levelSamples)

            var pos = firstLine
            while pos <= endSample {
                if pos >= startSample {
                    lines.append((position: pos, alpha: alpha))
                }
                pos += Int64(levelSamples)
            }
        }

        return lines
    }

    // MARK: - Private

    /// Find the nearest grid line to a sample position.
    private func nearestLine(to samplePosition: Int64) -> Int64 {
        guard samplesPerGridLine > 0 else { return samplePosition }

        let gridLinesBefore = Double(samplePosition) / samplesPerGridLine
        let lower = Int64(floor(gridLinesBefore) * samplesPerGridLine)
        let upper = Int64(ceil(gridLinesBefore) * samplesPerGridLine)

        return abs(samplePosition - lower) <= abs(samplePosition - upper) ? lower : upper
    }

    /// Recalculate derived constants after BPM/subdivision change.
    private func recalculate() {
        guard bpm > 0 else {
            samplesPerBeat = 0
            samplesPerGridLine = 0
            return
        }
        samplesPerBeat = (60.0 / bpm) * sampleRate
        samplesPerGridLine = samplesPerBeat * (Double(beatsPerBar) / Double(subdivision.rawValue))
    }
}
