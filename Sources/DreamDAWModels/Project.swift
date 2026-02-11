import Foundation

// MARK: - TimeSignature

/// Musical time signature (e.g. 4/4, 3/4, 6/8).
public struct TimeSignature: Codable, Hashable, Sendable {
    public var numerator: Int     // Beats per bar
    public var denominator: Int   // Beat unit (4 = quarter note, 8 = eighth note)

    public init(numerator: Int = 4, denominator: Int = 4) {
        self.numerator = numerator
        self.denominator = denominator
    }

    /// Number of quarter-note beats per bar.
    public var beatsPerBar: Int {
        // Convert to quarter-note beats: e.g. 6/8 = 3 quarter-note beats
        numerator * 4 / denominator
    }

    public var displayString: String {
        "\(numerator)/\(denominator)"
    }
}

// MARK: - Project

/// Root model for a Dream DAW project file.
/// Contains all tracks, tempo, and project-level settings.
public final class Project: ObservableObject, Identifiable, Codable {

    // MARK: - Properties

    public let id: UUID
    @Published public var name: String
    @Published public var bpm: Double
    @Published public var timeSignature: TimeSignature
    @Published public var sampleRate: Double
    @Published public var tracks: [Track]

    /// Loop region (nil = loop disabled).
    @Published public var loopStart: TimePosition?
    @Published public var loopEnd: TimePosition?

    /// Project file URL (nil if unsaved).
    public var fileURL: URL?

    // MARK: - Initialization

    public init(
        id: UUID = UUID(),
        name: String = "Untitled Project",
        bpm: Double = 120.0,
        timeSignature: TimeSignature = TimeSignature(),
        sampleRate: Double = 44100.0,
        tracks: [Track] = []
    ) {
        self.id = id
        self.name = name
        self.bpm = bpm
        self.timeSignature = timeSignature
        self.sampleRate = sampleRate
        self.tracks = tracks
    }

    // MARK: - Codable

    private enum CodingKeys: String, CodingKey {
        case id, name, bpm, timeSignature, sampleRate, tracks, loopStart, loopEnd
    }

    public convenience init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try container.decode(UUID.self, forKey: .id),
            name: try container.decode(String.self, forKey: .name),
            bpm: try container.decode(Double.self, forKey: .bpm),
            timeSignature: try container.decode(TimeSignature.self, forKey: .timeSignature),
            sampleRate: try container.decode(Double.self, forKey: .sampleRate),
            tracks: try container.decode([Track].self, forKey: .tracks)
        )
        self.loopStart = try container.decodeIfPresent(TimePosition.self, forKey: .loopStart)
        self.loopEnd = try container.decodeIfPresent(TimePosition.self, forKey: .loopEnd)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(bpm, forKey: .bpm)
        try container.encode(timeSignature, forKey: .timeSignature)
        try container.encode(sampleRate, forKey: .sampleRate)
        try container.encode(tracks, forKey: .tracks)
        try container.encodeIfPresent(loopStart, forKey: .loopStart)
        try container.encodeIfPresent(loopEnd, forKey: .loopEnd)
    }

    // MARK: - Factory

    /// Create a default project with a single MIDI track.
    public static func createDefault() -> Project {
        let project = Project(name: "New Project", bpm: 120.0)
        project.tracks = [
            Track(
                name: "MIDI 1",
                trackType: .midi,
                color: TrackColor.forIndex(0)
            )
        ]
        return project
    }

    // MARK: - Track Management
    
    /// Add a new track to the project.
    public func addTrack(type: TrackType) {
        let index = tracks.count
        let name = "\(type.displayName) \(index + 1)"
        let track = Track(
            name: name,
            trackType: type,
            color: TrackColor.forIndex(index)
        )
        tracks.append(track)
    }

    // MARK: - Computed

    /// Total duration of the project (end of the last clip).
    public var totalDuration: TimePosition {
        var maxEnd = TimePosition.zero
        for track in tracks {
            for clip in track.clips {
                if clip.endPosition > maxEnd {
                    maxEnd = clip.endPosition
                }
            }
            for midiClip in track.midiClips {
                if midiClip.endPosition > maxEnd {
                    maxEnd = midiClip.endPosition
                }
            }
        }
        // Always show at least some bars
        let minimumBars = 32
        let minimumBeats = TimePosition(bars: minimumBars, beatsPerBar: timeSignature.beatsPerBar)
        return max(maxEnd + TimePosition(beats: Double(timeSignature.beatsPerBar * 4)), minimumBeats)
    }

    /// Whether any track in the project is soloed.
    public var hasSoloedTrack: Bool {
        tracks.contains { $0.isSoloed }
    }
}
