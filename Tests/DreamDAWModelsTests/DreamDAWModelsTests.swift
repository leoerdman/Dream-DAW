import XCTest
@testable import DreamDAWModels

// MARK: - TimePosition Tests

final class TimePositionTests: XCTestCase {

    // MARK: - Conversion Tests

    func testBeatsToSeconds() {
        let pos = TimePosition(beats: 4)
        let seconds = pos.toSeconds(bpm: 120)
        XCTAssertEqual(seconds, 2.0, accuracy: 0.001, "4 beats at 120 BPM = 2 seconds")
    }

    func testSecondsToBeats() {
        let pos = TimePosition(seconds: 3.0, bpm: 120)
        XCTAssertEqual(pos.beats, 6.0, accuracy: 0.001, "3 seconds at 120 BPM = 6 beats")
    }

    func testBeatsToSamples() {
        let pos = TimePosition(beats: 4)
        let samples = pos.toSamples(bpm: 120, sampleRate: 44100)
        XCTAssertEqual(samples, 88200, "4 beats at 120 BPM, 44100 Hz = 88200 samples")
    }

    func testSamplesToBeats() {
        let pos = TimePosition(samples: 88200, sampleRate: 44100, bpm: 120)
        XCTAssertEqual(pos.beats, 4.0, accuracy: 0.001)
    }

    func testBarsAndBeats() {
        let pos = TimePosition(bars: 3, beats: 2, beatsPerBar: 4)
        XCTAssertEqual(pos.beats, 14.0, "3 bars * 4 beats + 2 = 14 beats")

        let (bars, beats) = pos.toBarsAndBeats(beatsPerBar: 4)
        XCTAssertEqual(bars, 3)
        XCTAssertEqual(beats, 2.0, accuracy: 0.001)
    }

    // MARK: - Arithmetic Tests

    func testAddition() {
        let a = TimePosition(beats: 4)
        let b = TimePosition(beats: 3)
        let result = a + b
        XCTAssertEqual(result.beats, 7.0)
    }

    func testSubtraction() {
        let a = TimePosition(beats: 10)
        let b = TimePosition(beats: 3)
        let result = a - b
        XCTAssertEqual(result.beats, 7.0)
    }

    func testMultiplication() {
        let pos = TimePosition(beats: 4)
        let result = pos * 2.5
        XCTAssertEqual(result.beats, 10.0)
    }

    func testDivision() {
        let pos = TimePosition(beats: 10)
        let result = pos / 2
        XCTAssertEqual(result.beats, 5.0)
    }

    func testDivisionByZero() {
        let pos = TimePosition(beats: 10)
        let result = pos / 0
        XCTAssertEqual(result.beats, 0)
    }

    // MARK: - Comparable Tests

    func testComparable() {
        let a = TimePosition(beats: 4)
        let b = TimePosition(beats: 8)
        XCTAssertTrue(a < b)
        XCTAssertFalse(b < a)
        XCTAssertEqual(a, TimePosition(beats: 4))
    }

    // MARK: - Display Tests

    func testDisplayString() {
        let pos = TimePosition(bars: 2, beats: 1, beatsPerBar: 4)
        let display = pos.displayString(beatsPerBar: 4)
        XCTAssertEqual(display, "3.2.000") // 1-indexed: bar 3, beat 2
    }

    func testTimeDisplayString() {
        let pos = TimePosition(beats: 120) // At 120 BPM = 60 seconds = 1:00.000
        let display = pos.timeDisplayString(bpm: 120)
        XCTAssertTrue(display.hasPrefix("1:"))
    }
}

// MARK: - Project Tests

final class ProjectTests: XCTestCase {

    func testSerializationRoundTrip() throws {
        let project = Project.createDefault()
        project.bpm = 140
        project.name = "Test Project"

        let encoder = JSONEncoder()
        let data = try encoder.encode(project)

        let decoder = JSONDecoder()
        let decoded = try decoder.decode(Project.self, from: data)

        XCTAssertEqual(decoded.id, project.id)
        XCTAssertEqual(decoded.name, "Test Project")
        XCTAssertEqual(decoded.bpm, 140)
        XCTAssertEqual(decoded.tracks.count, project.tracks.count)
    }

    func testDefaultProject() {
        let project = Project.createDefault()
        XCTAssertEqual(project.tracks.count, 2, "Default project should have 1 MIDI + 1 Audio track")
        XCTAssertEqual(project.tracks[0].trackType, .midi, "First track should be MIDI")
        XCTAssertEqual(project.tracks[1].trackType, .audio, "Second track should be Audio")
        XCTAssertEqual(project.bpm, 120.0)
        XCTAssertEqual(project.timeSignature.numerator, 4)
        XCTAssertEqual(project.timeSignature.denominator, 4)
    }

    func testTotalDuration() {
        let project = Project.createDefault()
        // With no clips, should have minimum duration
        let duration = project.totalDuration
        XCTAssertGreaterThan(duration.beats, 0)
    }
}

// MARK: - AudioClip Tests

final class AudioClipTests: XCTestCase {

    private func makeClip(
        position: Double = 0,
        duration: Double = 4,
        gain: Float = 1.0
    ) -> AudioClip {
        AudioClip(
            name: "Test Clip",
            fileURL: URL(fileURLWithPath: "/tmp/test.wav"),
            position: TimePosition(beats: position),
            duration: TimePosition(beats: duration),
            gain: gain
        )
    }

    func testEndPosition() {
        let clip = makeClip(position: 4, duration: 8)
        XCTAssertEqual(clip.endPosition.beats, 12.0, accuracy: 0.001)
    }

    func testContainsBeat_InsideClip() {
        let clip = makeClip(position: 4, duration: 8)
        XCTAssertTrue(clip.contains(beat: 4.0), "Start beat should be contained")
        XCTAssertTrue(clip.contains(beat: 8.0), "Middle beat should be contained")
        XCTAssertTrue(clip.contains(beat: 11.99), "Just before end should be contained")
    }

    func testContainsBeat_OutsideClip() {
        let clip = makeClip(position: 4, duration: 8)
        XCTAssertFalse(clip.contains(beat: 3.99), "Before start should not be contained")
        XCTAssertFalse(clip.contains(beat: 12.0), "At end should not be contained (exclusive)")
        XCTAssertFalse(clip.contains(beat: 20.0), "After end should not be contained")
    }

    func testOverlaps_WithOverlapping() {
        let clip = makeClip(position: 4, duration: 8) // beats 4–12
        XCTAssertTrue(clip.overlaps(
            start: TimePosition(beats: 6),
            end: TimePosition(beats: 10)
        ), "Fully inside should overlap")

        XCTAssertTrue(clip.overlaps(
            start: TimePosition(beats: 0),
            end: TimePosition(beats: 20)
        ), "Enclosing range should overlap")

        XCTAssertTrue(clip.overlaps(
            start: TimePosition(beats: 0),
            end: TimePosition(beats: 5)
        ), "Partial start overlap should overlap")

        XCTAssertTrue(clip.overlaps(
            start: TimePosition(beats: 11),
            end: TimePosition(beats: 20)
        ), "Partial end overlap should overlap")
    }

    func testOverlaps_NoOverlap() {
        let clip = makeClip(position: 4, duration: 8) // beats 4–12
        XCTAssertFalse(clip.overlaps(
            start: TimePosition(beats: 0),
            end: TimePosition(beats: 4)
        ), "Adjacent before should not overlap")

        XCTAssertFalse(clip.overlaps(
            start: TimePosition(beats: 12),
            end: TimePosition(beats: 20)
        ), "Adjacent after should not overlap")
    }

    func testDefaultGain() {
        let clip = makeClip()
        XCTAssertEqual(clip.gain, 1.0, "Default gain should be unity (1.0)")
    }

    func testSerializationRoundTrip() throws {
        let clip = makeClip(position: 3.5, duration: 7.25, gain: 0.8)
        let data = try JSONEncoder().encode(clip)
        let decoded = try JSONDecoder().decode(AudioClip.self, from: data)
        XCTAssertEqual(decoded.id, clip.id)
        XCTAssertEqual(decoded.name, clip.name)
        XCTAssertEqual(decoded.position.beats, clip.position.beats, accuracy: 0.001)
        XCTAssertEqual(decoded.duration.beats, clip.duration.beats, accuracy: 0.001)
        XCTAssertEqual(decoded.gain, clip.gain, accuracy: 0.001)
    }
}

// MARK: - MidiNote Tests

final class MidiNoteTests: XCTestCase {

    func testNoteNameMiddleC() {
        let note = MidiNote(pitch: 60)
        XCTAssertEqual(note.noteName, "C4")
    }

    func testNoteNameSharp() {
        let note = MidiNote(pitch: 66)
        XCTAssertEqual(note.noteName, "F#4")
    }

    func testNoteNameLowOctave() {
        let note = MidiNote(pitch: 21) // A0 (lowest piano key)
        XCTAssertEqual(note.noteName, "A0")
    }

    func testPitchClamping() {
        let tooHigh = MidiNote(pitch: 200)
        XCTAssertEqual(tooHigh.pitch, 127, "Pitch above 127 should be clamped to 127")

        let tooLow = MidiNote(pitch: -5)
        XCTAssertEqual(tooLow.pitch, 0, "Pitch below 0 should be clamped to 0")
    }

    func testVelocityClamping() {
        let tooHigh = MidiNote(velocity: 200)
        XCTAssertEqual(tooHigh.velocity, 127, "Velocity above 127 should be clamped")

        let tooLow = MidiNote(velocity: -1)
        XCTAssertEqual(tooLow.velocity, 0, "Velocity below 0 should be clamped")
    }

    func testEndPosition() {
        let note = MidiNote(
            position: TimePosition(beats: 2),
            duration: TimePosition(beats: 1.5)
        )
        XCTAssertEqual(note.endPosition.beats, 3.5, accuracy: 0.001)
    }

    func testSerializationRoundTrip() throws {
        let note = MidiNote(pitch: 72, velocity: 110, position: TimePosition(beats: 1.5), duration: TimePosition(beats: 0.5))
        let data = try JSONEncoder().encode(note)
        let decoded = try JSONDecoder().decode(MidiNote.self, from: data)
        XCTAssertEqual(decoded.id, note.id)
        XCTAssertEqual(decoded.pitch, 72)
        XCTAssertEqual(decoded.velocity, 110)
    }
}

// MARK: - MidiClip Tests

final class MidiClipTests: XCTestCase {

    func testEndPosition() {
        let clip = MidiClip(
            position: TimePosition(beats: 4),
            duration: TimePosition(beats: 8)
        )
        XCTAssertEqual(clip.endPosition.beats, 12.0, accuracy: 0.001)
    }

    func testContainsBeat() {
        let clip = MidiClip(
            position: TimePosition(beats: 4),
            duration: TimePosition(beats: 4)
        )
        XCTAssertTrue(clip.contains(beat: 4.0))
        XCTAssertTrue(clip.contains(beat: 7.99))
        XCTAssertFalse(clip.contains(beat: 8.0))
        XCTAssertFalse(clip.contains(beat: 3.99))
    }

    func testOverlaps() {
        let clip = MidiClip(
            position: TimePosition(beats: 4),
            duration: TimePosition(beats: 4)
        ) // beats 4-8
        XCTAssertTrue(clip.overlaps(
            start: TimePosition(beats: 5),
            end: TimePosition(beats: 7)
        ))
        XCTAssertFalse(clip.overlaps(
            start: TimePosition(beats: 8),
            end: TimePosition(beats: 12)
        ))
    }

    func testDefaultValues() {
        let clip = MidiClip(position: .zero)
        XCTAssertEqual(clip.duration.beats, 4.0, "Default duration should be 4 beats")
        XCTAssertTrue(clip.notes.isEmpty, "Default clip should have no notes")
        XCTAssertFalse(clip.isSelected)
        XCTAssertNil(clip.colorOverride)
    }

    func testSerializationRoundTrip() throws {
        let notes = [
            MidiNote(pitch: 60, position: .zero, duration: TimePosition(beats: 1)),
            MidiNote(pitch: 64, position: TimePosition(beats: 1), duration: TimePosition(beats: 1))
        ]
        let clip = MidiClip(
            name: "Piano Part",
            position: TimePosition(beats: 8),
            duration: TimePosition(beats: 4),
            notes: notes
        )
        let data = try JSONEncoder().encode(clip)
        let decoded = try JSONDecoder().decode(MidiClip.self, from: data)
        XCTAssertEqual(decoded.id, clip.id)
        XCTAssertEqual(decoded.name, "Piano Part")
        XCTAssertEqual(decoded.notes.count, 2)
        XCTAssertEqual(decoded.notes[0].pitch, 60)
        XCTAssertEqual(decoded.notes[1].pitch, 64)
    }
}

// MARK: - Track Tests

final class TrackTests: XCTestCase {

    func testDefaultValues() {
        let track = Track()
        XCTAssertEqual(track.name, "Audio")
        XCTAssertEqual(track.trackType, .audio)
        XCTAssertEqual(track.volume, 0.8, accuracy: 0.001)
        XCTAssertEqual(track.pan, 0.0, accuracy: 0.001)
        XCTAssertFalse(track.isMuted)
        XCTAssertFalse(track.isSoloed)
        XCTAssertFalse(track.isArmed)
        XCTAssertTrue(track.isEmpty)
    }

    func testEffectiveVolume_Normal() {
        let track = Track(volume: 0.7)
        XCTAssertEqual(track.effectiveVolume, 0.7, accuracy: 0.001)
    }

    func testEffectiveVolume_Muted() {
        let track = Track(volume: 0.7, isMuted: true)
        XCTAssertEqual(track.effectiveVolume, 0.0, "Muted track should have 0 effective volume")
    }

    func testIsEmpty_WithAudioClips() {
        let clip = AudioClip(
            name: "Test",
            fileURL: URL(fileURLWithPath: "/tmp/test.wav"),
            position: .zero,
            duration: TimePosition(beats: 4)
        )
        let track = Track(clips: [clip])
        XCTAssertFalse(track.isEmpty)
    }

    func testIsEmpty_WithMidiClips() {
        let clip = MidiClip(position: .zero)
        let track = Track(midiClips: [clip])
        XCTAssertFalse(track.isEmpty)
    }

    func testEndPosition_WithAudioClips() {
        let clip1 = AudioClip(
            name: "A",
            fileURL: URL(fileURLWithPath: "/tmp/a.wav"),
            position: TimePosition(beats: 0),
            duration: TimePosition(beats: 8)
        )
        let clip2 = AudioClip(
            name: "B",
            fileURL: URL(fileURLWithPath: "/tmp/b.wav"),
            position: TimePosition(beats: 12),
            duration: TimePosition(beats: 4)
        )
        let track = Track(clips: [clip1, clip2])
        XCTAssertEqual(track.endPosition.beats, 16.0, accuracy: 0.001,
                       "End position should be clip2.position(12) + clip2.duration(4)")
    }

    func testEndPosition_WithMidiClips() {
        let midiClip = MidiClip(
            position: TimePosition(beats: 20),
            duration: TimePosition(beats: 4)
        )
        let track = Track(midiClips: [midiClip])
        XCTAssertEqual(track.endPosition.beats, 24.0, accuracy: 0.001)
    }

    func testEndPosition_MixedClips() {
        let audioClip = AudioClip(
            name: "A",
            fileURL: URL(fileURLWithPath: "/tmp/a.wav"),
            position: TimePosition(beats: 0),
            duration: TimePosition(beats: 8)
        )
        let midiClip = MidiClip(
            position: TimePosition(beats: 20),
            duration: TimePosition(beats: 12)
        )
        let track = Track(clips: [audioClip], midiClips: [midiClip])
        XCTAssertEqual(track.endPosition.beats, 32.0, accuracy: 0.001,
                       "Should return the max of audio and MIDI end positions")
    }

    func testEndPosition_EmptyTrack() {
        let track = Track()
        XCTAssertEqual(track.endPosition.beats, 0.0, accuracy: 0.001)
    }

    func testSerializationRoundTrip() throws {
        let track = Track(
            name: "Synth Lead",
            trackType: .midi,
            color: .purple,
            volume: 0.65,
            pan: -0.3,
            isMuted: true
        )
        let data = try JSONEncoder().encode(track)
        let decoded = try JSONDecoder().decode(Track.self, from: data)
        XCTAssertEqual(decoded.id, track.id)
        XCTAssertEqual(decoded.name, "Synth Lead")
        XCTAssertEqual(decoded.trackType, .midi)
        XCTAssertEqual(decoded.color, .purple)
        XCTAssertEqual(decoded.volume, 0.65, accuracy: 0.001)
        XCTAssertEqual(decoded.pan, -0.3, accuracy: 0.001)
        XCTAssertTrue(decoded.isMuted)
    }
}

// MARK: - TrackColor Tests

final class TrackColorTests: XCTestCase {

    func testForIndex_Wraps() {
        let color0 = TrackColor.forIndex(0)
        let colorWrapped = TrackColor.forIndex(TrackColor.allCases.count)
        XCTAssertEqual(color0, colorWrapped, "Index wrapping should produce the same color")
    }

    func testAllCasesHaveNSColor() {
        for color in TrackColor.allCases {
            XCTAssertNotNil(color.nsColor, "\(color) should have a valid NSColor")
        }
    }
}

// MARK: - TimeSignature Tests

final class TimeSignatureTests: XCTestCase {

    func testDefaultValues() {
        let ts = TimeSignature()
        XCTAssertEqual(ts.numerator, 4)
        XCTAssertEqual(ts.denominator, 4)
    }

    func testBeatsPerBar_4_4() {
        let ts = TimeSignature(numerator: 4, denominator: 4)
        XCTAssertEqual(ts.beatsPerBar, 4)
    }

    func testBeatsPerBar_3_4() {
        let ts = TimeSignature(numerator: 3, denominator: 4)
        XCTAssertEqual(ts.beatsPerBar, 3)
    }

    func testBeatsPerBar_6_8() {
        let ts = TimeSignature(numerator: 6, denominator: 8)
        XCTAssertEqual(ts.beatsPerBar, 3, "6/8 = 6*4/8 = 3 beats per bar in quarter notes")
    }

    func testDisplayString() {
        let ts = TimeSignature(numerator: 3, denominator: 4)
        XCTAssertEqual(ts.displayString, "3/4")
    }

    func testSerializationRoundTrip() throws {
        let ts = TimeSignature(numerator: 7, denominator: 8)
        let data = try JSONEncoder().encode(ts)
        let decoded = try JSONDecoder().decode(TimeSignature.self, from: data)
        XCTAssertEqual(decoded.numerator, 7)
        XCTAssertEqual(decoded.denominator, 8)
    }
}
