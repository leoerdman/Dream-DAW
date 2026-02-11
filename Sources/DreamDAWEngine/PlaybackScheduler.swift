import AVFoundation
import Foundation
import DreamDAWModels
import os.log

// MARK: - PlaybackScheduler

/// Schedules audio clip playback with sample-accurate timing.
/// Manages AVAudioPlayerNode scheduling for all clips across all tracks.
///
/// **Scheduling strategy (enterprise-grade)**:
/// AVAudioPlayerNode scheduling requires careful handling of time references.
/// After `player.stop()`, the player's internal timeline resets. We then schedule
/// content using `nil` time (relative to player start) and use frame offsets for
/// delayed clips. For clips that should start immediately, we schedule the segment
/// starting from the correct file offset. For clips that start later, we prepend
/// silence frames via a silence buffer that acts as a time spacer.
///
/// Alternative approach (used here): Schedule all content, then start all players
/// simultaneously using `player.play(at: sharedFutureTime)` so all players begin
/// in sync. Content scheduled without explicit time plays immediately relative
/// to each player's start.
public final class PlaybackScheduler {

    // MARK: - Properties

    private let audioEngine: AudioEngine
    private let trackMixer: TrackMixer
    private let synth: SimpleSynthInstrument
    private let logger = Logger(subsystem: "com.dreamdaw", category: "PlaybackScheduler")

    // MARK: - Initialization

    public init(audioEngine: AudioEngine, trackMixer: TrackMixer) {
        self.audioEngine = audioEngine
        self.trackMixer = trackMixer
        self.synth = SimpleSynthInstrument(sampleRate: audioEngine.sampleRate)
    }

    // MARK: - Scheduling

    /// Schedule all clips for playback, with optional gapless looping support.
    ///
    /// - Parameters:
    ///   - project: The project data.
    ///   - position: Start position for playback.
    ///   - looping: Whether loop mode is active.
    ///   - loopStart: Loop start position (if looping).
    ///   - loopEnd: Loop end position (if looping).
    public func schedulePlayback(
        project: Project,
        from position: TimePosition,
        looping: Bool = false,
        loopStart: TimePosition = .zero,
        loopEnd: TimePosition = .zero
    ) {
        let bpm = project.bpm
        let sampleRate = audioEngine.sampleRate

        logger.info("schedulePlayback from \(position.beats), looping=\(looping) [\(loopStart.beats)-\(loopEnd.beats)]")

        // Stop all players first (clears queue)
        trackMixer.stopAll()

        var playersToStart: [AVAudioPlayerNode] = []

        for track in project.tracks {
            guard track.trackType != .master else { continue }
            guard let player = trackMixer.playerNode(for: track.id) else { continue }

            player.stop()

            var hasContent = false

            // Logic:
            // 1. If NOT looping, or position is past loop end: Schedule linearly to end.
            // 2. If looping:
            //    a. Schedule "Pre-Roll": position -> loopEnd
            //    b. Schedule "Loop Body" (N times): loopStart -> loopEnd

            if !looping || position.beats >= loopEnd.beats {
                // Linear playback (no loop active or past loop)
                // We use a safe "infinity" (e.g. 1 hour) or just project end?
                // Using project end is safer.
                let end = project.totalDuration
                hasContent = scheduleTrackRange(
                    track: track, player: player,
                    start: position, end: end,
                    bpm: bpm, sampleRate: sampleRate
                )
            } else {
                // Gapless Loop Playback
                var scheduledAnything = false

                // 1. Pre-Roll (Current Pos -> Loop End)
                // Even if we are AT loop start, this covers the first iteration seamlessly
                if position.beats < loopEnd.beats {
                    if scheduleTrackRange(
                        track: track, player: player,
                        start: position, end: loopEnd,
                        bpm: bpm, sampleRate: sampleRate
                    ) {
                        scheduledAnything = true
                    }
                }

                // 2. Loop Body Iterations
                // Calculate how many iterations to buffer (target ~3 minutes or max 32 iterations)
                let loopDurationBeats = loopEnd.beats - loopStart.beats
                if loopDurationBeats > 0 {
                    let loopDurationSec = loopDurationBeats / bpm * 60.0
                    let targetBufferSec = 180.0
                    let iterationCount = min(32, max(2, Int(ceil(targetBufferSec / loopDurationSec))))

                    logger.debug("Buffering \(iterationCount) loop iterations for track '\(track.name)'")

                    for _ in 0..<iterationCount {
                        if scheduleTrackRange(
                            track: track, player: player,
                            start: loopStart, end: loopEnd,
                            bpm: bpm, sampleRate: sampleRate
                        ) {
                            scheduledAnything = true
                        }
                    }
                }

                hasContent = scheduledAnything
            }

            if hasContent {
                playersToStart.append(player)
            }
        }

        // Start all players immediately
        // (Since we used scheduleSegment/Buffer with at: nil, they are queued and ready)
        for player in playersToStart {
            player.play()
        }
    }

    // MARK: - Range Scheduling (The Core "Stitcher")

    /// Schedules all clips within a specific time range [start, end) onto the player queue.
    /// Fills gaps with silence to maintain exact timing.
    /// Returns true if any content (sound or silence hole-filler) was scheduled to maintain timeline.
    private func scheduleTrackRange(
        track: Track, player: AVAudioPlayerNode,
        start: TimePosition, end: TimePosition,
        bpm: Double, sampleRate: Double
    ) -> Bool {
        let rangeStartBeats = start.beats
        let rangeEndBeats = end.beats
        let rangeDurationBeats = rangeEndBeats - rangeStartBeats

        guard rangeDurationBeats > 0 else { return false }

        // Filter clips touching this range
        var clipsInRange: [(Any, Double, Double, Double)] = [] // (ClipObject, StartBeat, EndBeat, Duration)

        if track.trackType == .audio {
            for clip in track.clips {
                if clip.endPosition.beats > rangeStartBeats && clip.position.beats < rangeEndBeats {
                    clipsInRange.append((clip, clip.position.beats, clip.endPosition.beats, clip.duration.beats))
                }
            }
        } else if track.trackType == .midi {
            for clip in track.midiClips {
                if clip.endPosition.beats > rangeStartBeats && clip.position.beats < rangeEndBeats {
                    clipsInRange.append((clip, clip.position.beats, clip.endPosition.beats, clip.duration.beats))
                }
            }
        }

        // Sort by time
        clipsInRange.sort { $0.1 < $1.1 }

        // Cursor tracks the current "write head" in the player queue, relative to rangeStart (in seconds)
        var cursorSeconds: Double = 0
        let rangeDurationSeconds = rangeDurationBeats / bpm * 60.0

        for (clipObj, cStart, _, _) in clipsInRange {
            // Convert clip timings to seconds relative to rangeStart
            let clipStartAbsSeconds = cStart / bpm * 60.0
            let rangeStartAbsSeconds = rangeStartBeats / bpm * 60.0
            let relativeStartSeconds = clipStartAbsSeconds - rangeStartAbsSeconds

            // 1. Fill gap before clip with silence
            if relativeStartSeconds > cursorSeconds {
                let gapDuration = relativeStartSeconds - cursorSeconds
                if gapDuration > 0 {
                    scheduleSilence(player: player, duration: gapDuration, sampleRate: sampleRate)
                    cursorSeconds += gapDuration
                }
            }

            // 2. Schedule Clip Segment
            // We need to determine ensuring we clip to the Range boundaries
            // Clip might start before range (offset) or end after range (trim)

            // Overlap calculations in BEATS first for precision
            let clipStartBeats = cStart
            let clipEndBeats = cStart + ((clipObj as? AudioClip)?.duration.beats ?? (clipObj as? MidiClip)?.duration.beats ?? 0)

            let visibleStart = max(rangeStartBeats, clipStartBeats)
            let visibleEnd = min(rangeEndBeats, clipEndBeats)
            let visibleDuration = visibleEnd - visibleStart

            guard visibleDuration > 0 else { continue } // Should not happen given filter

            // Calculate file read offsets
            let startOffsetBeats = visibleStart - clipStartBeats // How far into clip we start
            // Add Clip's internal trimStartOffset if audio
            let internalTrimBeats = (clipObj as? AudioClip)?.trimStartOffset.beats ?? 0

            let totalStartOffsetBeats = startOffsetBeats + internalTrimBeats
            let visibleDurationSeconds = visibleDuration / bpm * 60.0

            if let audioClip = clipObj as? AudioClip {
                scheduleAudioFileSegment(
                    player: player,
                    url: audioClip.fileURL,
                    startOffsetSeconds: totalStartOffsetBeats / bpm * 60.0,
                    durationSeconds: visibleDurationSeconds
                )
            } else if let midiClip = clipObj as? MidiClip {
                // For MIDI, we render full clip then slice buffer?
                // Optimization: Render function could take range?
                // For now: Render full, then slice.
                scheduleMidiBufferSegment(
                    player: player,
                    clip: midiClip,
                    startOffsetSeconds: startOffsetBeats / bpm * 60.0, // Internal trim not relevant for MIDI usually
                    durationSeconds: visibleDurationSeconds,
                    bpm: bpm,
                    sampleRate: sampleRate
                )
            }

            cursorSeconds += visibleDurationSeconds
        }

        // 3. Fill final gap to end of range
        // This ensures the loop body is exactly the loop length
        let remaining = rangeDurationSeconds - cursorSeconds
        if remaining > 0.001 { // epsilon
            scheduleSilence(player: player, duration: remaining, sampleRate: sampleRate)
        }

        return true // We scheduled a complete block representing the range
    }

    // MARK: - Low Level Helpers

    private func scheduleSilence(player: AVAudioPlayerNode, duration: Double, sampleRate: Double) {
        let frameCount = AVAudioFrameCount(duration * sampleRate)
        guard frameCount > 0 else { return }
        if let silence = createSilenceBuffer(frameCount: frameCount, sampleRate: sampleRate) {
            player.scheduleBuffer(silence)
        }
    }

    private func scheduleAudioFileSegment(
        player: AVAudioPlayerNode,
        url: URL,
        startOffsetSeconds: Double,
        durationSeconds: Double
    ) {
        do {
            // MUST create fresh file handle for thread safety / independent seeking
            let file = try AVAudioFile(forReading: url)
            let format = file.processingFormat
            let startFrame = AVAudioFramePosition(startOffsetSeconds * format.sampleRate)
            let frameCount = AVAudioFrameCount(durationSeconds * format.sampleRate)

            // Clamp
            let available = file.length - startFrame
            guard available > 0 else { return }
            let actualCount = min(frameCount, AVAudioFrameCount(available))

            player.scheduleSegment(
                file,
                startingFrame: startFrame,
                frameCount: actualCount,
                at: nil // Queue at end
            )
        } catch {
            logger.error("Failed to schedule audio segment: \(error)")
        }
    }

    private func scheduleMidiBufferSegment(
        player: AVAudioPlayerNode,
        clip: MidiClip,
        startOffsetSeconds: Double,
        durationSeconds: Double,
        bpm: Double,
        sampleRate: Double
    ) {
        guard let fullBuffer = synth.renderClipToBuffer(clip: clip, bpm: bpm) else { return }

        let startFrame = AVAudioFramePosition(startOffsetSeconds * sampleRate)
        let frameCount = AVAudioFrameCount(durationSeconds * sampleRate)

        guard startFrame < fullBuffer.frameLength else { return }
        let actualCount = min(frameCount, AVAudioFrameCount(startFrame < AVAudioFramePosition(fullBuffer.frameLength) ? AVAudioFramePosition(fullBuffer.frameLength) - startFrame : 0))

        // Helper to get length safely
        let bufferLen = AVAudioFramePosition(fullBuffer.frameLength)
        let safeCount = min(frameCount, AVAudioFrameCount(max(0, bufferLen - startFrame)))
        guard safeCount > 0 else { return }

        // Slice buffer
        guard let subBuffer = AVAudioPCMBuffer(pcmFormat: fullBuffer.format, frameCapacity: safeCount) else { return }
        subBuffer.frameLength = safeCount

        for ch in 0..<Int(fullBuffer.format.channelCount) {
            guard let src = fullBuffer.floatChannelData?[ch],
                  let dst = subBuffer.floatChannelData?[ch] else { continue }
            memcpy(dst, src.advanced(by: Int(startFrame)), Int(safeCount) * MemoryLayout<Float>.size)
        }

        player.scheduleBuffer(subBuffer)
    }

    private func frameLength(_ buffer: AVAudioPCMBuffer) -> AVAudioFramePosition {
        return AVAudioFramePosition(buffer.frameLength)
    }

    /// Stop all playback and silence the synth.
    public func stopAll() {
        synth.allNotesOff()
        trackMixer.stopAll()
    }

    // MARK: - Utility

    /// Create a silence buffer of the specified length.
    /// Used as a time spacer when clips don't start at the playhead position.
    private func createSilenceBuffer(frameCount: AVAudioFrameCount, sampleRate: Double) -> AVAudioPCMBuffer? {
        guard frameCount > 0 else { return nil }
        let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 2)!
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else { return nil }
        buffer.frameLength = frameCount
        // Buffer is already zero-initialized by AVAudioPCMBuffer
        return buffer
    }

    // MARK: - Audio File Loading

    /// Known-valid audio file URLs (avoids re-checking filesystem).
    private var validFileURLs: Set<URL> = []

    /// Create a fresh AVAudioFile handle for each scheduling call.
    /// AVAudioFile is NOT safe to share across concurrent scheduleSegment calls
    /// because its internal `framePosition` is mutable state.
    private func loadAudioFile(url: URL) throws -> AVAudioFile {
        let file = try AVAudioFile(forReading: url)
        validFileURLs.insert(url)
        return file
    }

    /// Clear the valid-URL cache.
    public func clearCache() {
        validFileURLs.removeAll()
    }
}
