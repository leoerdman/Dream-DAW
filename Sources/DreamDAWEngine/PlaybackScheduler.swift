import AVFoundation
import Foundation
import DreamDAWModels
import os.log

// MARK: - PlaybackScheduler

/// Schedules audio clip playback with sample-accurate timing.
/// Manages AVAudioPlayerNode scheduling for all clips across all tracks.
public final class PlaybackScheduler {

    // MARK: - Properties

    private let audioEngine: AudioEngine
    private let trackMixer: TrackMixer
    private let logger = Logger(subsystem: "com.dreamdaw", category: "PlaybackScheduler")

    /// Cache of loaded audio files to avoid re-reading.
    private var audioFileCache: [URL: AVAudioFile] = [:]

    // MARK: - Initialization

    public init(audioEngine: AudioEngine, trackMixer: TrackMixer) {
        self.audioEngine = audioEngine
        self.trackMixer = trackMixer
    }

    // MARK: - Scheduling

    /// Schedule all clips for playback from a given position.
    public func schedulePlayback(project: Project, from position: TimePosition) {
        let bpm = project.bpm

        for track in project.tracks {
            guard let player = trackMixer.playerNode(for: track.id) else { continue }

            // Stop any current playback on this player
            player.stop()

            // Schedule each clip that is at or after the playback position
            for clip in track.clips {
                // Skip clips that end before the playback position
                if clip.endPosition.beats <= position.beats { continue }

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

                    file.framePosition = startFrame

                    player.scheduleSegment(
                        file,
                        startingFrame: startFrame,
                        frameCount: actualFrameCount,
                        at: delaySeconds > 0 ? audioTime(delaySeconds: delaySeconds) : nil
                    )

                    logger.debug("Scheduled clip '\(clip.name)' on track '\(track.name)' — start: \(startFrame), frames: \(actualFrameCount)")

                } catch {
                    logger.error("Failed to load audio file \(clip.fileURL.lastPathComponent): \(error.localizedDescription)")
                }
            }

            // Start the player
            player.play()
        }
    }

    /// Stop all playback.
    public func stopAll() {
        trackMixer.stopAll()
    }

    // MARK: - Audio File Loading

    private func loadAudioFile(url: URL) throws -> AVAudioFile {
        if let cached = audioFileCache[url] {
            return cached
        }

        let file = try AVAudioFile(forReading: url)
        audioFileCache[url] = file
        return file
    }

    /// Clear the audio file cache.
    public func clearCache() {
        audioFileCache.removeAll()
    }

    // MARK: - Helpers

    private func audioTime(delaySeconds: Double) -> AVAudioTime? {
        guard let lastRenderTime = audioEngine.avAudioEngine.outputNode.lastRenderTime else { return nil }
        let sampleRate = audioEngine.sampleRate
        let delaySamples = AVAudioFramePosition(delaySeconds * sampleRate)
        return AVAudioTime(sampleTime: lastRenderTime.sampleTime + delaySamples, atRate: sampleRate)
    }
}
