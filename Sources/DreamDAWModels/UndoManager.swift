import Foundation
import os.log

// MARK: - UndoableAction Protocol

/// Represents a single reversible action in the DAW.
/// Every user action that modifies project state must be encapsulated as an `UndoableAction`.
///
/// **Enterprise Command pattern**: each action stores enough state to both execute AND reverse itself.
public protocol UndoableAction {
    /// Human-readable description for the undo/redo menu (e.g., "Delete Clip", "Move Track").
    var actionName: String { get }

    /// Execute or re-execute the action.
    func execute(on project: Project)

    /// Reverse the action, restoring the previous state.
    func undo(on project: Project)
}

/// Groups multiple actions into a single atomic undoable unit.
public final class CompositeUndoAction: UndoableAction {
    public let actionName: String
    private let actions: [UndoableAction]

    public init(actionName: String, actions: [UndoableAction]) {
        self.actionName = actionName
        self.actions = actions
    }

    public func execute(on project: Project) {
        for action in actions {
            action.execute(on: project)
        }
    }

    public func undo(on project: Project) {
        // Reverse order for undo
        for action in actions.reversed() {
            action.undo(on: project)
        }
    }
}

// MARK: - ActionHistory

/// Central undo/redo manager for the project.
/// Maintains a stack of performed actions and supports multi-level undo/redo.
///
/// **Thread safety**: All operations must be called from the main thread.
public final class ActionHistory: ObservableObject {

    private let logger = Logger(subsystem: "com.dreamdaw", category: "ActionHistory")

    /// Stack of performed actions (most recent at end).
    private var undoStack: [UndoableAction] = []

    /// Stack of undone actions available for redo (most recent at end).
    private var redoStack: [UndoableAction] = []

    /// Maximum history depth (prevents unbounded memory growth).
    public var maxHistoryDepth: Int = 200

    /// Whether undo is currently available.
    @Published public private(set) var canUndo: Bool = false

    /// Whether redo is currently available.
    @Published public private(set) var canRedo: Bool = false

    /// Name of the next undoable action (for menu display).
    @Published public private(set) var undoActionName: String = ""

    /// Name of the next redoable action (for menu display).
    @Published public private(set) var redoActionName: String = ""

    /// Callback fired after any undo/redo to allow UI refresh.
    public var onStateChanged: (() -> Void)?

    public init() {}

    // MARK: - Public API

    /// Perform an action and add it to the undo stack.
    /// This clears the redo stack (branching history).
    public func perform(_ action: UndoableAction, on project: Project) {
        action.execute(on: project)

        undoStack.append(action)
        redoStack.removeAll()

        // Enforce max depth
        if undoStack.count > maxHistoryDepth {
            undoStack.removeFirst(undoStack.count - maxHistoryDepth)
        }

        project.isDirty = true
        updateState()
        logger.info("Performed: \(action.actionName) (history: \(self.undoStack.count))")
    }

    /// Record an action that has already been performed (for actions that modify state inline).
    /// Use this when the action is performed before being recorded (e.g., live parameter dragging).
    public func record(_ action: UndoableAction, on project: Project) {
        undoStack.append(action)
        redoStack.removeAll()

        if undoStack.count > maxHistoryDepth {
            undoStack.removeFirst(undoStack.count - maxHistoryDepth)
        }

        project.isDirty = true
        updateState()
        logger.info("Recorded: \(action.actionName) (history: \(self.undoStack.count))")
    }

    /// Undo the most recent action.
    public func undo(on project: Project) {
        guard let action = undoStack.popLast() else { return }

        action.undo(on: project)
        redoStack.append(action)

        updateState()
        onStateChanged?()
        logger.info("Undid: \(action.actionName)")
    }

    /// Redo the most recently undone action.
    public func redo(on project: Project) {
        guard let action = redoStack.popLast() else { return }

        action.execute(on: project)
        undoStack.append(action)

        updateState()
        onStateChanged?()
        logger.info("Redid: \(action.actionName)")
    }

    /// Clear all history (e.g., when loading a new project).
    public func clearHistory() {
        undoStack.removeAll()
        redoStack.removeAll()
        updateState()
        logger.info("History cleared")
    }

    // MARK: - Private
    private func updateState() {
        canUndo = !undoStack.isEmpty
        canRedo = !redoStack.isEmpty
        undoActionName = undoStack.last?.actionName ?? ""
        redoActionName = redoStack.last?.actionName ?? ""
    }
}

// MARK: - Concrete Actions: Clip Operations

/// Add an audio clip to a track.
public final class AddAudioClipAction: UndoableAction {
    public let actionName: String
    private let trackID: UUID
    private let clip: AudioClip

    public init(trackID: UUID, clip: AudioClip) {
        self.trackID = trackID
        self.clip = clip
        self.actionName = "Add Audio Clip"
    }

    public func execute(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        if !track.clips.contains(where: { $0.id == clip.id }) {
            var newClip = clip
            newClip.synchronize(with: PulseMap(bpm: project.bpm, sampleRate: project.sampleRate))
            track.clips.append(newClip)
        }
    }

    public func undo(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        track.clips.removeAll { $0.id == clip.id }
    }
}

/// Remove an audio clip from a track.
public final class RemoveAudioClipAction: UndoableAction {
    public let actionName: String
    private let trackID: UUID
    private let clip: AudioClip
    private var clipIndex: Int?

    public init(trackID: UUID, clip: AudioClip) {
        self.trackID = trackID
        self.clip = clip
        self.actionName = "Delete Audio Clip"
    }

    public func execute(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        clipIndex = track.clips.firstIndex(where: { $0.id == clip.id })
        track.clips.removeAll { $0.id == clip.id }
    }

    public func undo(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        let insertAt = min(clipIndex ?? track.clips.count, track.clips.count)
        track.clips.insert(clip, at: insertAt)
    }
}

/// Move an audio clip to a new position (within the same track).
public final class MoveAudioClipAction: UndoableAction {
    public let actionName: String
    private let trackID: UUID
    private let clipID: UUID
    private let oldPosition: TimePosition
    private let newPosition: TimePosition

    public init(trackID: UUID, clipID: UUID, oldPosition: TimePosition, newPosition: TimePosition) {
        self.trackID = trackID
        self.clipID = clipID
        self.oldPosition = oldPosition
        self.newPosition = newPosition
        self.actionName = "Move Audio Clip"
    }

    public func execute(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }),
              let clipIdx = track.clips.firstIndex(where: { $0.id == clipID }) else { return }
        track.clips[clipIdx].position = newPosition
        track.clips[clipIdx].synchronize(with: PulseMap(bpm: project.bpm, sampleRate: project.sampleRate))
    }

    public func undo(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }),
              let clipIdx = track.clips.firstIndex(where: { $0.id == clipID }) else { return }
        track.clips[clipIdx].position = oldPosition
        track.clips[clipIdx].synchronize(with: PulseMap(bpm: project.bpm, sampleRate: project.sampleRate))
    }
}

/// Move an audio clip from one track to another.
public final class TransferAudioClipAction: UndoableAction {
    public let actionName: String
    private let clipID: UUID
    private let fromTrackID: UUID
    private let toTrackID: UUID
    private let oldPosition: TimePosition
    private let newPosition: TimePosition
    
    // Store the clip instance for undo/redo stability
    private var clip: AudioClip?

    public init(clipID: UUID, fromTrackID: UUID, toTrackID: UUID, oldPosition: TimePosition, newPosition: TimePosition) {
        self.clipID = clipID
        self.fromTrackID = fromTrackID
        self.toTrackID = toTrackID
        self.oldPosition = oldPosition
        self.newPosition = newPosition
        self.actionName = "Move AudioClip"
    }

    public func execute(on project: Project) {
        guard let fromTrack = project.tracks.first(where: { $0.id == fromTrackID }),
              let toTrack = project.tracks.first(where: { $0.id == toTrackID }),
              let idx = fromTrack.clips.firstIndex(where: { $0.id == clipID }) else { return }
        
        var c = fromTrack.clips.remove(at: idx)
        c.position = newPosition
        c.synchronize(with: PulseMap(bpm: project.bpm, sampleRate: project.sampleRate))
        self.clip = c
        toTrack.clips.append(c)
    }

    public func undo(on project: Project) {
        guard let fromTrack = project.tracks.first(where: { $0.id == fromTrackID }),
              let toTrack = project.tracks.first(where: { $0.id == toTrackID }),
              var c = self.clip,
              let idx = toTrack.clips.firstIndex(where: { $0.id == clipID }) else { return }
        
        toTrack.clips.remove(at: idx)
        c.position = oldPosition
        c.synchronize(with: PulseMap(bpm: project.bpm, sampleRate: project.sampleRate))
        fromTrack.clips.append(c)
    }
}

/// Resize an audio clip (changes position, duration, and optionally trimStartOffset).
public final class ResizeAudioClipAction: UndoableAction {
    public let actionName: String
    private let trackID: UUID
    private let clipID: UUID
    private let oldPosition: TimePosition
    private let oldDuration: TimePosition
    private let oldTrim: TimePosition
    private let newPosition: TimePosition
    private let newDuration: TimePosition
    private let newTrim: TimePosition

    public init(clipID: UUID, trackID: UUID, oldPosition: TimePosition, oldDuration: TimePosition, oldTrim: TimePosition, newPosition: TimePosition, newDuration: TimePosition, newTrim: TimePosition) {
        self.clipID = clipID
        self.trackID = trackID
        self.oldPosition = oldPosition
        self.oldDuration = oldDuration
        self.oldTrim = oldTrim
        self.newPosition = newPosition
        self.newDuration = newDuration
        self.newTrim = newTrim
        self.actionName = "Resize Audio Clip"
    }

    public func execute(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }),
              let idx = track.clips.firstIndex(where: { $0.id == clipID }) else { return }
        track.clips[idx].position = newPosition
        track.clips[idx].duration = newDuration
        track.clips[idx].trimStartOffset = newTrim
        track.clips[idx].synchronize(with: PulseMap(bpm: project.bpm, sampleRate: project.sampleRate))
    }

    public func undo(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }),
              let idx = track.clips.firstIndex(where: { $0.id == clipID }) else { return }
        track.clips[idx].position = oldPosition
        track.clips[idx].duration = oldDuration
        track.clips[idx].trimStartOffset = oldTrim
        track.clips[idx].synchronize(with: PulseMap(bpm: project.bpm, sampleRate: project.sampleRate))
    }
}

/// Add a MIDI clip to a track.
public final class AddMidiClipAction: UndoableAction {
    public let actionName: String
    private let trackID: UUID
    private let clip: MidiClip

    public init(trackID: UUID, clip: MidiClip) {
        self.trackID = trackID
        self.clip = clip
        self.actionName = "Add MIDI Clip"
    }

    public func execute(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        if !track.midiClips.contains(where: { $0.id == clip.id }) {
            var newClip = clip
            newClip.synchronize(with: PulseMap(bpm: project.bpm, sampleRate: project.sampleRate))
            track.midiClips.append(newClip)
        }
    }

    public func undo(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        track.midiClips.removeAll { $0.id == clip.id }
    }
}

/// Remove a MIDI clip from a track.
public final class RemoveMidiClipAction: UndoableAction {
    public let actionName: String
    private let trackID: UUID
    private let clip: MidiClip
    private var clipIndex: Int?

    public init(trackID: UUID, clip: MidiClip) {
        self.trackID = trackID
        self.clip = clip
        self.actionName = "Delete MIDI Clip"
    }

    public func execute(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        clipIndex = track.midiClips.firstIndex(where: { $0.id == clip.id })
        track.midiClips.removeAll { $0.id == clip.id }
    }

    public func undo(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        let insertAt = min(clipIndex ?? track.midiClips.count, track.midiClips.count)
        track.midiClips.insert(clip, at: insertAt)
    }
}

/// Move a MIDI clip to a new position (within the same track).
public final class MoveMidiClipAction: UndoableAction {
    public let actionName: String
    private let trackID: UUID
    private let clipID: UUID
    private let oldPosition: TimePosition
    private let newPosition: TimePosition

    public init(trackID: UUID, clipID: UUID, oldPosition: TimePosition, newPosition: TimePosition) {
        self.trackID = trackID
        self.clipID = clipID
        self.oldPosition = oldPosition
        self.newPosition = newPosition
        self.actionName = "Move MIDI Clip"
    }

    public func execute(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }),
              let clipIdx = track.midiClips.firstIndex(where: { $0.id == clipID }) else { return }
        track.midiClips[clipIdx].position = newPosition
        track.midiClips[clipIdx].synchronize(with: PulseMap(bpm: project.bpm, sampleRate: project.sampleRate))
    }

    public func undo(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }),
              let clipIdx = track.midiClips.firstIndex(where: { $0.id == clipID }) else { return }
        track.midiClips[clipIdx].position = oldPosition
        track.midiClips[clipIdx].synchronize(with: PulseMap(bpm: project.bpm, sampleRate: project.sampleRate))
    }
}

/// Move a MIDI clip from one track to another.
public final class TransferMidiClipAction: UndoableAction {
    public let actionName: String
    private let clipID: UUID
    private let fromTrackID: UUID
    private let toTrackID: UUID
    private let oldPosition: TimePosition
    private let newPosition: TimePosition
    
    private var clip: MidiClip?

    public init(clipID: UUID, fromTrackID: UUID, toTrackID: UUID, oldPosition: TimePosition, newPosition: TimePosition) {
        self.clipID = clipID
        self.fromTrackID = fromTrackID
        self.toTrackID = toTrackID
        self.oldPosition = oldPosition
        self.newPosition = newPosition
        self.actionName = "Move MIDI Clip"
    }

    public func execute(on project: Project) {
        guard let fromTrack = project.tracks.first(where: { $0.id == fromTrackID }),
              let toTrack = project.tracks.first(where: { $0.id == toTrackID }),
              let idx = fromTrack.midiClips.firstIndex(where: { $0.id == clipID }) else { return }
        
        var c = fromTrack.midiClips.remove(at: idx)
        c.position = newPosition
        c.synchronize(with: PulseMap(bpm: project.bpm, sampleRate: project.sampleRate))
        self.clip = c
        toTrack.midiClips.append(c)
    }

    public func undo(on project: Project) {
        guard let fromTrack = project.tracks.first(where: { $0.id == fromTrackID }),
              let toTrack = project.tracks.first(where: { $0.id == toTrackID }),
              var c = self.clip,
              let idx = toTrack.midiClips.firstIndex(where: { $0.id == clipID }) else { return }
        
        toTrack.midiClips.remove(at: idx)
        c.position = oldPosition
        c.synchronize(with: PulseMap(bpm: project.bpm, sampleRate: project.sampleRate))
        fromTrack.midiClips.append(c)
    }
}

/// Resize a MIDI clip.
public final class ResizeMidiClipAction: UndoableAction {
    public let actionName: String
    private let trackID: UUID
    private let clipID: UUID
    private let oldPosition: TimePosition
    private let oldDuration: TimePosition
    private let newPosition: TimePosition
    private let newDuration: TimePosition

    public init(clipID: UUID, trackID: UUID, oldPosition: TimePosition, oldDuration: TimePosition, newPosition: TimePosition, newDuration: TimePosition) {
        self.clipID = clipID
        self.trackID = trackID
        self.oldPosition = oldPosition
        self.oldDuration = oldDuration
        self.newPosition = newPosition
        self.newDuration = newDuration
        self.actionName = "Resize MIDI Clip"
    }

    public func execute(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }),
              let idx = track.midiClips.firstIndex(where: { $0.id == clipID }) else { return }
        track.midiClips[idx].position = newPosition
        track.midiClips[idx].duration = newDuration
        track.midiClips[idx].synchronize(with: PulseMap(bpm: project.bpm, sampleRate: project.sampleRate))
    }

    public func undo(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }),
              let idx = track.midiClips.firstIndex(where: { $0.id == clipID }) else { return }
        track.midiClips[idx].position = oldPosition
        track.midiClips[idx].duration = oldDuration
        track.midiClips[idx].synchronize(with: PulseMap(bpm: project.bpm, sampleRate: project.sampleRate))
    }
}

// MARK: - Concrete Actions: Track Operations

/// Add a new track to the project.
public final class AddTrackAction: UndoableAction {
    public let actionName: String
    private let track: Track
    private var insertIndex: Int?

    public init(track: Track, insertIndex: Int? = nil) {
        self.track = track
        self.insertIndex = insertIndex
        self.actionName = "Add Track"
    }

    public func execute(on project: Project) {
        let index = insertIndex ?? project.tracks.count
        project.tracks.insert(track, at: min(index, project.tracks.count))
    }

    public func undo(on project: Project) {
        if let idx = project.tracks.firstIndex(where: { $0.id == track.id }) {
            insertIndex = idx
            project.tracks.remove(at: idx)
        }
    }
}

/// Remove a track from the project.
public final class RemoveTrackAction: UndoableAction {
    public let actionName: String
    private let trackID: UUID
    private var removedTrack: Track?
    private var removedIndex: Int?

    public init(trackID: UUID) {
        self.trackID = trackID
        self.actionName = "Delete Track"
    }

    public func execute(on project: Project) {
        if let idx = project.tracks.firstIndex(where: { $0.id == trackID }) {
            removedTrack = project.tracks[idx]
            removedIndex = idx
            project.tracks.remove(at: idx)
        }
    }

    public func undo(on project: Project) {
        guard let track = removedTrack, let idx = removedIndex else { return }
        project.tracks.insert(track, at: min(idx, project.tracks.count))
    }
}

/// Rename a track.
public final class RenameTrackAction: UndoableAction {
    public let actionName: String
    private let trackID: UUID
    private let oldName: String
    private let newName: String

    public init(trackID: UUID, oldName: String, newName: String) {
        self.trackID = trackID
        self.oldName = oldName
        self.newName = newName
        self.actionName = "Rename Track"
    }

    public func execute(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        track.name = newName
    }

    public func undo(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        track.name = oldName
    }
}

// MARK: - Concrete Actions: Parameter Changes

/// Change a track's volume.
public final class ChangeVolumeAction: UndoableAction {
    public let actionName: String
    private let trackID: UUID
    private let oldVolume: Float
    private let newVolume: Float

    public init(trackID: UUID, oldVolume: Float, newVolume: Float) {
        self.trackID = trackID
        self.oldVolume = oldVolume
        self.newVolume = newVolume
        self.actionName = "Change Volume"
    }

    public func execute(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        track.volume = newVolume
    }

    public func undo(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        track.volume = oldVolume
    }
}

/// Change a track's pan.
public final class ChangePanAction: UndoableAction {
    public let actionName: String
    private let trackID: UUID
    private let oldPan: Float
    private let newPan: Float

    public init(trackID: UUID, oldPan: Float, newPan: Float) {
        self.trackID = trackID
        self.oldPan = oldPan
        self.newPan = newPan
        self.actionName = "Change Pan"
    }

    public func execute(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        track.pan = newPan
    }

    public func undo(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        track.pan = oldPan
    }
}

/// Change a sampler's loaded sample.
public final class ChangeSamplerSampleAction: UndoableAction {
    public let actionName: String = "Load Sample"
    private let trackID: UUID
    private let oldURL: URL?
    private let newURL: URL

    public init(trackID: UUID, oldURL: URL?, newURL: URL) {
        self.trackID = trackID
        self.oldURL = oldURL
        self.newURL = newURL
    }

    public func execute(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }),
              let instrument = track.instrument,
              instrument.instrumentType == .sampler else { return }
        instrument.sampleURL = newURL
    }

    public func undo(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }),
              let instrument = track.instrument,
              instrument.instrumentType == .sampler else { return }
        instrument.sampleURL = oldURL
    }
}

/// Move a track to a new position.
public final class MoveTrackAction: UndoableAction {
    public let actionName: String = "Move Track"
    private let sourceIndex: Int
    private let destinationIndex: Int

    public init(from source: Int, to destination: Int) {
        self.sourceIndex = source
        self.destinationIndex = destination
    }

    public func execute(on project: Project) {
        project.moveTrack(from: sourceIndex, to: destinationIndex)
    }

    public func undo(on project: Project) {
        // To undo a move from source to destination:
        // We move it from (calculated destination) back to source
        let actualDest = destinationIndex < sourceIndex ? destinationIndex : destinationIndex - 1
        project.moveTrack(from: actualDest, to: sourceIndex + (actualDest < sourceIndex ? 1 : 0))
    }
}

/// Toggle a track's mute state.
public final class ToggleMuteAction: UndoableAction {
    public let actionName: String
    private let trackID: UUID
    private let previousState: Bool

    public init(trackID: UUID, previousState: Bool) {
        self.trackID = trackID
        self.previousState = previousState
        self.actionName = previousState ? "Unmute Track" : "Mute Track"
    }

    public func execute(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        track.isMuted = !previousState
    }

    public func undo(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        track.isMuted = previousState
    }
}

/// Toggle a track's solo state.
public final class ToggleSoloAction: UndoableAction {
    public let actionName: String
    private let trackID: UUID
    private let previousState: Bool

    public init(trackID: UUID, previousState: Bool) {
        self.trackID = trackID
        self.previousState = previousState
        self.actionName = previousState ? "Unsolo Track" : "Solo Track"
    }

    public func execute(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        track.isSoloed = !previousState
    }

    public func undo(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        track.isSoloed = previousState
    }
}

// MARK: - Concrete Actions: Effect Operations

/// Add an effect to a track.
public final class AddEffectAction: UndoableAction {
    public let actionName: String
    private let trackID: UUID
    private let effect: AudioEffectConfig

    public init(trackID: UUID, effect: AudioEffectConfig) {
        self.trackID = trackID
        self.effect = effect
        self.actionName = "Add Effect"
    }

    public func execute(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        if !track.effects.contains(where: { $0.id == effect.id }) {
            track.effects.append(effect)
        }
    }

    public func undo(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        track.effects.removeAll { $0.id == effect.id }
    }
}

/// Remove an effect from a track.
public final class RemoveEffectAction: UndoableAction {
    public let actionName: String
    private let trackID: UUID
    private let effect: AudioEffectConfig
    private var effectIndex: Int?

    public init(trackID: UUID, effect: AudioEffectConfig) {
        self.trackID = trackID
        self.effect = effect
        self.actionName = "Remove Effect"
    }

    public func execute(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        effectIndex = track.effects.firstIndex(where: { $0.id == effect.id })
        track.effects.removeAll { $0.id == effect.id }
    }

    public func undo(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        let insertAt = min(effectIndex ?? track.effects.count, track.effects.count)
        track.effects.insert(effect, at: insertAt)
    }
}

// MARK: - Concrete Actions: BPM

/// Change the project's BPM.
public final class ChangeBPMAction: UndoableAction {
    public let actionName: String
    private let oldBPM: Double
    private let newBPM: Double

    public init(oldBPM: Double, newBPM: Double) {
        self.oldBPM = oldBPM
        self.newBPM = newBPM
        self.actionName = "Change BPM"
    }

    public func execute(on project: Project) {
        project.bpm = newBPM
    }

    public func undo(on project: Project) {
        project.bpm = oldBPM
    }
}

// MARK: - Concrete Actions: MIDI Note Editing

/// Add a MIDI note to a clip.
public final class AddMidiNoteAction: UndoableAction {
    public let actionName: String
    private let clipID: UUID
    private let trackID: UUID
    private let note: MidiNote

    public init(trackID: UUID, clipID: UUID, note: MidiNote) {
        self.trackID = trackID
        self.clipID = clipID
        self.note = note
        self.actionName = "Add Note"
    }

    public func execute(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }),
              let clipIdx = track.midiClips.firstIndex(where: { $0.id == clipID }) else { return }
        if !track.midiClips[clipIdx].notes.contains(where: { $0.id == note.id }) {
            track.midiClips[clipIdx].notes.append(note)
        }
    }

    public func undo(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }),
              let clipIdx = track.midiClips.firstIndex(where: { $0.id == clipID }) else { return }
        track.midiClips[clipIdx].notes.removeAll { $0.id == note.id }
    }
}

/// Remove a MIDI note from a clip.
public final class RemoveMidiNoteAction: UndoableAction {
    public let actionName: String
    private let clipID: UUID
    private let trackID: UUID
    private let note: MidiNote
    private var noteIndex: Int?

    public init(trackID: UUID, clipID: UUID, note: MidiNote) {
        self.trackID = trackID
        self.clipID = clipID
        self.note = note
        self.actionName = "Delete Note"
    }

    public func execute(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }),
              let clipIdx = track.midiClips.firstIndex(where: { $0.id == clipID }) else { return }
        noteIndex = track.midiClips[clipIdx].notes.firstIndex(where: { $0.id == note.id })
        track.midiClips[clipIdx].notes.removeAll { $0.id == note.id }
    }

    public func undo(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }),
              let clipIdx = track.midiClips.firstIndex(where: { $0.id == clipID }) else { return }
        let insertAt = min(noteIndex ?? track.midiClips[clipIdx].notes.count, track.midiClips[clipIdx].notes.count)
        track.midiClips[clipIdx].notes.insert(note, at: insertAt)
    }
}

// MARK: - Sprint 3: Elastic Time (Warp/Stretch)

/// Warp (time-stretch) an audio clip. Pure delta: stores only old/new stretchFactor and duration.
/// Memory cost: 72 bytes per action (vs. entire AudioClip copy at ~400+ bytes).
public final class WarpClipAction: UndoableAction {
    public let actionName: String
    private let trackID: UUID
    private let clipID: UUID
    private let oldPosition: TimePosition
    private let oldDuration: TimePosition
    private let oldStretchFactor: Double
    private let newPosition: TimePosition
    private let newDuration: TimePosition
    private let newStretchFactor: Double

    public init(
        trackID: UUID, clipID: UUID,
        oldPosition: TimePosition, oldDuration: TimePosition, oldStretchFactor: Double,
        newPosition: TimePosition, newDuration: TimePosition, newStretchFactor: Double
    ) {
        self.trackID = trackID
        self.clipID = clipID
        self.oldPosition = oldPosition
        self.oldDuration = oldDuration
        self.oldStretchFactor = oldStretchFactor
        self.newPosition = newPosition
        self.newDuration = newDuration
        self.newStretchFactor = newStretchFactor
        self.actionName = "Warp Audio Clip"
    }

    public func execute(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }),
              let idx = track.clips.firstIndex(where: { $0.id == clipID }) else { return }
        track.clips[idx].position = newPosition
        track.clips[idx].duration = newDuration
        track.clips[idx].stretchFactor = newStretchFactor
        track.clips[idx].isWarped = newStretchFactor != 1.0
        track.clips[idx].synchronize(with: PulseMap(bpm: project.bpm, sampleRate: project.sampleRate))
    }

    public func undo(on project: Project) {
        guard let track = project.tracks.first(where: { $0.id == trackID }),
              let idx = track.clips.firstIndex(where: { $0.id == clipID }) else { return }
        track.clips[idx].position = oldPosition
        track.clips[idx].duration = oldDuration
        track.clips[idx].stretchFactor = oldStretchFactor
        track.clips[idx].isWarped = oldStretchFactor != 1.0
        track.clips[idx].synchronize(with: PulseMap(bpm: project.bpm, sampleRate: project.sampleRate))
    }
}

// MARK: - Sprint 3: Smart Folders (Group/Ungroup)

/// Group selected tracks into a folder track. Pure delta: stores only track IDs and indices.
public final class GroupTracksAction: UndoableAction {
    public let actionName: String = "Group Tracks"
    private let childTrackIDs: [UUID]
    private let groupTrackID: UUID
    private let groupInsertIndex: Int
    
    /// Stores each child's previous parentTrackID for undo.
    private var previousParentIDs: [UUID: UUID?] = [:]
    /// Stores each child's previous outputDestinationID for undo.
    private var previousOutputDestinations: [UUID: UUID?] = [:]

    public init(childTrackIDs: [UUID], groupTrackID: UUID, groupInsertIndex: Int) {
        self.childTrackIDs = childTrackIDs
        self.groupTrackID = groupTrackID
        self.groupInsertIndex = groupInsertIndex
    }

    public func execute(on project: Project) {
        // 1. Create the group track
        let groupTrack = Track(
            id: groupTrackID,
            name: "Group",
            trackType: .group,
            color: .teal
        )
        groupTrack.childTrackIDs = childTrackIDs
        groupTrack.isExpanded = true

        // 2. Snapshot current parent/output state for each child
        for childID in childTrackIDs {
            guard let child = project.tracks.first(where: { $0.id == childID }) else { continue }
            previousParentIDs[childID] = child.parentTrackID
            previousOutputDestinations[childID] = child.outputDestinationID
            
            // 3. Re-parent children to the group
            child.parentTrackID = groupTrackID
            child.outputDestinationID = groupTrackID
        }

        // 4. Insert group track at the correct position
        let idx = min(groupInsertIndex, project.tracks.count)
        project.tracks.insert(groupTrack, at: idx)
    }

    public func undo(on project: Project) {
        // 1. Restore children's original parent/output
        for childID in childTrackIDs {
            guard let child = project.tracks.first(where: { $0.id == childID }) else { continue }
            child.parentTrackID = previousParentIDs[childID] ?? nil
            child.outputDestinationID = previousOutputDestinations[childID] ?? nil
        }

        // 2. Remove the group track
        project.tracks.removeAll { $0.id == groupTrackID }
    }
}

/// Ungroup a folder track, restoring children to top-level. Pure delta: stores parent references.
public final class UngroupTracksAction: UndoableAction {
    public let actionName: String = "Ungroup Tracks"
    private let groupTrackID: UUID
    private var childTrackIDs: [UUID] = []
    private var groupTrackIndex: Int = 0
    private var groupTrackSnapshot: Track?

    public init(groupTrackID: UUID) {
        self.groupTrackID = groupTrackID
    }

    public func execute(on project: Project) {
        guard let groupIdx = project.tracks.firstIndex(where: { $0.id == groupTrackID }) else { return }
        let groupTrack = project.tracks[groupIdx]
        
        // Snapshot for undo
        groupTrackIndex = groupIdx
        childTrackIDs = groupTrack.childTrackIDs
        groupTrackSnapshot = groupTrack

        // Restore children to top-level
        for childID in childTrackIDs {
            guard let child = project.tracks.first(where: { $0.id == childID }) else { continue }
            child.parentTrackID = nil
            child.outputDestinationID = nil
        }

        // Remove the group track
        project.tracks.remove(at: groupIdx)
    }

    public func undo(on project: Project) {
        guard let groupTrack = groupTrackSnapshot else { return }

        // Re-insert group track
        let idx = min(groupTrackIndex, project.tracks.count)
        project.tracks.insert(groupTrack, at: idx)

        // Re-parent children
        for childID in childTrackIDs {
            guard let child = project.tracks.first(where: { $0.id == childID }) else { continue }
            child.parentTrackID = groupTrackID
            child.outputDestinationID = groupTrackID
        }
    }
}
