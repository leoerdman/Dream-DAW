import Foundation
import SwiftUI

// MARK: - TrackColor

/// Predefined track colors matching the Ableton-style palette.
public enum TrackColor: Int, Codable, CaseIterable, Sendable {
    case coral = 0
    case orange
    case gold
    case yellow
    case lime
    case green
    case teal
    case cyan
    case sky
    case blue
    case indigo
    case purple
    case magenta
    case pink
    case rose
    case slate

    public var nsColor: NSColor {
        switch self {
        case .coral:   return NSColor(red: 0.94, green: 0.36, blue: 0.30, alpha: 1.0)
        case .orange:  return NSColor(red: 1.00, green: 0.54, blue: 0.10, alpha: 1.0)
        case .gold:    return NSColor(red: 0.96, green: 0.73, blue: 0.19, alpha: 1.0)
        case .yellow:  return NSColor(red: 0.95, green: 0.90, blue: 0.25, alpha: 1.0)
        case .lime:    return NSColor(red: 0.55, green: 0.85, blue: 0.23, alpha: 1.0)
        case .green:   return NSColor(red: 0.22, green: 0.78, blue: 0.35, alpha: 1.0)
        case .teal:    return NSColor(red: 0.16, green: 0.72, blue: 0.63, alpha: 1.0)
        case .cyan:    return NSColor(red: 0.12, green: 0.75, blue: 0.85, alpha: 1.0)
        case .sky:     return NSColor(red: 0.20, green: 0.60, blue: 0.92, alpha: 1.0)
        case .blue:    return NSColor(red: 0.25, green: 0.42, blue: 0.88, alpha: 1.0)
        case .indigo:  return NSColor(red: 0.42, green: 0.32, blue: 0.85, alpha: 1.0)
        case .purple:  return NSColor(red: 0.62, green: 0.30, blue: 0.85, alpha: 1.0)
        case .magenta: return NSColor(red: 0.82, green: 0.25, blue: 0.72, alpha: 1.0)
        case .pink:    return NSColor(red: 0.92, green: 0.35, blue: 0.55, alpha: 1.0)
        case .rose:    return NSColor(red: 0.90, green: 0.40, blue: 0.45, alpha: 1.0)
        case .slate:   return NSColor(red: 0.55, green: 0.58, blue: 0.62, alpha: 1.0)
        }
    }

    public var color: Color {
        Color(nsColor: nsColor)
    }

    /// Assign a color based on track index.
    public static func forIndex(_ index: Int) -> TrackColor {
        let allCases = TrackColor.allCases
        return allCases[index % allCases.count]
    }
}

// MARK: - TrackType

/// Defines the type of content a track holds.
public enum TrackType: String, Codable, CaseIterable, Sendable {
    case audio = "audio"
    case midi  = "midi"
    
    public var displayName: String {
        switch self {
        case .audio: return "Audio"
        case .midi:  return "MIDI"
        }
    }
    
    public var icon: String {
        switch self {
        case .audio: return "waveform"
        case .midi:  return "pianokeys"
        }
    }
}

// MARK: - Track

/// Represents a single track in the arrangement.
public final class Track: ObservableObject, Identifiable, Codable {

    // MARK: - Properties

    public let id: UUID
    @Published public var name: String
    @Published public var trackType: TrackType
    @Published public var color: TrackColor
    @Published public var volume: Float       // 0.0 ... 1.0
    @Published public var pan: Float          // -1.0 ... 1.0
    @Published public var isMuted: Bool
    @Published public var isSoloed: Bool
    @Published public var isArmed: Bool       // Record-armed
    @Published public var height: CGFloat     // Track lane height in points
    @Published public var clips: [AudioClip]
    @Published public var midiClips: [MidiClip]

    // MARK: - Initialization

    public init(
        id: UUID = UUID(),
        name: String = "Audio",
        trackType: TrackType = .audio,
        color: TrackColor = .coral,
        volume: Float = 0.8,
        pan: Float = 0.0,
        isMuted: Bool = false,
        isSoloed: Bool = false,
        isArmed: Bool = false,
        height: CGFloat = 80,
        clips: [AudioClip] = [],
        midiClips: [MidiClip] = []
    ) {
        self.id = id
        self.name = name
        self.trackType = trackType
        self.color = color
        self.volume = volume
        self.pan = pan
        self.isMuted = isMuted
        self.isSoloed = isSoloed
        self.isArmed = isArmed
        self.height = height
        self.clips = clips
        self.midiClips = midiClips
    }

    // MARK: - Codable

    private enum CodingKeys: String, CodingKey {
        case id, name, trackType, color, volume, pan, isMuted, isSoloed, isArmed, height, clips, midiClips
    }

    public convenience init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try container.decode(UUID.self, forKey: .id),
            name: try container.decode(String.self, forKey: .name),
            trackType: try container.decodeIfPresent(TrackType.self, forKey: .trackType) ?? .audio,
            color: try container.decode(TrackColor.self, forKey: .color),
            volume: try container.decode(Float.self, forKey: .volume),
            pan: try container.decode(Float.self, forKey: .pan),
            isMuted: try container.decode(Bool.self, forKey: .isMuted),
            isSoloed: try container.decode(Bool.self, forKey: .isSoloed),
            isArmed: try container.decode(Bool.self, forKey: .isArmed),
            height: try container.decode(CGFloat.self, forKey: .height),
            clips: try container.decodeIfPresent([AudioClip].self, forKey: .clips) ?? [],
            midiClips: try container.decodeIfPresent([MidiClip].self, forKey: .midiClips) ?? []
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(trackType, forKey: .trackType)
        try container.encode(color, forKey: .color)
        try container.encode(volume, forKey: .volume)
        try container.encode(pan, forKey: .pan)
        try container.encode(isMuted, forKey: .isMuted)
        try container.encode(isSoloed, forKey: .isSoloed)
        try container.encode(isArmed, forKey: .isArmed)
        try container.encode(height, forKey: .height)
        try container.encode(clips, forKey: .clips)
        try container.encode(midiClips, forKey: .midiClips)
    }

    // MARK: - Computed

    /// Effective volume considering mute state.
    public var effectiveVolume: Float {
        isMuted ? 0 : volume
    }
    
    /// Whether this track has any content.
    public var isEmpty: Bool {
        clips.isEmpty && midiClips.isEmpty
    }
    
    /// End position of the last clip/midi clip on this track.
    public var endPosition: TimePosition {
        let audioEnd = clips.map(\.endPosition).max() ?? .zero
        let midiEnd = midiClips.map(\.endPosition).max() ?? .zero
        return max(audioEnd, midiEnd)
    }
}
