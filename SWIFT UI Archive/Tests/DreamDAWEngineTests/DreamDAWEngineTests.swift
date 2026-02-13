import XCTest
@testable import DreamDAWEngine
@testable import DreamDAWModels

// MARK: - TransportController Tests

final class TransportControllerTests: XCTestCase {

    func testInitialState() {
        let tc = TransportController()
        XCTAssertEqual(tc.state, .stopped)
        XCTAssertEqual(tc.playheadPosition.beats, 0.0)
        XCTAssertEqual(tc.bpm, 120.0)
        XCTAssertFalse(tc.isLooping)
    }

    func testPlayChangesState() {
        let tc = TransportController()
        tc.play()
        XCTAssertEqual(tc.state, .playing)
    }

    func testPauseFromPlaying() {
        let tc = TransportController()
        tc.play()
        tc.pause()
        XCTAssertEqual(tc.state, .paused)
    }

    func testPauseFromStopped() {
        let tc = TransportController()
        tc.pause()
        XCTAssertEqual(tc.state, .stopped, "Pausing when stopped should stay stopped")
    }

    func testStopResetsPosition() {
        let tc = TransportController()
        tc.seek(to: TimePosition(beats: 16))
        tc.play()
        tc.stop()
        XCTAssertEqual(tc.state, .stopped)
        XCTAssertEqual(tc.playheadPosition.beats, 0.0, accuracy: 0.001,
                       "Stop should reset playhead to zero")
    }

    func testTogglePlayPause() {
        let tc = TransportController()
        tc.togglePlayPause()
        XCTAssertEqual(tc.state, .playing, "Toggle from stopped should play")

        tc.togglePlayPause()
        XCTAssertEqual(tc.state, .paused, "Toggle from playing should pause")

        tc.togglePlayPause()
        XCTAssertEqual(tc.state, .playing, "Toggle from paused should play")
    }

    func testSeekUpdatesPosition() {
        let tc = TransportController()
        tc.seek(to: TimePosition(beats: 32))
        XCTAssertEqual(tc.playheadPosition.beats, 32.0, accuracy: 0.001)
    }

    func testSeekWhilePlaying() {
        let tc = TransportController()
        tc.play()
        tc.seek(to: TimePosition(beats: 64))
        XCTAssertEqual(tc.state, .playing, "Seeking during play should keep playing")
        XCTAssertEqual(tc.playheadPosition.beats, 64.0, accuracy: 0.001)
    }

    func testStateChangeCallback() {
        let tc = TransportController()
        var receivedStates: [TransportState] = []
        tc.onStateChange = { state in
            receivedStates.append(state)
        }

        tc.play()
        tc.pause()
        tc.stop()

        XCTAssertEqual(receivedStates.count, 3)
        XCTAssertEqual(receivedStates[0], .playing)
        XCTAssertEqual(receivedStates[1], .paused)
        XCTAssertEqual(receivedStates[2], .stopped)
    }

    func testLoopConfiguration() {
        let tc = TransportController()
        tc.isLooping = true
        tc.loopStart = TimePosition(beats: 8)
        tc.loopEnd = TimePosition(beats: 16)
        XCTAssertTrue(tc.isLooping)
        XCTAssertEqual(tc.loopStart.beats, 8.0, accuracy: 0.001)
        XCTAssertEqual(tc.loopEnd.beats, 16.0, accuracy: 0.001)
    }

    func testBPMUpdate() {
        let tc = TransportController()
        tc.bpm = 140.0
        XCTAssertEqual(tc.bpm, 140.0)
    }
}

// MARK: - ActionHistory Tests

final class ActionHistoryTests: XCTestCase {

    func testInitialState() {
        let history = ActionHistory()
        XCTAssertFalse(history.canUndo)
        XCTAssertFalse(history.canRedo)
        XCTAssertEqual(history.undoActionName, "")
        XCTAssertEqual(history.redoActionName, "")
    }

    func testPerformAction() {
        let history = ActionHistory()
        let project = Project.createDefault()
        let track = Track(name: "New Track", trackType: .audio)
        let action = AddTrackAction(track: track)

        let initialCount = project.tracks.count
        history.perform(action, on: project)

        XCTAssertEqual(project.tracks.count, initialCount + 1)
        XCTAssertTrue(history.canUndo)
        XCTAssertFalse(history.canRedo)
    }

    func testUndo() {
        let history = ActionHistory()
        let project = Project.createDefault()
        let initialCount = project.tracks.count
        let track = Track(name: "Undo Test", trackType: .audio)

        history.perform(AddTrackAction(track: track), on: project)
        XCTAssertEqual(project.tracks.count, initialCount + 1)

        history.undo(on: project)
        XCTAssertEqual(project.tracks.count, initialCount, "Undo should revert track addition")
        XCTAssertFalse(history.canUndo)
        XCTAssertTrue(history.canRedo)
    }

    func testRedo() {
        let history = ActionHistory()
        let project = Project.createDefault()
        let initialCount = project.tracks.count
        let track = Track(name: "Redo Test", trackType: .midi)

        history.perform(AddTrackAction(track: track), on: project)
        history.undo(on: project)
        XCTAssertEqual(project.tracks.count, initialCount)

        history.redo(on: project)
        XCTAssertEqual(project.tracks.count, initialCount + 1, "Redo should restore track addition")
        XCTAssertTrue(history.canUndo)
        XCTAssertFalse(history.canRedo)
    }

    func testPerformClearsRedoStack() {
        let history = ActionHistory()
        let project = Project.createDefault()

        history.perform(AddTrackAction(track: Track(name: "A")), on: project)
        history.undo(on: project)
        XCTAssertTrue(history.canRedo)

        // Performing a new action should clear redo stack
        history.perform(AddTrackAction(track: Track(name: "B")), on: project)
        XCTAssertFalse(history.canRedo, "New action should clear redo stack")
    }

    func testMultipleUndoRedo() {
        let history = ActionHistory()
        let project = Project.createDefault()
        let initialCount = project.tracks.count

        history.perform(AddTrackAction(track: Track(name: "T1")), on: project)
        history.perform(AddTrackAction(track: Track(name: "T2")), on: project)
        history.perform(AddTrackAction(track: Track(name: "T3")), on: project)
        XCTAssertEqual(project.tracks.count, initialCount + 3)

        history.undo(on: project) // Undo T3
        XCTAssertEqual(project.tracks.count, initialCount + 2)

        history.undo(on: project) // Undo T2
        XCTAssertEqual(project.tracks.count, initialCount + 1)

        history.redo(on: project) // Redo T2
        XCTAssertEqual(project.tracks.count, initialCount + 2)
    }

    func testUndoOnEmptyStack() {
        let history = ActionHistory()
        let project = Project.createDefault()
        let initialCount = project.tracks.count

        // Should be no-op
        history.undo(on: project)
        XCTAssertEqual(project.tracks.count, initialCount)
    }

    func testRedoOnEmptyStack() {
        let history = ActionHistory()
        let project = Project.createDefault()
        let initialCount = project.tracks.count

        // Should be no-op
        history.redo(on: project)
        XCTAssertEqual(project.tracks.count, initialCount)
    }

    func testActionNames() {
        let history = ActionHistory()
        let project = Project.createDefault()

        history.perform(AddTrackAction(track: Track(name: "Lead")), on: project)
        XCTAssertEqual(history.undoActionName, "Add Track")

        history.undo(on: project)
        XCTAssertEqual(history.redoActionName, "Add Track")
    }

    func testClear() {
        let history = ActionHistory()
        let project = Project.createDefault()

        history.perform(AddTrackAction(track: Track(name: "X")), on: project)
        history.clearHistory()

        XCTAssertFalse(history.canUndo)
        XCTAssertFalse(history.canRedo)
    }

    // MARK: - Clip Action Tests

    func testAddAudioClipAction() {
        let history = ActionHistory()
        let project = Project.createDefault()
        let trackID = project.tracks[1].id // Audio track

        let clip = AudioClip(
            name: "Test Audio",
            fileURL: URL(fileURLWithPath: "/tmp/test.wav"),
            position: TimePosition(beats: 4),
            duration: TimePosition(beats: 8)
        )

        history.perform(AddAudioClipAction(trackID: trackID, clip: clip), on: project)
        XCTAssertEqual(project.tracks[1].clips.count, 1)
        XCTAssertEqual(project.tracks[1].clips[0].name, "Test Audio")

        history.undo(on: project)
        XCTAssertEqual(project.tracks[1].clips.count, 0, "Undo should remove the clip")
    }

    func testRemoveAudioClipAction() {
        let project = Project.createDefault()
        let trackID = project.tracks[1].id
        let clip = AudioClip(
            name: "Remove Me",
            fileURL: URL(fileURLWithPath: "/tmp/test.wav"),
            position: .zero,
            duration: TimePosition(beats: 4)
        )
        project.tracks[1].clips.append(clip)

        let history = ActionHistory()
        history.perform(RemoveAudioClipAction(trackID: trackID, clip: clip), on: project)
        XCTAssertEqual(project.tracks[1].clips.count, 0)

        history.undo(on: project)
        XCTAssertEqual(project.tracks[1].clips.count, 1, "Undo should restore the clip")
        XCTAssertEqual(project.tracks[1].clips[0].id, clip.id)
    }

    func testMoveAudioClipAction() {
        let project = Project.createDefault()
        let trackID = project.tracks[1].id
        let clip = AudioClip(
            name: "Move Me",
            fileURL: URL(fileURLWithPath: "/tmp/test.wav"),
            position: TimePosition(beats: 4),
            duration: TimePosition(beats: 4)
        )
        project.tracks[1].clips.append(clip)

        let history = ActionHistory()
        let moveAction = MoveAudioClipAction(
            trackID: trackID,
            clipID: clip.id,
            oldPosition: TimePosition(beats: 4),
            newPosition: TimePosition(beats: 16)
        )
        history.perform(moveAction, on: project)
        XCTAssertEqual(project.tracks[1].clips[0].position.beats, 16.0, accuracy: 0.001)

        history.undo(on: project)
        XCTAssertEqual(project.tracks[1].clips[0].position.beats, 4.0, accuracy: 0.001,
                       "Undo should restore original position")
    }

    func testAddMidiClipAction() {
        let history = ActionHistory()
        let project = Project.createDefault()
        let trackID = project.tracks[0].id // MIDI track

        let clip = MidiClip(
            name: "Piano",
            position: .zero,
            duration: TimePosition(beats: 8),
            notes: [MidiNote(pitch: 60)]
        )

        history.perform(AddMidiClipAction(trackID: trackID, clip: clip), on: project)
        XCTAssertEqual(project.tracks[0].midiClips.count, 1)

        history.undo(on: project)
        XCTAssertEqual(project.tracks[0].midiClips.count, 0)
    }

    func testRemoveTrackAction() {
        let history = ActionHistory()
        let project = Project.createDefault()
        let initialCount = project.tracks.count
        let trackID = project.tracks[0].id

        history.perform(RemoveTrackAction(trackID: trackID), on: project)
        XCTAssertEqual(project.tracks.count, initialCount - 1)

        history.undo(on: project)
        XCTAssertEqual(project.tracks.count, initialCount, "Undo should restore the removed track")
    }

    func testRenameTrackAction() {
        let history = ActionHistory()
        let project = Project.createDefault()
        let trackID = project.tracks[0].id
        let origName = project.tracks[0].name

        history.perform(RenameTrackAction(trackID: trackID, oldName: origName, newName: "Synth Lead"), on: project)
        XCTAssertEqual(project.tracks[0].name, "Synth Lead")

        history.undo(on: project)
        XCTAssertEqual(project.tracks[0].name, origName)
    }
}

// MARK: - RenderEngine Configuration Tests

final class RenderEngineConfigTests: XCTestCase {

    typealias Config = RenderEngine.RenderConfiguration

    func testDefaultConfig() {
        let config = Config()
        XCTAssertEqual(config.sampleRate, 44100.0)
        XCTAssertEqual(config.bitDepth, 24)
        XCTAssertEqual(config.channelCount, 2)
    }

    func testCDPreset() {
        let config = Config.cd
        XCTAssertEqual(config.sampleRate, 44100.0)
        XCTAssertEqual(config.bitDepth, 16)
        XCTAssertEqual(config.channelCount, 2)
    }

    func testStudioStandardPreset() {
        let config = Config.studioStandard
        XCTAssertEqual(config.sampleRate, 44100.0)
        XCTAssertEqual(config.bitDepth, 24)
    }

    func testStudioHDPreset() {
        let config = Config.studioHD
        XCTAssertEqual(config.sampleRate, 48000.0)
        XCTAssertEqual(config.bitDepth, 24)
    }

    func testHighResPreset() {
        let config = Config.highRes
        XCTAssertEqual(config.sampleRate, 96000.0)
        XCTAssertEqual(config.bitDepth, 24)
    }

    func testMasteringGradePreset() {
        let config = Config.masteringGrade
        XCTAssertEqual(config.sampleRate, 96000.0)
        XCTAssertEqual(config.bitDepth, 32)
    }

    func testDisplayString() {
        let config = Config.studioStandard
        XCTAssertTrue(config.displayString.contains("24-bit"))
        XCTAssertTrue(config.displayString.contains("44.1 kHz"))
    }

    func testCustomConfig() {
        let config = Config(sampleRate: 192000, bitDepth: 32, channelCount: 1)
        XCTAssertEqual(config.sampleRate, 192000.0)
        XCTAssertEqual(config.bitDepth, 32)
        XCTAssertEqual(config.channelCount, 1)
    }
}

// MARK: - RenderEngine Tests

final class RenderEngineTests: XCTestCase {

    func testCalculateRenderEnd_EmptyProject() {
        let project = Project.createDefault()
        let end = RenderEngine.calculateRenderEnd(project: project)
        XCTAssertEqual(end.beats, 0.0, "Empty project should have zero render end")
    }

    func testCalculateRenderEnd_WithClips() {
        let project = Project.createDefault()
        let clip = AudioClip(
            name: "Test",
            fileURL: URL(fileURLWithPath: "/tmp/test.wav"),
            position: TimePosition(beats: 8),
            duration: TimePosition(beats: 16)
        )
        project.tracks[1].clips.append(clip)

        let end = RenderEngine.calculateRenderEnd(project: project)
        XCTAssertEqual(end.beats, 24.0, accuracy: 0.001,
                       "Render end should be 8 + 16 = 24 beats")
    }

    func testCalculateRenderEnd_MultipleTracksSelectsMax() {
        let project = Project.createDefault()

        let audioClip = AudioClip(
            name: "Audio",
            fileURL: URL(fileURLWithPath: "/tmp/a.wav"),
            position: TimePosition(beats: 0),
            duration: TimePosition(beats: 8)
        )
        project.tracks[1].clips.append(audioClip)

        let midiClip = MidiClip(
            position: TimePosition(beats: 20),
            duration: TimePosition(beats: 12)
        )
        project.tracks[0].midiClips.append(midiClip)

        let end = RenderEngine.calculateRenderEnd(project: project)
        XCTAssertEqual(end.beats, 32.0, accuracy: 0.001,
                       "Should return max end across all tracks (20+12=32)")
    }

    func testRenderEmptyProject_CallsNoContent() {
        let engine = RenderEngine()
        let project = Project.createDefault()
        let expectation = XCTestExpectation(description: "Render completes with error")

        engine.onComplete = { result in
            switch result {
            case .failure(let error as RenderEngine.RenderError):
                if case .noContent = error {
                    expectation.fulfill()
                }
            default:
                XCTFail("Expected noContent error")
            }
        }

        let url = FileManager.default.temporaryDirectory.appendingPathComponent("test.wav")
        engine.render(project: project, to: url)

        wait(for: [expectation], timeout: 2.0)
    }
}
