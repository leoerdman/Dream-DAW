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
    private let logger = Logger(subsystem: "com.dreamdaw", category: "PlaybackScheduler")

    // MARK: - Initialization

    public init(audioEngine: AudioEngine, trackMixer: TrackMixer) {
        self.audioEngine = audioEngine
        self.trackMixer = trackMixer
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

        logger.info(">>> schedulePlayback START from beat \(position.beats), looping=\(looping)")

        if !audioEngine.isRunning {
            logger.warning("[Scheduler] AudioEngine not running. Attempting emergency start.")
            do {
                try audioEngine.start()
            } catch {
                logger.error("[Scheduler] Emergency start failed: \(error.localizedDescription)")
            }
        }

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
                _ = scheduleTrackRange(
                    track: track, player: player,
                    start: position, end: end,
                    bpm: bpm, sampleRate: sampleRate
                )
                hasContent = true // Linear playback always considers track as having content if we reach here
            } else {
                // Gapless Loop Playback

                // 1. Pre-Roll (Current Pos -> Loop End)
                // Even if we are AT loop start, this covers the first iteration seamlessly
                if position.beats < loopEnd.beats {
                    _ = scheduleTrackRange(
                        track: track, player: player,
                        start: position, end: loopEnd,
                        bpm: bpm, sampleRate: sampleRate
                    )
                    hasContent = true
                }

                // 2. Loop Body Iterations
                // Calculate how many iterations to buffer (target ~3 minutes or max 32 iterations)
                let loopDurationBeats = loopEnd.beats - loopStart.beats
                if loopDurationBeats > 0 {
                    let loopDurationSec = loopDurationBeats / bpm * 60.0
                    let targetBufferSec = 10.0
                    let iterationCount = min(32, max(2, Int(ceil(targetBufferSec / loopDurationSec))))

                    logger.debug("Buffering \(iterationCount) loop iterations for track '\(track.name)'")

                    var runningError: Double = 0
                    for _ in 0..<iterationCount {
                        runningError = scheduleTrackRange(
                            track: track, player: player,
                            start: loopStart, end: loopEnd,
                            bpm: bpm, sampleRate: sampleRate,
                            accumulatedError: runningError
                        )
                    }
                }

                hasContent = true
            }

            if hasContent {
                playersToStart.append(player)
            }
        }

        // 3. Start all players at a synchronized future time
        // Calculate a small "future" time to allow the engine to buffer the first segments.
        // We use a safe delay of ~200ms for enterprise stability.
        let delaySeconds = 0.2
        let renderTime = audioEngine.avAudioEngine.outputNode.lastRenderTime ?? AVAudioTime(hostTime: mach_absolute_time())
        
        // Convert seconds to host time units reliably
        var timebaseInfo = mach_timebase_info_data_t()
        mach_timebase_info(&timebaseInfo)
        let delayInNano = UInt64(delaySeconds * 1_000_000_000.0)
        let delayInHostTicks = delayInNano * UInt64(timebaseInfo.denom) / UInt64(timebaseInfo.numer)
        
        let startTime = AVAudioTime(hostTime: renderTime.hostTime + delayInHostTicks)

        if playersToStart.isEmpty {
            logger.warning("[Scheduler] No players to start (no content found in tracks).")
        } else {
            logger.info("[Scheduler] Starting \(playersToStart.count) players at hostTime \(startTime.hostTime) (delay: \(delaySeconds)s, hostTimeNow: \(renderTime.hostTime))")
        }

        for player in playersToStart {
            player.play(at: startTime)
            if !player.isPlaying {
                logger.error("[Scheduler] Player node failed to start playing!")
            }
        }
    }

    // MARK: - Range Scheduling (The Core "Stitcher")

    /// Schedules all clips within a specific time range [start, end) onto the player queue.
    /// Fills gaps with silence to maintain exact timing.
    /// Returns true if any content (sound or silence hole-filler) was scheduled to maintain timeline.
    /// Returns the NEW accumulated error (seconds) to be passed to the next iteration.
    @discardableResult
    private func scheduleTrackRange(
        track: Track, player: AVAudioPlayerNode,
        start: TimePosition, end: TimePosition,
        bpm: Double, sampleRate: Double,
        accumulatedError: Double = 0
    ) -> Double {
        let rangeStartBeats = start.beats
        let rangeEndBeats = end.beats
        let rangeDurationBeats = rangeEndBeats - rangeStartBeats

        guard rangeDurationBeats > 0 else { return accumulatedError }

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
            // 1. Handle Overlaps & Gaps before clip
            
            // Convert clip timings to seconds relative to rangeStart
            let clipStartAbsSeconds = cStart / bpm * 60.0
            let rangeStartAbsSeconds = rangeStartBeats / bpm * 60.0
            let relativeStartSeconds = max(0, clipStartAbsSeconds - rangeStartAbsSeconds)

            logger.debug("--- Scheduling Clip: \( (clipObj as? AudioClip)?.name ?? (clipObj as? MidiClip)?.name ?? "Unknown" ) at relativeStart \(relativeStartSeconds)s")

            if relativeStartSeconds > cursorSeconds {
                // There is a gap: Fill with silence
                let gapDuration = relativeStartSeconds - cursorSeconds
                scheduleSilence(player: player, duration: gapDuration, sampleRate: sampleRate)
                cursorSeconds += gapDuration
            } else if relativeStartSeconds < cursorSeconds {
                // CRITICAL FIX: The next clip starts BEFORE the previous one (or the silence) finished.
                // We cannot "un-schedule" from AVAudioPlayerNode easily once queued,
                // but we CAN catch this earlier by ensuring our cursor never goes backwards
                // and we only schedule what fits.
            }

            // 2. Schedule Clip Segment
            // Determine active region of clip within this [start, end] range.
            let clipStartBeats = cStart
            let clipEndBeats = cStart + ((clipObj as? AudioClip)?.duration.beats ?? (clipObj as? MidiClip)?.duration.beats ?? 0)

            // Look ahead to next clip to truncate this one (Last Clip Wins)
            var effectiveEndBeats = min(rangeEndBeats, clipEndBeats)
            let nextIndex = clipsInRange.firstIndex(where: { $0.1 > cStart })
            if let nextIdx = nextIndex {
                let nextStartBeats = clipsInRange[nextIdx].1
                effectiveEndBeats = min(effectiveEndBeats, nextStartBeats)
            }

            let visibleStart = max(rangeStartBeats, clipStartBeats)
            let visibleEnd = effectiveEndBeats
            let visibleDuration = visibleEnd - visibleStart

            if visibleDuration > 0 {
                // Calculate file read offsets
                let startOffsetBeats = visibleStart - clipStartBeats // How far into clip we start
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
                    scheduleMidiBufferSegment(
                        player: player,
                        track: track, // Pass track to lookup instrument
                        clip: midiClip,
                        startOffsetSeconds: startOffsetBeats / bpm * 60.0,
                        durationSeconds: visibleDurationSeconds,
                        bpm: bpm,
                        sampleRate: sampleRate
                    )
                }
                cursorSeconds += visibleDurationSeconds
            }
        }

        // 3. Fill final gap to end of range
        // This ensures the loop body is exactly the loop length
        let totalRemainingToFill = (rangeDurationSeconds - cursorSeconds) + accumulatedError
        
        var newError: Double = 0
        if totalRemainingToFill > 0 {
            let scheduledFrames = scheduleSilence(player: player, duration: totalRemainingToFill, sampleRate: sampleRate)
            let scheduledSeconds = Double(scheduledFrames) / sampleRate
            newError = totalRemainingToFill - scheduledSeconds
        } else {
            newError = accumulatedError
        }

        return newError
    }

    // MARK: - Low Level Helpers

    @discardableResult
    private func scheduleSilence(player: AVAudioPlayerNode, duration: Double, sampleRate: Double) -> AVAudioFrameCount {
        let frameCount = AVAudioFrameCount(duration * sampleRate)
        guard frameCount > 0 else { return 0 }
        if let silence = createSilenceBuffer(frameCount: frameCount, sampleRate: sampleRate) {
            player.scheduleBuffer(silence)
        }
        return frameCount
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
            logger.info("[Scheduler] Scheduled Audio Segment: \(url.lastPathComponent) (startFrame: \(startFrame), count: \(actualCount))")
        } catch {
            logger.error("[Scheduler] Failed to schedule audio segment: \(error.localizedDescription)")
        }
    }

    private func scheduleMidiBufferSegment(
        player: AVAudioPlayerNode,
        track: Track,
        clip: MidiClip,
        startOffsetSeconds: Double,
        durationSeconds: Double,
        bpm: Double,
        sampleRate: Double
    ) {
        // Fetch the track's specific synth
        guard let synth = trackMixer.getInstrument(for: track.id) else {
            logger.warning("No synth found for MIDI track: \(track.name)")
            return
        }
        
        // Ensure its rendering state matches the track's current config (for amplitude, etc.)
        if let config = track.instrument {
            synth.amplitude = config.gain * 0.3 // Enterprise mix scaling
        }

        guard let fullBuffer = synth.renderClipToBuffer(clip: clip, bpm: bpm) else { return }

        let startFrame = AVAudioFramePosition(startOffsetSeconds * sampleRate)
        let frameCount = AVAudioFrameCount(durationSeconds * sampleRate)

        guard startFrame < fullBuffer.frameLength else { return }

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

    /// Stop all playback and silence the synth chain.
    public func stopAll() {
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
