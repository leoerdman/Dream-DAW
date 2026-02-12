import Foundation

// MARK: - TimePosition

/// Represents a position or duration on the timeline.
/// Internally stored as beats (quarter notes) for BPM-independent operations.
/// Can be converted to/from samples and seconds given a BPM and sample rate.
public struct TimePosition: Codable, Hashable, Sendable {

    // MARK: - Storage

    /// Position in beats (quarter notes). 1 beat = 1 quarter note.
    public var beats: Double

    // MARK: - Codable (Migration Support)

    private enum CodingKeys: String, CodingKey {
        case beats
    }

    public init(from decoder: Decoder) throws {
        // 1. Try to decode from a single value (Legacy: position was a raw Double)
        if let container = try? decoder.singleValueContainer(),
           let value = try? container.decode(Double.self) {
            self.beats = value
            return
        }

        // 2. Try to decode from a keyed container (Current: struct format)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.beats = try container.decodeIfPresent(Double.self, forKey: .beats) ?? 0.0
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(beats, forKey: .beats)
    }

    // MARK: - Initialization

    public init(beats: Double = 0) {
        self.beats = beats
    }

    public init(bars: Int, beats beatOffset: Double = 0, beatsPerBar: Int = 4) {
        self.beats = Double(bars * beatsPerBar) + beatOffset
    }

    public init(seconds: Double, bpm: Double) {
        self.beats = seconds * (bpm / 60.0)
    }

    public init(samples: Int64, sampleRate: Double, bpm: Double) {
        let seconds = Double(samples) / sampleRate
        self.beats = seconds * (bpm / 60.0)
    }

    // MARK: - Conversion

    /// Convert to seconds given a BPM.
    public func toSeconds(bpm: Double) -> Double {
        guard bpm > 0 else { return 0 }
        return beats * (60.0 / bpm)
    }

    /// Convert to sample position given BPM and sample rate.
    public func toSamples(bpm: Double, sampleRate: Double) -> Int64 {
        let seconds = toSeconds(bpm: bpm)
        return Int64(seconds * sampleRate)
    }

    /// Decompose into bars and beat offset.
    public func toBarsAndBeats(beatsPerBar: Int = 4) -> (bars: Int, beats: Double) {
        let bar = Int(beats) / beatsPerBar
        let beatOffset = beats - Double(bar * beatsPerBar)
        return (bar, beatOffset)
    }

    /// Format as "bars:beats:ticks" string for display.
    public func displayString(beatsPerBar: Int = 4, ticksPerBeat: Int = 480) -> String {
        let (bar, beatOffset) = toBarsAndBeats(beatsPerBar: beatsPerBar)
        let wholeBeat = Int(beatOffset)
        let ticks = Int((beatOffset - Double(wholeBeat)) * Double(ticksPerBeat))
        return String(format: "%d.%d.%03d", bar + 1, wholeBeat + 1, ticks)
    }

    /// Format as "mm:ss.ms" time string for display.
    public func timeDisplayString(bpm: Double) -> String {
        let totalSeconds = toSeconds(bpm: bpm)
        let minutes = Int(totalSeconds) / 60
        let seconds = totalSeconds - Double(minutes * 60)
        return String(format: "%d:%06.3f", minutes, seconds)
    }

    // MARK: - Constants

    public static let zero = TimePosition(beats: 0)
}

// MARK: - Comparable

extension TimePosition: Comparable {
    public static func < (lhs: TimePosition, rhs: TimePosition) -> Bool {
        lhs.beats < rhs.beats
    }
}

// MARK: - Arithmetic

extension TimePosition {
    public static func + (lhs: TimePosition, rhs: TimePosition) -> TimePosition {
        TimePosition(beats: lhs.beats + rhs.beats)
    }

    public static func - (lhs: TimePosition, rhs: TimePosition) -> TimePosition {
        TimePosition(beats: lhs.beats - rhs.beats)
    }

    public static func * (lhs: TimePosition, rhs: Double) -> TimePosition {
        TimePosition(beats: lhs.beats * rhs)
    }

    public static func / (lhs: TimePosition, rhs: Double) -> TimePosition {
        guard rhs != 0 else { return .zero }
        return TimePosition(beats: lhs.beats / rhs)
    }

    public static func += (lhs: inout TimePosition, rhs: TimePosition) {
        lhs.beats += rhs.beats
    }

    public static func -= (lhs: inout TimePosition, rhs: TimePosition) {
        lhs.beats -= rhs.beats
    }
}

// MARK: - TimeRange

/// Represents a range on the timeline.
public struct TimeRange: Codable, Hashable, Sendable {
    public var start: TimePosition
    public var duration: TimePosition
    
    public var end: TimePosition {
        start + duration
    }
    
    public init(start: TimePosition = .zero, duration: TimePosition = .zero) {
        self.start = start
        self.duration = duration
    }
    
    public func contains(_ position: TimePosition) -> Bool {
        position >= start && position < end
    }
    
    public func intersects(_ other: TimeRange) -> Bool {
        start < other.end && other.start < end
    }
}
