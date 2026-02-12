import Foundation
import SwiftUI
#if os(macOS)
import AppKit
#endif

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
    case audio  = "audio"
    case midi   = "midi"
    case group  = "group"
    case master = "master"
    
    public var displayName: String {
        switch self {
        case .audio:  return "Audio"
        case .midi:   return "MIDI"
        case .group:  return "Group"
        case .master: return "Master"
        }
    }
    
    public var icon: String {
        switch self {
        case .audio:  return "waveform"
        case .midi:   return "pianokeys"
        case .group:  return "folder.fill"
        case .master: return "speaker.wave.3.fill"
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
    @Published public var effects: [AudioEffectConfig]
    @Published public var instrument: InstrumentConfig?
    
    /// Grouping: The ID of the parent group track (nil if top-level).
    @Published public var parentTrackID: UUID?
    
    /// Routing: The ID of the track where this track's audio is sent (nil = Master).
    @Published public var outputDestinationID: UUID?
    
    /// Grouping: IDs of tracks contained within this group (if trackType is .group).
    @Published public var childTrackIDs: [UUID] = []
    
    /// Grouping: Whether the group is expanded (showing children) or collapsed.
    @Published public var isExpanded: Bool = true

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
        midiClips: [MidiClip] = [],
        effects: [AudioEffectConfig] = [],
        instrument: InstrumentConfig? = nil
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
        self.effects = effects
        self.instrument = instrument
        self.parentTrackID = nil
        self.outputDestinationID = nil
        self.childTrackIDs = []
        self.isExpanded = true
    }

    // MARK: - Codable

    private enum CodingKeys: String, CodingKey {
        case id, name, trackType, color, volume, pan, isMuted, isSoloed, isArmed, height, clips, midiClips, effects, instrument
        case parentTrackID, outputDestinationID, childTrackIDs, isExpanded
    }

    public convenience init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID(),
            name: try container.decodeIfPresent(String.self, forKey: .name) ?? "Untitled Track",
            trackType: try container.decodeIfPresent(TrackType.self, forKey: .trackType) ?? .audio,
            color: try container.decodeIfPresent(TrackColor.self, forKey: .color) ?? .coral,
            volume: try container.decodeIfPresent(Float.self, forKey: .volume) ?? 0.8,
            pan: try container.decodeIfPresent(Float.self, forKey: .pan) ?? 0.0,
            isMuted: try container.decodeIfPresent(Bool.self, forKey: .isMuted) ?? false,
            isSoloed: try container.decodeIfPresent(Bool.self, forKey: .isSoloed) ?? false,
            isArmed: try container.decodeIfPresent(Bool.self, forKey: .isArmed) ?? false,
            height: try container.decodeIfPresent(CGFloat.self, forKey: .height) ?? 80,
            clips: try container.decodeIfPresent([AudioClip].self, forKey: .clips) ?? [],
            midiClips: try container.decodeIfPresent([MidiClip].self, forKey: .midiClips) ?? [],
            effects: try container.decodeIfPresent([AudioEffectConfig].self, forKey: .effects) ?? [],
            instrument: try container.decodeIfPresent(InstrumentConfig.self, forKey: .instrument)
        )
        self.parentTrackID = try container.decodeIfPresent(UUID.self, forKey: .parentTrackID)
        self.outputDestinationID = try container.decodeIfPresent(UUID.self, forKey: .outputDestinationID)
        self.childTrackIDs = try container.decodeIfPresent([UUID].self, forKey: .childTrackIDs) ?? []
        self.isExpanded = try container.decodeIfPresent(Bool.self, forKey: .isExpanded) ?? true
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
        try container.encode(effects, forKey: .effects)
        try container.encodeIfPresent(instrument, forKey: .instrument)
        try container.encodeIfPresent(parentTrackID, forKey: .parentTrackID)
        try container.encodeIfPresent(outputDestinationID, forKey: .outputDestinationID)
        try container.encode(childTrackIDs, forKey: .childTrackIDs)
        try container.encode(isExpanded, forKey: .isExpanded)
    }

    // MARK: - Computed

    /// Effective volume considering mute state and Utility effect gain.
    public var effectiveVolume: Float {
        guard !isMuted else { return 0 }

        // Apply cumulative Utility gain from the effects chain (dB → linear)
        var gainLinear: Float = 1.0
        for effect in effects where effect.effectType == .utility && effect.isEnabled {
            // gainDB: -60 dB = nearly silent, 0 dB = unity, +6 dB = boost
            // Use -60 dB floor as effective -infinity
            if effect.gainDB <= -59.9 {
                return 0  // -∞ dB → silence
            }
            gainLinear *= powf(10.0, effect.gainDB / 20.0)
        }

        return volume * gainLinear
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
