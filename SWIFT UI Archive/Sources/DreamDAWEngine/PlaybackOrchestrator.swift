import AVFoundation
import Foundation
import DreamDAWModels
import os.log

// MARK: - SPRINT 4 (Pillar 2): PlaybackOrchestrator
// Central coordinator between UI edits and audio playback.
// Implements the Shadow State pattern: the audio thread reads from a frozen,
// immutable snapshot of the project — never from the live, mutable model.

// MARK: - Immutable Snapshots

/// Immutable snapshot of an audio clip for audio-thread consumption.
public struct AudioClipSnapshot: @unchecked Sendable {
    public let id: UUID
    public let fileURL: URL
    public let positionBeats: Double
    public let durationBeats: Double
    public let trimStartOffsetBeats: Double
    public let stretchFactor: Double
    public let name: String
    
    /// Computed end position in beats.
    public var endPositionBeats: Double { positionBeats + durationBeats }
    
    public init(from clip: AudioClip) {
        self.id = clip.id
        self.fileURL = clip.fileURL
        self.positionBeats = clip.position.beats
        self.durationBeats = clip.duration.beats
        self.trimStartOffsetBeats = clip.trimStartOffset.beats
        self.stretchFactor = clip.stretchFactor
        self.name = clip.name
    }
}

/// Immutable snapshot of a MIDI clip for audio-thread consumption.
public struct MidiClipSnapshot: @unchecked Sendable {
    public let id: UUID
    public let positionBeats: Double
    public let durationBeats: Double
    public let notes: [MidiNoteSnapshot]
    
    public var endPositionBeats: Double { positionBeats + durationBeats }
    
    public init(from clip: MidiClip) {
        self.id = clip.id
        self.positionBeats = clip.position.beats
        self.durationBeats = clip.duration.beats
        self.notes = clip.notes.map { MidiNoteSnapshot(from: $0) }
    }
}

/// Immutable snapshot of a single MIDI note.
public struct MidiNoteSnapshot: @unchecked Sendable {
    public let pitch: Int
    public let velocity: Int
    public let positionBeats: Double
    public let durationBeats: Double
    
    public init(from note: MidiNote) {
        self.pitch = note.pitch
        self.velocity = note.velocity
        self.positionBeats = note.position.beats
        self.durationBeats = note.duration.beats
    }
}

/// Immutable snapshot of a track for audio-thread consumption.
public struct TrackSnapshot: @unchecked Sendable {
    public let id: UUID
    public let name: String
    public let trackType: TrackType
    public let volume: Float
    public let pan: Float
    public let isMuted: Bool
    public let isSoloed: Bool
    public let audioClips: [AudioClipSnapshot]
    public let midiClips: [MidiClipSnapshot]
    public let instrumentType: InstrumentType?
    public let pluginIdentifier: String?
    public let sampleURL: URL?
    public let parentTrackID: UUID?
    
    public init(from track: Track) {
        self.id = track.id
        self.name = track.name
        self.trackType = track.trackType
        self.volume = track.effectiveVolume
        self.pan = track.pan
        self.isMuted = track.isMuted
        self.isSoloed = track.isSoloed
        self.audioClips = track.clips.map { AudioClipSnapshot(from: $0) }
        self.midiClips = track.midiClips.map { MidiClipSnapshot(from: $0) }
        self.instrumentType = track.instrument?.instrumentType
        self.pluginIdentifier = track.instrument?.pluginIdentifier
        self.sampleURL = track.instrument?.sampleURL
        self.parentTrackID = track.parentTrackID
    }
}

/// Complete immutable snapshot of the entire project for audio-thread consumption.
/// When the UI edits the project, a new snapshot is created and atomically swapped.
/// The audio thread reads from the current snapshot — zero data races.
public final class ProjectRenderSnapshot: @unchecked Sendable {
    public let tracks: [TrackSnapshot]
    public let bpm: Double
    public let sampleRate: Double
    public let generation: Int
    public let hasSoloedTrack: Bool
    
    public init(from project: Project, generation: Int) {
        self.tracks = project.tracks.map { TrackSnapshot(from: $0) }
        self.bpm = project.bpm
        self.sampleRate = project.sampleRate
        self.generation = generation
        self.hasSoloedTrack = project.hasSoloedTrack
    }
}

// MARK: - PlaybackOrchestrator

/// Central coordinator for the UI → Audio bridge.
///
/// **Thread Safety Model:**
/// - UI thread calls `commitChanges()` and `play()` (always on MainActor)
/// - Audio thread reads the snapshot via `currentSnapshot` (lock-protected read)
/// - `os_unfair_lock` protects the snapshot pointer swap (< 1μs critical section)
///
/// **Shadow State Lifecycle:**
/// 1. User edits clip position → `ArrangementViewController` calls `commitChanges()`
/// 2. `commitChanges()` freezes the project into a new `ProjectRenderSnapshot`
/// 3. Audio thread's next render callback reads the new snapshot seamlessly
/// 4. Old snapshot is released when ARC drops the last reference
public final class PlaybackOrchestrator {
    
    // MARK: - Properties
    
    private let audioEngine: AudioEngine
    private let trackMixer: TrackMixer
    private let playbackScheduler: PlaybackScheduler
    private let logger = Logger(subsystem: "com.dreamdaw", category: "PlaybackOrchestrator")
    
    /// Thread-safe snapshot storage.
    /// Protected by `snapshotLock` for atomic read/write.
    private var _activeSnapshot: ProjectRenderSnapshot?
    private var snapshotLock = os_unfair_lock_s()
    
    /// Monotonically increasing generation counter for stale-schedule detection.
    private var generationCounter: Int = 0
    
    // MARK: - Initialization
    
    public init(audioEngine: AudioEngine, trackMixer: TrackMixer, playbackScheduler: PlaybackScheduler) {
        self.audioEngine = audioEngine
        self.trackMixer = trackMixer
        self.playbackScheduler = playbackScheduler
        logger.info("PlaybackOrchestrator: Initialized — Shadow State bridge active")
    }
    
    // MARK: - Shadow State Management
    
    /// Creates a frozen snapshot of the current project state.
    /// Called from the UI thread whenever the user edits clips, tracks, or project settings.
    ///
    /// - Parameter project: The live, mutable project model.
    /// - Returns: The generation number of the new snapshot.
    @discardableResult
    public func commitChanges(from project: Project) -> Int {
        generationCounter += 1
        let newSnapshot = ProjectRenderSnapshot(from: project, generation: generationCounter)
        
        os_unfair_lock_lock(&snapshotLock)
        _activeSnapshot = newSnapshot
        os_unfair_lock_unlock(&snapshotLock)
        
        logger.debug("PlaybackOrchestrator: Snapshot committed (gen \(self.generationCounter), \(newSnapshot.tracks.count) tracks)")
        return generationCounter
    }
    
    /// Returns the current frozen snapshot for audio-thread consumption.
    /// Thread-safe: protected by `os_unfair_lock` (< 1μs critical section).
    public var currentSnapshot: ProjectRenderSnapshot? {
        os_unfair_lock_lock(&snapshotLock)
        let snapshot = _activeSnapshot
        os_unfair_lock_unlock(&snapshotLock)
        return snapshot
    }
    
    /// The current generation counter.
    public var currentGeneration: Int { generationCounter }
}
