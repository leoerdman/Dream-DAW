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

    // MARK: - Codable (Migration Support)

    private enum CodingKeys: String, CodingKey {
        case numerator, denominator
    }

    public init(from decoder: Decoder) throws {
        // 1. Try to decode from a keyed container (Current)
        if let container = try? decoder.container(keyedBy: CodingKeys.self) {
            self.numerator = try container.decodeIfPresent(Int.self, forKey: .numerator) ?? 4
            self.denominator = try container.decodeIfPresent(Int.self, forKey: .denominator) ?? 4
            return
        }

        // 2. Try to decode from a single string (Legacy: "4/4")
        if let container = try? decoder.singleValueContainer(),
           let value = try? container.decode(String.self) {
            let components = value.components(separatedBy: "/")
            if components.count == 2,
               let num = Int(components[0]),
               let den = Int(components[1]) {
                self.numerator = num
                self.denominator = den
                return
            }
        }

        // Fallback
        self.numerator = 4
        self.denominator = 4
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(numerator, forKey: .numerator)
        try container.encode(denominator, forKey: .denominator)
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

// MARK: - Musical Key

public enum ProjectKeyTonic: String, Codable, CaseIterable, Sendable {
    case c = "C"
    case cSharpDFlat = "C#/Db"
    case d = "D"
    case dSharpEFlat = "D#/Eb"
    case e = "E"
    case f = "F"
    case fSharpGFlat = "F#/Gb"
    case g = "G"
    case gSharpAFlat = "G#/Ab"
    case a = "A"
    case aSharpBFlat = "A#/Bb"
    case b = "B"
}

public enum ProjectKeyMode: String, Codable, CaseIterable, Sendable {
    case major = "Major"
    case minor = "Minor"
    case dorian = "Dorian"
    case phrygian = "Phrygian"
    case lydian = "Lydian"
    case mixolydian = "Mixolydian"
    case locrian = "Locrian"
}

public enum TrackPanelKind: String, Codable, CaseIterable, Sendable {
    case detail
    case pianoRoll
    case audioClip
}

public struct TrackPanelState: Codable, Hashable, Sendable {
    public var kind: TrackPanelKind
    public var midiClipID: UUID?
    public var audioClipID: UUID?

    public init(kind: TrackPanelKind = .detail, midiClipID: UUID? = nil, audioClipID: UUID? = nil) {
        self.kind = kind
        self.midiClipID = midiClipID
        self.audioClipID = audioClipID
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
    @Published public var isLooping: Bool
    @Published public var loopStart: TimePosition?
    @Published public var loopEnd: TimePosition?

    /// Master track — always present, controls master output volume/pan.
    @Published public var masterTrack: Track

    /// Project file URL (nil if unsaved).
    @Published public var fileURL: URL?

    /// View state persistence (Zoom level in pixels per beat)
    public var viewZoomScale: Double?
    
    /// View state persistence (Horizontal scroll position in beats)
    public var viewScrollPosition: Double?

    /// View state persistence (browser panel width in points)
    public var viewBrowserWidth: Double?

    /// Multi-selection: set of all currently selected track IDs.
    /// This is runtime-only UI state — NOT persisted to the project file.
    public let actionHistory = ActionHistory()
    
    @Published public var selectedTrackIDs: Set<UUID> = []
    
    /// Multi-selection: set of all currently selected clip IDs.
    @Published public var selectedClipIDs: Set<UUID> = []
    
    /// The most recently clicked/selected clip.
    @Published public var primarySelectedClipID: UUID?
    
    /// The most recently clicked/selected track.
    @Published public var primarySelectedTrackID: UUID?
    
    /// Current edit cursor position (insertion marker).
    @Published public var editCursorPosition: TimePosition = .zero

    /// Persisted transport playhead position.
    @Published public var playheadPosition: TimePosition = .zero

    /// Project key selector state (UI-only for now, persisted in project file).
    @Published public var keySignatureEnabled: Bool
    @Published public var keySignatureTonic: ProjectKeyTonic
    @Published public var keySignatureMode: ProjectKeyMode

    /// Persisted per-track panel mode state.
    @Published public var trackPanelStates: [String: TrackPanelState] = [:]
    
    /// Backward compatibility alias. Uses `primarySelectedTrackID` for reads,
    /// sets single-selection for writes.
    public var selectedTrackID: UUID? {
        get { primarySelectedTrackID }
        set {
            if let val = newValue {
                selectedTrackIDs = [val]
                primarySelectedTrackID = val
            } else {
                selectedTrackIDs = []
                primarySelectedTrackID = nil
            }
        }
    }

    /// Whether the project has unsaved changes.
    @Published public var isDirty: Bool = false

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
        self.isLooping = false
        self.keySignatureEnabled = false
        self.keySignatureTonic = .c
        self.keySignatureMode = .major
        self.masterTrack = Track(
            name: "Master",
            trackType: .master,
            color: .slate,
            height: 40
        )
    }

    // MARK: - Codable

    private enum CodingKeys: String, CodingKey {
        case id, name, bpm, timeSignature, sampleRate, tracks, isLooping, loopStart, loopEnd, masterTrack
        case viewZoomScale, viewScrollPosition, viewBrowserWidth
        case playheadPosition, keySignatureEnabled, keySignatureTonic, keySignatureMode
        case primarySelectedTrackID, trackPanelStates
    }

    public convenience init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID(),
            name: try container.decodeIfPresent(String.self, forKey: .name) ?? "Untitled Project",
            bpm: try container.decodeIfPresent(Double.self, forKey: .bpm) ?? 120.0,
            timeSignature: try container.decodeIfPresent(TimeSignature.self, forKey: .timeSignature) ?? TimeSignature(),
            sampleRate: try container.decodeIfPresent(Double.self, forKey: .sampleRate) ?? 44100.0,
            tracks: try container.decodeIfPresent([Track].self, forKey: .tracks) ?? []
        )
        self.isLooping = try container.decodeIfPresent(Bool.self, forKey: .isLooping) ?? false
        self.loopStart = try container.decodeIfPresent(TimePosition.self, forKey: .loopStart)
        self.loopEnd = try container.decodeIfPresent(TimePosition.self, forKey: .loopEnd)
        
        if let master = try container.decodeIfPresent(Track.self, forKey: .masterTrack) {
            self.masterTrack = master
        }
        
        self.viewZoomScale = try container.decodeIfPresent(Double.self, forKey: .viewZoomScale)
        self.viewScrollPosition = try container.decodeIfPresent(Double.self, forKey: .viewScrollPosition)
        self.viewBrowserWidth = try container.decodeIfPresent(Double.self, forKey: .viewBrowserWidth)
        self.playheadPosition = try container.decodeIfPresent(TimePosition.self, forKey: .playheadPosition) ?? .zero
        self.keySignatureEnabled = try container.decodeIfPresent(Bool.self, forKey: .keySignatureEnabled) ?? false
        self.keySignatureTonic = try container.decodeIfPresent(ProjectKeyTonic.self, forKey: .keySignatureTonic) ?? .c
        self.keySignatureMode = try container.decodeIfPresent(ProjectKeyMode.self, forKey: .keySignatureMode) ?? .major
        self.primarySelectedTrackID = try container.decodeIfPresent(UUID.self, forKey: .primarySelectedTrackID)
        if let selected = self.primarySelectedTrackID {
            self.selectedTrackIDs = [selected]
        }
        self.trackPanelStates = try container.decodeIfPresent([String: TrackPanelState].self, forKey: .trackPanelStates) ?? [:]
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(bpm, forKey: .bpm)
        try container.encode(timeSignature, forKey: .timeSignature)
        try container.encode(sampleRate, forKey: .sampleRate)
        try container.encode(tracks, forKey: .tracks)
        try container.encode(isLooping, forKey: .isLooping)
        try container.encodeIfPresent(loopStart, forKey: .loopStart)
        try container.encodeIfPresent(loopEnd, forKey: .loopEnd)
        try container.encode(masterTrack, forKey: .masterTrack)
        try container.encodeIfPresent(viewZoomScale, forKey: .viewZoomScale)
        try container.encodeIfPresent(viewScrollPosition, forKey: .viewScrollPosition)
        try container.encodeIfPresent(viewBrowserWidth, forKey: .viewBrowserWidth)
        try container.encode(playheadPosition, forKey: .playheadPosition)
        try container.encode(keySignatureEnabled, forKey: .keySignatureEnabled)
        try container.encode(keySignatureTonic, forKey: .keySignatureTonic)
        try container.encode(keySignatureMode, forKey: .keySignatureMode)
        try container.encodeIfPresent(primarySelectedTrackID, forKey: .primarySelectedTrackID)
        try container.encode(trackPanelStates, forKey: .trackPanelStates)
    }

    public func panelState(for trackID: UUID) -> TrackPanelState? {
        trackPanelStates[trackID.uuidString]
    }

    public func setPanelState(for trackID: UUID, state: TrackPanelState) {
        trackPanelStates[trackID.uuidString] = state
        isDirty = true
    }

    // MARK: - Factory

    /// Create a default project with one MIDI track and one Audio track.
    public static func createDefault() -> Project {
        let project = Project(name: "New Project", bpm: 120.0)
        project.tracks = [
            Track(
                name: "MIDI 1",
                trackType: .midi,
                color: TrackColor.forIndex(0)
            ),
            Track(
                name: "Audio 1",
                trackType: .audio,
                color: TrackColor.forIndex(1)
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
        isDirty = true
    }

    /// Moves a track from one index to another (for drag-to-reorder).
    public func moveTrack(from source: Int, to destination: Int) {
        let track = tracks.remove(at: source)
        tracks.insert(track, at: destination < source ? destination : destination - 1)
        isDirty = true
    }
    
    /// Groups the specified tracks into a new group track.
    public func groupTracks(ids: [UUID]) {
        let selectedTracks = tracks.filter { ids.contains($0.id) }
        guard !selectedTracks.isEmpty else { return }
        
        // Find the topmost index among selected tracks
        let topmostIndex = tracks.firstIndex(where: { ids.contains($0.id) }) ?? 0
        
        let groupName = "Group"
        let groupTrack = Track(
            name: groupName,
            trackType: .group,
            color: selectedTracks.first?.color ?? .slate
        )
        groupTrack.childTrackIDs = selectedTracks.map(\.id)
        
        // Update children's parent, routing, and color for a unified look
        for track in selectedTracks {
            track.parentTrackID = groupTrack.id
            track.outputDestinationID = groupTrack.id
            track.color = groupTrack.color
        }
        
        // Insert group track at the topmost position
        tracks.insert(groupTrack, at: topmostIndex)
        
        isDirty = true
    }
    
    /// Ungroups a group track, returning its children to the parent's level.
    public func ungroupTrack(id: UUID) {
        guard let groupIndex = tracks.firstIndex(where: { $0.id == id }),
              tracks[groupIndex].trackType == .group else { return }
        
        let groupTrack = tracks[groupIndex]
        let children = tracks.filter { groupTrack.childTrackIDs.contains($0.id) }
        
        for child in children {
            child.parentTrackID = groupTrack.parentTrackID
            child.outputDestinationID = groupTrack.parentTrackID
        }
        
        tracks.remove(at: groupIndex)
        isDirty = true
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
    
    /// Returns all tracks that should be visible in the arrangement (including Master).
    /// Respects the `isExpanded` state of parent group tracks.
    public var allVisibleTracks: [Track] {
        let trackMap = Dictionary(uniqueKeysWithValues: tracks.map { ($0.id, $0) })
        
        let filteredTracks = tracks.filter { track in
            var currentParentID = track.parentTrackID
            while let parentID = currentParentID {
                if let parent = trackMap[parentID] {
                    if !parent.isExpanded {
                        return false
                    }
                    currentParentID = parent.parentTrackID
                } else {
                    break
                }
            }
            return true
        }
        
        return filteredTracks + [masterTrack]
    }
    
    /// Calculates the nesting depth of a track (0 for top-level, 1 for first level group, etc.).
    public func depth(for trackID: UUID) -> Int {
        let trackMap = Dictionary(uniqueKeysWithValues: tracks.map { ($0.id, $0) })
        var depth = 0
        var currentParentID = trackMap[trackID]?.parentTrackID
        
        while let parentID = currentParentID {
            depth += 1
            currentParentID = trackMap[parentID]?.parentTrackID
        }
        return depth
    }
    
    /// Returns the maximum nesting depth present in the project.
    public var maxTrackDepth: Int {
        let visible = allVisibleTracks
        var maxD = 0
        for track in visible {
            let d = depth(for: track.id)
            if d > maxD { maxD = d }
        }
        return maxD
    }
}
