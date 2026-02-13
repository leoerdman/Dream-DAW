import Foundation

// MARK: - PulseMap

/// Enterprise-grade tempo map that converts between sample frames and musical time.
///
/// Currently supports constant-tempo projects. The architecture is designed for
/// future tempo automation (tempo changes mid-project) — the `TempoEvent` array
/// can hold multiple tempo points, and all conversions will interpolate correctly.
///
/// **Design Rationale**: Musical time (beats/bars) is a *UI illusion* (grid lines).
/// The single source of truth for position is always `Int64` sample frames.
/// This struct provides the math bridge between the two worlds.
public struct PulseMap: Sendable {

    // MARK: - Tempo Events

    /// A tempo change point in the project timeline.
    public struct TempoEvent: Sendable, Codable, Equatable {
        /// Sample frame at which this tempo begins.
        public let sampleFrame: Int64
        /// Beat position at which this tempo begins (cached for O(1) access).
        public let beatPosition: Double
        /// Tempo in BPM.
        public let bpm: Double

        public init(sampleFrame: Int64 = 0, beatPosition: Double = 0, bpm: Double = 120) {
            self.sampleFrame = sampleFrame
            self.beatPosition = beatPosition
            self.bpm = bpm
        }
    }

    // MARK: - Properties

    /// Ordered list of tempo events. Must always contain at least one entry.
    public private(set) var tempoEvents: [TempoEvent]

    /// Project sample rate (e.g. 44100, 48000, 96000).
    public let sampleRate: Double

    // MARK: - Initialization

    /// Creates a PulseMap with a constant tempo.
    public init(bpm: Double = 120, sampleRate: Double = 44100) {
        self.sampleRate = sampleRate
        self.tempoEvents = [TempoEvent(sampleFrame: 0, beatPosition: 0, bpm: bpm)]
    }

    /// Creates a PulseMap from an existing array of tempo events.
    /// - Precondition: `events` must be non-empty and sorted by `sampleFrame`.
    public init(events: [TempoEvent], sampleRate: Double = 44100) {
        precondition(!events.isEmpty, "PulseMap requires at least one tempo event")
        self.sampleRate = sampleRate
        self.tempoEvents = events
    }

    // MARK: - Sample → Beat Conversion

    /// Converts a sample frame position to musical beats.
    ///
    /// For constant tempo: `beats = samples / sampleRate * bpm / 60`
    /// For variable tempo: interpolates across tempo regions.
    ///
    /// - Complexity: O(log N) where N = number of tempo events; O(1) for constant tempo.
    @inlinable
    public func beats(at sampleFrame: Int64) -> Double {
        let event = activeEvent(at: sampleFrame)
        let deltaSamples = Double(sampleFrame - event.sampleFrame)
        let deltaSeconds = deltaSamples / sampleRate
        let deltaBeats = deltaSeconds * (event.bpm / 60.0)
        return event.beatPosition + deltaBeats
    }

    // MARK: - Beat → Sample Conversion

    /// Converts musical beats to the nearest sample frame.
    ///
    /// - Complexity: O(log N) where N = number of tempo events; O(1) for constant tempo.
    @inlinable
    public func sampleFrame(at beats: Double) -> Int64 {
        let event = activeEvent(atBeat: beats)
        let deltaBeats = beats - event.beatPosition
        let deltaSeconds = deltaBeats * (60.0 / event.bpm)
        let deltaSamples = deltaSeconds * sampleRate
        return event.sampleFrame + Int64(deltaSamples)
    }

    // MARK: - Seconds Conversion

    /// Converts a sample frame to seconds (tempo-independent, pure math).
    @inlinable
    public func seconds(at sampleFrame: Int64) -> Double {
        Double(sampleFrame) / sampleRate
    }

    /// Converts seconds to sample frame (tempo-independent, pure math).
    @inlinable
    public func sampleFrame(atSeconds seconds: Double) -> Int64 {
        Int64(seconds * sampleRate)
    }

    // MARK: - Duration Conversion

    /// Converts a duration in beats starting at a given position to sample frames.
    @inlinable
    public func durationInSamples(beats: Double, startingAt startSample: Int64) -> Int64 {
        let startBeats = self.beats(at: startSample)
        let endBeats = startBeats + beats
        let endSample = sampleFrame(at: endBeats)
        return endSample - startSample
    }

    // MARK: - Tempo Query

    /// Returns the BPM at a given sample frame.
    @inlinable
    public func bpm(at sampleFrame: Int64) -> Double {
        activeEvent(at: sampleFrame).bpm
    }

    /// The project's initial BPM (first tempo event).
    @inlinable
    public var initialBPM: Double {
        tempoEvents[0].bpm
    }

    // MARK: - Mutation

    /// Updates the global BPM for constant-tempo projects.
    /// Replaces all tempo events with a single event at the new BPM.
    public mutating func setConstantTempo(_ bpm: Double) {
        tempoEvents = [TempoEvent(sampleFrame: 0, beatPosition: 0, bpm: bpm)]
    }

    // MARK: - Internal Helpers

    /// Finds the active tempo event at a given sample frame.
    @inlinable
    internal func activeEvent(at sampleFrame: Int64) -> TempoEvent {
        // Fast path: constant tempo (single event)
        if tempoEvents.count == 1 { return tempoEvents[0] }

        // Binary search for the last event at or before sampleFrame
        var lo = 0, hi = tempoEvents.count - 1
        while lo < hi {
            let mid = lo + (hi - lo + 1) / 2
            if tempoEvents[mid].sampleFrame <= sampleFrame {
                lo = mid
            } else {
                hi = mid - 1
            }
        }
        return tempoEvents[lo]
    }

    /// Finds the active tempo event at a given beat position.
    @inlinable
    internal func activeEvent(atBeat beat: Double) -> TempoEvent {
        // Fast path: constant tempo
        if tempoEvents.count == 1 { return tempoEvents[0] }

        var lo = 0, hi = tempoEvents.count - 1
        while lo < hi {
            let mid = lo + (hi - lo + 1) / 2
            if tempoEvents[mid].beatPosition <= beat {
                lo = mid
            } else {
                hi = mid - 1
            }
        }
        return tempoEvents[lo]
    }
}
