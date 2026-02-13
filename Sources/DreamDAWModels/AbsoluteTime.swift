import Foundation

// MARK: - AbsoluteTime

/// Sample-accurate time representation — the single source of truth for all
/// positions and durations in the DAW engine.
///
/// Musical time (beats, bars) is derived on-demand via `PulseMap` for UI display only.
/// This eliminates floating-point drift that accumulates with `Double`-based beat storage
/// over long projects (2+ hours).
///
/// **Key Guarantee**: Two `AbsoluteTime` values that differ by even 1 sample
/// will always compare as different, enabling sample-accurate editing at any zoom level.
public struct AbsoluteTime: Equatable, Comparable, Hashable, Codable, Sendable {

    /// The absolute sample frame index (64-bit, supports > 13 million hours at 96kHz).
    public let sampleFrame: Int64

    // MARK: - Initialization

    public init(sampleFrame: Int64 = 0) {
        self.sampleFrame = sampleFrame
    }

    /// Creates from seconds and sample rate (convenience for audio file import).
    public init(seconds: Double, sampleRate: Double) {
        self.sampleFrame = Int64(seconds * sampleRate)
    }

    // MARK: - Musical Time (UI-only, computed on-demand)

    /// Converts to musical beats using the project's tempo map.
    /// Use ONLY for grid drawing and position display — never for audio scheduling.
    @inlinable
    public func toBeats(using pulseMap: PulseMap) -> Double {
        pulseMap.beats(at: sampleFrame)
    }

    /// Converts to seconds (tempo-independent).
    @inlinable
    public func toSeconds(sampleRate: Double) -> Double {
        Double(sampleFrame) / sampleRate
    }

    // MARK: - Bridge to Legacy TimePosition

    /// Converts to the legacy `TimePosition` for backward compatibility.
    /// - Warning: This loses sample-accuracy. Use during migration only.
    public func toTimePosition(bpm: Double, sampleRate: Double) -> TimePosition {
        let beats = PulseMap(bpm: bpm, sampleRate: sampleRate).beats(at: sampleFrame)
        return TimePosition(beats: beats)
    }

    // MARK: - Comparable

    public static func < (lhs: AbsoluteTime, rhs: AbsoluteTime) -> Bool {
        lhs.sampleFrame < rhs.sampleFrame
    }

    // MARK: - Arithmetic

    /// Returns a new AbsoluteTime offset by the given sample count.
    @inlinable
    public func advanced(by samples: Int64) -> AbsoluteTime {
        AbsoluteTime(sampleFrame: sampleFrame + samples)
    }

    /// Returns the distance in samples between two absolute times.
    @inlinable
    public func distance(to other: AbsoluteTime) -> Int64 {
        other.sampleFrame - sampleFrame
    }

    // MARK: - Operators

    public static func + (lhs: AbsoluteTime, rhs: Int64) -> AbsoluteTime {
        AbsoluteTime(sampleFrame: lhs.sampleFrame + rhs)
    }

    public static func - (lhs: AbsoluteTime, rhs: Int64) -> AbsoluteTime {
        AbsoluteTime(sampleFrame: lhs.sampleFrame - rhs)
    }

    public static func - (lhs: AbsoluteTime, rhs: AbsoluteTime) -> Int64 {
        lhs.sampleFrame - rhs.sampleFrame
    }

    // MARK: - Constants

    public static let zero = AbsoluteTime(sampleFrame: 0)
}

// MARK: - TimePosition Bridge Extension

extension TimePosition {
    /// Converts this beat-based time to sample-accurate `AbsoluteTime`.
    /// Uses constant-tempo conversion (suitable for current project model).
    public func toAbsolute(bpm: Double, sampleRate: Double = 44100) -> AbsoluteTime {
        let pulseMap = PulseMap(bpm: bpm, sampleRate: sampleRate)
        return AbsoluteTime(sampleFrame: pulseMap.sampleFrame(at: beats))
    }

    /// Creates a `TimePosition` from an `AbsoluteTime` value.
    /// - Warning: This loses sample-accuracy. Use during migration only.
    public static func fromAbsolute(_ absolute: AbsoluteTime, bpm: Double, sampleRate: Double = 44100) -> TimePosition {
        let pulseMap = PulseMap(bpm: bpm, sampleRate: sampleRate)
        return TimePosition(beats: pulseMap.beats(at: absolute.sampleFrame))
    }
}
