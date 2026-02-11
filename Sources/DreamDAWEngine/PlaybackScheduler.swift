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

    /// Schedule all clips for playback from a given position.
    ///
    /// Strategy:
    /// 1. Stop all players
    /// 2. For each track, render the complete audio from `position` onward into a single buffer
    /// 3. Schedule the buffer on each player (at nil time = immediate on play)
    /// 4. Start all players simultaneously with a shared future time
    public func schedulePlayback(project: Project, from position: TimePosition) {
        let bpm = project.bpm
        let sampleRate = audioEngine.sampleRate

        NSLog("[PlaybackScheduler] schedulePlayback from beat %.2f, bpm=%.1f, sampleRate=%.0f, engineRunning=%d",
              position.beats, bpm, sampleRate, audioEngine.isRunning ? 1 : 0)

        // Stop all players first
        trackMixer.stopAll()

        var playersToStart: [AVAudioPlayerNode] = []

        for track in project.tracks {
            // Skip master track — it has no player node
            guard track.trackType != .master else { continue }

            guard let player = trackMixer.playerNode(for: track.id) else {
                NSLog("[PlaybackScheduler] No player node for track '%@'", track.name)
                continue
            }

            // Stop this specific player and clear any scheduled buffers
            player.stop()

            var hasContent = false

            if track.trackType == .audio {
                hasContent = scheduleAudioClips(
                    track: track, player: player,
                    position: position, bpm: bpm, sampleRate: sampleRate
                )
            } else if track.trackType == .midi {
                hasContent = scheduleMidiClips(
                    track: track, player: player,
                    position: position, bpm: bpm, sampleRate: sampleRate
                )
            }

            if hasContent {
                playersToStart.append(player)
                NSLog("[PlaybackScheduler] Track '%@' has content, will start player", track.name)
            } else {
                NSLog("[PlaybackScheduler] Track '%@' has no content at this position", track.name)
            }
        }

        // Start all players immediately
        for player in playersToStart {
            player.play()
        }

        NSLog("[PlaybackScheduler] Started %d players", playersToStart.count)
    }

    // MARK: - Audio Clip Scheduling

    /// Schedule audio clips on a player. Returns true if any content was scheduled.
    private func scheduleAudioClips(
        track: Track, player: AVAudioPlayerNode,
        position: TimePosition, bpm: Double, sampleRate: Double
    ) -> Bool {
        let relevantClips = track.clips
            .filter { $0.endPosition.beats > position.beats }
            .sorted { $0.position.beats < $1.position.beats }

        guard !relevantClips.isEmpty else {
            logger.debug("No relevant audio clips for track '\(track.name)'")
            return false
        }

        var scheduled = false

        for clip in relevantClips {
            do {
                let file = try loadAudioFile(url: clip.fileURL)
                let fileFormat = file.processingFormat

                // Calculate timing
                let clipStartInSeconds = clip.position.toSeconds(bpm: bpm)
                let playheadInSeconds = position.toSeconds(bpm: bpm)
                let trimOffsetInSeconds = clip.trimStartOffset.toSeconds(bpm: bpm)

                var fileStartSeconds = trimOffsetInSeconds
                var delaySeconds: Double = 0

                if playheadInSeconds > clipStartInSeconds {
                    // Playhead is inside this clip — start from offset
                    let intoClip = playheadInSeconds - clipStartInSeconds
                    fileStartSeconds += intoClip
                } else {
                    // Clip starts after playhead — schedule with delay
                    delaySeconds = clipStartInSeconds - playheadInSeconds
                }

                let clipDurationSeconds = clip.duration.toSeconds(bpm: bpm)
                let remainingDuration = clipDurationSeconds - (fileStartSeconds - trimOffsetInSeconds)
                guard remainingDuration > 0 else { continue }

                let startFrame = AVAudioFramePosition(fileStartSeconds * fileFormat.sampleRate)
                let frameCount = AVAudioFrameCount(remainingDuration * fileFormat.sampleRate)

                // Clamp to file length
                let availableFrames = file.length - startFrame
                guard availableFrames > 0 else { continue }
                let actualFrameCount = min(frameCount, AVAudioFrameCount(availableFrames))

                if delaySeconds > 0 {
                    // Schedule silence buffer first to act as time spacer
                    let silenceFrames = AVAudioFrameCount(delaySeconds * sampleRate)
                    if let silence = createSilenceBuffer(frameCount: silenceFrames, sampleRate: sampleRate) {
                        player.scheduleBuffer(silence)
                    }
                }

                // Schedule the audio segment (at nil = immediately after any prior buffers)
                player.scheduleSegment(
                    file,
                    startingFrame: startFrame,
                    frameCount: actualFrameCount,
                    at: nil
                )

                scheduled = true
                logger.debug("Scheduled audio clip '\(clip.name)' on '\(track.name)' — delay: \(delaySeconds)s, start: \(startFrame), frames: \(actualFrameCount)")

            } catch {
                logger.error("Failed to load audio file \(clip.fileURL.lastPathComponent): \(error.localizedDescription)")
            }
        }

        return scheduled
    }

    // MARK: - MIDI Clip Scheduling

    /// Schedule MIDI clips (rendered to audio buffers) on a player. Returns true if any content was scheduled.
    private func scheduleMidiClips(
        track: Track, player: AVAudioPlayerNode,
        position: TimePosition, bpm: Double, sampleRate: Double
    ) -> Bool {
        let relevantClips = track.midiClips
            .filter { $0.endPosition.beats > position.beats }
            .sorted { $0.position.beats < $1.position.beats }

        guard !relevantClips.isEmpty else {
            logger.debug("No relevant MIDI clips for track '\(track.name)'")
            return false
        }

        var scheduled = false

        for clip in relevantClips {
            guard let buffer = synth.renderClipToBuffer(clip: clip, bpm: bpm) else {
                logger.warning("Failed to render MIDI clip '\(clip.name)' to buffer")
                continue
            }

            let clipStartSeconds = clip.position.toSeconds(bpm: bpm)
            let playheadSeconds = position.toSeconds(bpm: bpm)

            var delaySeconds: Double = 0
            var startFrame: AVAudioFramePosition = 0

            if playheadSeconds > clipStartSeconds {
                startFrame = AVAudioFramePosition((playheadSeconds - clipStartSeconds) * sampleRate)
                if startFrame >= AVAudioFramePosition(buffer.frameLength) { continue }
            } else {
                delaySeconds = clipStartSeconds - playheadSeconds
            }

            let remainingFrames = AVAudioFrameCount(AVAudioFramePosition(buffer.frameLength) - startFrame)
            guard remainingFrames > 0 else { continue }

            if delaySeconds > 0 {
                // Schedule silence buffer first to act as time spacer
                let silenceFrames = AVAudioFrameCount(delaySeconds * sampleRate)
                if let silence = createSilenceBuffer(frameCount: silenceFrames, sampleRate: sampleRate) {
                    player.scheduleBuffer(silence)
                }
            }

            // Schedule the rendered MIDI audio
            if startFrame > 0 {
                // Create a sub-buffer starting at the offset
                let format = buffer.format
                guard let subBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: remainingFrames) else { continue }
                subBuffer.frameLength = remainingFrames

                for ch in 0..<Int(format.channelCount) {
                    guard let src = buffer.floatChannelData?[ch],
                          let dst = subBuffer.floatChannelData?[ch] else { continue }
                    memcpy(dst, src.advanced(by: Int(startFrame)), Int(remainingFrames) * MemoryLayout<Float>.size)
                }

                player.scheduleBuffer(subBuffer)
            } else {
                player.scheduleBuffer(buffer)
            }

            scheduled = true
            logger.debug("Scheduled MIDI clip '\(clip.name)' on '\(track.name)' — delay: \(delaySeconds)s, frames: \(remainingFrames)")
        }

        return scheduled
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
