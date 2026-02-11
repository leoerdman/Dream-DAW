import XCTest
@testable import DreamDAWModels

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
        XCTAssertEqual(project.tracks.count, 1)
        XCTAssertEqual(project.tracks.first?.trackType, .midi)
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
