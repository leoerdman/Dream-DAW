import Foundation
import DreamDAWModels
import os.log

/// Orchestrates complex arrangement logic, decoupling business rules from the UI.
/// Handles track management, clip operations, and atomic undoable updates.
///
/// **Enterprise Level**: Centralizes overlapping logic and cross-track transfers.
public final class ArrangementOrchestrator {
    
    private let logger = Logger(subsystem: "com.dreamdaw", category: "ArrangementOrchestrator")
    
    public let project: Project
    public let actionHistory: ActionHistory
    
    public init(project: Project, actionHistory: ActionHistory) {
        self.project = project
        self.actionHistory = actionHistory
    }
    
    // MARK: - Track Operations
    
    public func addTrack(type: TrackType) {
        let name = "\(type == .audio ? "Audio" : "MIDI") \(project.tracks.count + 1)"
        let track = Track(
            name: name,
            trackType: type,
            color: TrackColor.forIndex(project.tracks.count)
        )
        let action = AddTrackAction(track: track)
        actionHistory.perform(action, on: project)
    }
    
    public func deleteTrack(id: UUID) {
        guard id != project.masterTrack.id else { return }
        let action = RemoveTrackAction(trackID: id)
        actionHistory.perform(action, on: project)
    }
    
    public func renameTrack(id: UUID, newName: String) {
        guard let track = project.tracks.first(where: { $0.id == id }) else { return }
        let action = RenameTrackAction(trackID: id, oldName: track.name, newName: newName)
        actionHistory.perform(action, on: project)
    }
    
    // MARK: - Clip Operations (Atomic with Overlap Handling)
    
    /// Finalizes a clip move after dragging.
    public func finalizeClipMove(id: UUID, fromTrackID: UUID, toTrackID: UUID, oldPositionBeats: Double, newPositionBeats: Double) {
        guard let fromTrack = project.tracks.first(where: { $0.id == fromTrackID }),
              let toTrack = project.tracks.first(where: { $0.id == toTrackID }) else { return }
        
        let oldPos = TimePosition(beats: oldPositionBeats)
        let newPos = TimePosition(beats: newPositionBeats)
        
        var actions: [UndoableAction] = []
        
        if let audioClip = fromTrack.clips.first(where: { $0.id == id }) {
            if fromTrackID == toTrackID {
                actions.append(MoveAudioClipAction(trackID: fromTrackID, clipID: id, oldPosition: oldPos, newPosition: newPos))
            } else {
                actions.append(TransferAudioClipAction(clipID: id, fromTrackID: fromTrackID, toTrackID: toTrackID, oldPosition: oldPos, newPosition: newPos))
            }
            let overlapActions = calculateAudioOverlaps(on: toTrack, movedClipID: id, movedStart: newPositionBeats, movedEnd: newPositionBeats + audioClip.duration.beats)
            actions.append(contentsOf: overlapActions)
            
        } else if let midiClip = fromTrack.midiClips.first(where: { $0.id == id }) {
            if fromTrackID == toTrackID {
                actions.append(MoveMidiClipAction(trackID: fromTrackID, clipID: id, oldPosition: oldPos, newPosition: newPos))
            } else {
                actions.append(TransferMidiClipAction(clipID: id, fromTrackID: fromTrackID, toTrackID: toTrackID, oldPosition: oldPos, newPosition: newPos))
            }
            let overlapActions = calculateMidiOverlaps(on: toTrack, movedClipID: id, movedStart: newPositionBeats, movedEnd: newPositionBeats + midiClip.duration.beats)
            actions.append(contentsOf: overlapActions)
        }
        
        if !actions.isEmpty {
            let composite = CompositeUndoAction(actionName: "Move Clip", actions: actions)
            actionHistory.record(composite)
        }
    }
    
    /// Finalizes a clip resize after dragging.
    public func finalizeClipResize(id: UUID, trackID: UUID, isMidi: Bool, oldPositionBeats: Double, oldDurationBeats: Double, oldTrimBeats: Double, newPositionBeats: Double, newDurationBeats: Double, newTrimBeats: Double) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        
        var actions: [UndoableAction] = []
        
        if !isMidi {
            let action = ResizeAudioClipAction(
                clipID: id, trackID: trackID,
                oldPosition: TimePosition(beats: oldPositionBeats),
                oldDuration: TimePosition(beats: oldDurationBeats),
                oldTrim: TimePosition(beats: oldTrimBeats),
                newPosition: TimePosition(beats: newPositionBeats),
                newDuration: TimePosition(beats: newDurationBeats),
                newTrim: TimePosition(beats: newTrimBeats)
            )
            actions.append(action)
            let overlapActions = calculateAudioOverlaps(on: track, movedClipID: id, movedStart: newPositionBeats, movedEnd: newPositionBeats + newDurationBeats)
            actions.append(contentsOf: overlapActions)
        } else {
            let action = ResizeMidiClipAction(
                clipID: id, trackID: trackID,
                oldPosition: TimePosition(beats: oldPositionBeats),
                oldDuration: TimePosition(beats: oldDurationBeats),
                newPosition: TimePosition(beats: newPositionBeats),
                newDuration: TimePosition(beats: newDurationBeats)
            )
            actions.append(action)
            let overlapActions = calculateMidiOverlaps(on: track, movedClipID: id, movedStart: newPositionBeats, movedEnd: newPositionBeats + newDurationBeats)
            actions.append(contentsOf: overlapActions)
        }
        
        if !actions.isEmpty {
            let composite = CompositeUndoAction(actionName: "Resize Clip", actions: actions)
            actionHistory.record(composite)
        }
    }

    public func deleteClip(id: UUID, trackID: UUID, isMidi: Bool) {
        guard let track = project.tracks.first(where: { $0.id == trackID }) else { return }
        if !isMidi, let clip = track.clips.first(where: { $0.id == id }) {
            actionHistory.perform(RemoveAudioClipAction(trackID: trackID, clip: clip), on: project)
        } else if isMidi, let clip = track.midiClips.first(where: { $0.id == id }) {
            actionHistory.perform(RemoveMidiClipAction(trackID: trackID, clip: clip), on: project)
        }
    }
    
    // MARK: - Internal Overlap Calculators
    
    private func calculateAudioOverlaps(on track: Track, movedClipID: UUID, movedStart: Double, movedEnd: Double) -> [UndoableAction] {
        var actions: [UndoableAction] = []
        for other in track.clips where other.id != movedClipID {
            let otherStart = other.position.beats
            let otherEnd = other.endPosition.beats
            if otherEnd <= movedStart || otherStart >= movedEnd { continue }
            
            if otherStart >= movedStart && otherEnd <= movedEnd {
                actions.append(RemoveAudioClipAction(trackID: track.id, clip: other))
            } else if movedStart <= otherStart && movedEnd > otherStart && movedEnd < otherEnd {
                actions.append(ResizeAudioClipAction(clipID: other.id, trackID: track.id, oldPosition: other.position, oldDuration: other.duration, oldTrim: other.trimStartOffset, newPosition: TimePosition(beats: movedEnd), newDuration: TimePosition(beats: otherEnd - movedEnd), newTrim: TimePosition(beats: other.trimStartOffset.beats + (movedEnd - otherStart))))
            } else if movedStart > otherStart && movedStart < otherEnd && movedEnd >= otherEnd {
                actions.append(ResizeAudioClipAction(clipID: other.id, trackID: track.id, oldPosition: other.position, oldDuration: other.duration, oldTrim: other.trimStartOffset, newPosition: other.position, newDuration: TimePosition(beats: movedStart - otherStart), newTrim: other.trimStartOffset))
            } else if movedStart > otherStart && movedEnd < otherEnd {
                actions.append(ResizeAudioClipAction(clipID: other.id, trackID: track.id, oldPosition: other.position, oldDuration: other.duration, oldTrim: other.trimStartOffset, newPosition: other.position, newDuration: TimePosition(beats: movedStart - otherStart), newTrim: other.trimStartOffset))
            }
        }
        return actions
    }
    
    private func calculateMidiOverlaps(on track: Track, movedClipID: UUID, movedStart: Double, movedEnd: Double) -> [UndoableAction] {
        var actions: [UndoableAction] = []
        for other in track.midiClips where other.id != movedClipID {
            let otherStart = other.position.beats
            let otherEnd = other.endPosition.beats
            if otherEnd <= movedStart || otherStart >= movedEnd { continue }
            
            if otherStart >= movedStart && otherEnd <= movedEnd {
                actions.append(RemoveMidiClipAction(trackID: track.id, clip: other))
            } else if movedStart <= otherStart && movedEnd > otherStart && movedEnd < otherEnd {
                actions.append(ResizeMidiClipAction(clipID: other.id, trackID: track.id, oldPosition: other.position, oldDuration: other.duration, newPosition: TimePosition(beats: movedEnd), newDuration: TimePosition(beats: otherEnd - movedEnd)))
            } else if movedStart > otherStart && movedStart < otherEnd && movedEnd >= otherEnd {
                actions.append(ResizeMidiClipAction(clipID: other.id, trackID: track.id, oldPosition: other.position, oldDuration: other.duration, newPosition: other.position, newDuration: TimePosition(beats: movedStart - otherStart)))
            } else if movedStart > otherStart && movedEnd < otherEnd {
                actions.append(ResizeMidiClipAction(clipID: other.id, trackID: track.id, oldPosition: other.position, oldDuration: other.duration, newPosition: other.position, newDuration: TimePosition(beats: movedStart - otherStart)))
            }
        }
        return actions
    }
}
