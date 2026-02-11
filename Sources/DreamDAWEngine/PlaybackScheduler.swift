import AVFoundation
import Foundation
import DreamDAWModels
import os.log

// MARK: - PlaybackScheduler

/// Schedules audio clip playback with sample-accurate timing.
/// Manages AVAudioPlayerNode scheduling for all clips across all tracks.
/// Uses a single reference time for all scheduling to ensure multi-clip accuracy.
public final class PlaybackScheduler {

    // MARK: - Properties

    private let audioEngine: AudioEngine
    private let trackMixer: TrackMixer
    private let synth: SimpleSynthInstrument
    private let logger = Logger(subsystem: "com.dreamdaw", category: "PlaybackScheduler")

    /// Cache of loaded audio files to avoid re-reading.


    // MARK: - Initialization

    public init(audioEngine: AudioEngine, trackMixer: TrackMixer) {
        self.audioEngine = audioEngine
        self.trackMixer = trackMixer
        self.synth = SimpleSynthInstrument(sampleRate: audioEngine.sampleRate)
    }

    // MARK: - Scheduling

    /// Schedule all clips for playback from a given position.
    /// Uses a single reference time captured once to ensure all clips are
    /// sample-accurately aligned regardless of how many clips exist.
    public func schedulePlayback(project: Project, from position: TimePosition) {
        let bpm = project.bpm
        let sampleRate = audioEngine.sampleRate

        // Capture a single reference time ONCE for all scheduling
        guard let lastRenderTime = audioEngine.avAudioEngine.outputNode.lastRenderTime else {
            logger.error("Cannot schedule: no lastRenderTime available")
            return
        }

        // Small offset to allow scheduling to complete before playback starts
        let schedulingBufferSamples: Int64 = Int64(0.05 * sampleRate) // 50ms buffer
        let referenceHostTime = lastRenderTime.sampleTime + schedulingBufferSamples

        for track in project.tracks {
            guard let player = trackMixer.playerNode(for: track.id) else { continue }

            // Stop any current playback on this player
            player.stop()

            if track.trackType == .audio {
                scheduleAudioClips(track: track, player: player, position: position, bpm: bpm, sampleRate: sampleRate, referenceHostTime: referenceHostTime)
            } else if track.trackType == .midi {
                scheduleMidiClips(track: track, player: player, position: position, bpm: bpm, sampleRate: sampleRate, referenceHostTime: referenceHostTime)
            }

            // Start the player
            player.play()
        }
    }

    // MARK: - Audio Clip Scheduling

    private func scheduleAudioClips(track: Track, player: AVAudioPlayerNode, position: TimePosition, bpm: Double, sampleRate: Double, referenceHostTime: AVAudioFramePosition) {
        // Collect all clips that need to be scheduled, sorted by position
        let relevantClips = track.clips
            .filter { $0.endPosition.beats > position.beats }
            .sorted { $0.position.beats < $1.position.beats }

        guard !relevantClips.isEmpty else { return }

            for clip in relevantClips {
                do {
                    let file = try loadAudioFile(url: clip.fileURL)
                    let fileFormat = file.processingFormat

                    // Calculate where in the file to start reading
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

                    // Calculate absolute audio time from the shared reference
                    let delaySamples = AVAudioFramePosition(delaySeconds * sampleRate)
                    let absoluteStartTime = AVAudioTime(
                        sampleTime: referenceHostTime + delaySamples,
                        atRate: sampleRate
                    )

                    player.scheduleSegment(
                        file,
                        startingFrame: startFrame,
                        frameCount: actualFrameCount,
                        at: absoluteStartTime
                    )

                    logger.debug("Scheduled clip '\(clip.name)' on track '\(track.name)' — delay: \(delaySeconds)s, start: \(startFrame), frames: \(actualFrameCount)")

                } catch {
                    logger.error("Failed to load audio file \(clip.fileURL.lastPathComponent): \(error.localizedDescription)")
                }
            }
    }

    // MARK: - MIDI Clip Scheduling

    private func scheduleMidiClips(track: Track, player: AVAudioPlayerNode, position: TimePosition, bpm: Double, sampleRate: Double, referenceHostTime: AVAudioFramePosition) {
        let relevantClips = track.midiClips
            .filter { $0.endPosition.beats > position.beats }
            .sorted { $0.position.beats < $1.position.beats }

        guard !relevantClips.isEmpty else { return }

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

            let delaySamples = AVAudioFramePosition(delaySeconds * sampleRate)
            let absoluteStartTime = AVAudioTime(
                sampleTime: referenceHostTime + delaySamples,
                atRate: sampleRate
            )

            // Schedule the pre-rendered buffer segment
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

                player.scheduleBuffer(subBuffer, at: absoluteStartTime)
            } else {
                player.scheduleBuffer(buffer, at: absoluteStartTime)
            }

            logger.debug("Scheduled MIDI clip '\(clip.name)' on track '\(track.name)' — delay: \(delaySeconds)s, frames: \(remainingFrames)")
        }
    }

    /// Stop all playback and silence the synth.
    public func stopAll() {
        synth.allNotesOff()
        trackMixer.stopAll()
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
