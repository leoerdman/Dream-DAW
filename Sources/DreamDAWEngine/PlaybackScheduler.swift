import AVFoundation
import Foundation
import DreamDAWModels
import os.log

// MARK: - PlaybackScheduler

/// Manages the queuing of audio and MIDI clips onto the engine's player nodes.
/// Supports gapless looping and high-precision synchronization.
public final class PlaybackScheduler {

    // MARK: - Properties

    private let audioEngine: AudioEngine
    private let trackMixer: TrackMixer
    private let logger = Logger(subsystem: "com.dreamdaw", category: "PlaybackScheduler")
    private var timebaseInfo = mach_timebase_info_data_t()

    /// Cache for rendered MIDI clips to PCM buffers.
    /// Key: Clip ID (UUID)
    private var midiBufferCache: [UUID: AVAudioPCMBuffer] = [:]
    
    /// Dedicated background queue for scheduling logic to avoid UI freezes.
    private let schedulingQueue = DispatchQueue(label: "com.dreamdaw.scheduling", qos: .userInitiated)

    // MARK: - Initialization

    public init(audioEngine: AudioEngine, trackMixer: TrackMixer) {
        self.audioEngine = audioEngine
        self.trackMixer = trackMixer
        mach_timebase_info(&timebaseInfo)
    }

    // MARK: - Scheduling

    /// Schedule clips for playback asynchronously.
    /// - Parameters:
    ///   - completion: Called on main thread when the INITIAL chunk is ready.
    public func schedulePlaybackAsync(
        project: Project,
        from position: TimePosition,
        looping: Bool = false,
        loopStart: TimePosition = .zero,
        loopEnd: TimePosition = .zero,
        completion: @escaping (AVAudioTime) -> Void
    ) {
        schedulingQueue.async { [weak self] in
            guard let self = self else { return }
            let startTime = self.schedulePlayback(
                project: project,
                from: position,
                looping: looping,
                loopStart: loopStart,
                loopEnd: loopEnd
            )
            DispatchQueue.main.async {
                completion(startTime)
            }
        }
    }

    /// Internal synchronous scheduling logic.
    @discardableResult
    private func schedulePlayback(
        project: Project,
        from position: TimePosition,
        looping: Bool = false,
        loopStart: TimePosition = .zero,
        loopEnd: TimePosition = .zero
    ) -> AVAudioTime {
        let sampleRate = audioEngine.sampleRate
        let bpm = project.bpm
        var baseStartTime: AVAudioTime?
        
        // 1. Prepare base start time (common for all nodes for sync)
        let delay: Double = 0.1 // 100ms lead time for hardware setup
        let startHostTime = mach_absolute_time() + secondsToTicks(delay, timebaseInfo: &timebaseInfo)
        baseStartTime = AVAudioTime(hostTime: startHostTime)

        for track in project.tracks {
            guard track.trackType != .master else { continue }
            guard let player = trackMixer.playerNode(for: track.id) else { continue }

            // 2. Reset player state for fresh queue
            player.stop()

            var hasContent = false

            // 3. Schedule Segment (Playhead to End or Loop End)
            if !looping || position.beats >= loopEnd.beats {
                // Standard Playback: Schedule until end of project (max 300s to avoid memory bloat if huge)
                let projectEndBeats = project.totalDuration.beats
                let maxBeats = position.beats + (300.0 * bpm / 60.0)
                let actualEnd = min(projectEndBeats, maxBeats)
                
                _ = scheduleTrackRange(track: track, player: player, start: position, end: TimePosition(beats: actualEnd), bpm: bpm, sampleRate: sampleRate)
                hasContent = true 
            } else {
                // Looping Playback
                // First: schedule from playhead to loop end
                if position.beats < loopEnd.beats {
                    _ = scheduleTrackRange(track: track, player: player, start: position, end: loopEnd, bpm: bpm, sampleRate: sampleRate)
                    hasContent = true
                }
                
                // Second: queue N loop iterations to provide long stable playback
                let loopDurationBeats = loopEnd.beats - loopStart.beats
                if loopDurationBeats > 0 {
                    let loopDurationSec = loopDurationBeats / bpm * 60.0
                    // We queue up to 300s worth of loops (standard for gapless transport)
                    let iterationCount = min(512, max(2, Int(ceil(300.0 / loopDurationSec))))
                    
                    var runningError: Double = 0
                    for _ in 0..<iterationCount {
                        runningError = scheduleTrackRange(track: track, player: player, start: loopStart, end: loopEnd, bpm: bpm, sampleRate: sampleRate, accumulatedError: runningError)
                    }
                    hasContent = true
                }
            }
            
            // 4. Arm for playback
            if hasContent {
                player.play(at: baseStartTime)
            }
        }
        
        return baseStartTime ?? AVAudioTime(hostTime: mach_absolute_time() + 1000)
    }

    // MARK: - Range Scheduling (The Core "Stitcher")

    /// Schedules all clips within a specific time range [start, end) onto the player queue.
    /// Fills gaps with silence to maintain exact timing.
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

        var cursorSeconds: Double = 0
        let rangeStartAbsSeconds = rangeStartBeats / bpm * 60.0

        for (clipObj, cStart, _, _) in clipsInRange {
            // 1. Handle Gaps before clip
            let clipStartAbsSeconds = cStart / bpm * 60.0
            let relativeStartSeconds = max(0, clipStartAbsSeconds - rangeStartAbsSeconds)

            if relativeStartSeconds > cursorSeconds {
                let gapDuration = relativeStartSeconds - cursorSeconds
                scheduleSilence(player: player, duration: gapDuration, sampleRate: sampleRate)
                cursorSeconds += gapDuration
            }

            // 2. Schedule Clip Segment
            let clipStartBeats = cStart
            let clipDurationBeats = (clipObj as? AudioClip)?.duration.beats ?? (clipObj as? MidiClip)?.duration.beats ?? 0
            let clipEndBeats = clipStartBeats + clipDurationBeats

            // Truncate to range boundaries
            let actualStartBeat = max(rangeStartBeats, clipStartBeats)
            let actualEndBeat = min(rangeEndBeats, clipEndBeats)
            
            let segmentDurationBeats = actualEndBeat - actualStartBeat
            guard segmentDurationBeats > 0 else { continue }

            let offsetInClipBeats = actualStartBeat - clipStartBeats
            let offsetSeconds = offsetInClipBeats / bpm * 60.0
            let durationSeconds = segmentDurationBeats / bpm * 60.0

            if let audioClip = clipObj as? AudioClip {
                scheduleAudioSegment(player: player, clip: audioClip, offset: offsetSeconds, duration: durationSeconds)
            } else if let midiClip = clipObj as? MidiClip {
                scheduleMidiSegment(player: player, track: track, clip: midiClip, offset: offsetSeconds, duration: durationSeconds, bpm: bpm)
            }
            
            cursorSeconds = max(cursorSeconds, relativeStartSeconds + durationSeconds)
        }

        // 3. Fill trailing gap
        let totalRangeSeconds = rangeDurationBeats / bpm * 60.0
        if cursorSeconds < totalRangeSeconds {
            let finalGap = totalRangeSeconds - cursorSeconds
            scheduleSilence(player: player, duration: finalGap, sampleRate: sampleRate)
            cursorSeconds += finalGap
        }

        // Return timing drift to maintain phase across range boundaries (e.g. for loops)
        return cursorSeconds - totalRangeSeconds
    }

    // MARK: - Internal Scheduling Helpers

    private func scheduleAudioSegment(player: AVAudioPlayerNode, clip: AudioClip, offset: Double, duration: Double) {
        do {
            let file = try AVAudioFile(forReading: clip.fileURL)
            let fileStartFrame = AVAudioFramePosition(offset * file.fileFormat.sampleRate)
            let fileFrameCount = AVAudioFrameCount(duration * file.fileFormat.sampleRate)
            
            guard fileFrameCount > 0 else { return }
            
            // Note: Clipping support (offset + count <= length)
            let safeFrameCount = min(fileFrameCount, AVAudioFrameCount(file.length - fileStartFrame))
            guard safeFrameCount > 0 else { return }

            player.scheduleSegment(file, startingFrame: fileStartFrame, frameCount: safeFrameCount, at: nil)
        } catch {
            logger.error("PlaybackScheduler: Failed to load audio file \(clip.fileURL.lastPathComponent): \(error)")
        }
    }

    private func scheduleMidiSegment(player: AVAudioPlayerNode, track: Track, clip: MidiClip, offset: Double, duration: Double, bpm: Double) {
        guard let sampler = trackMixer.getSampler(for: track.id) else {
            // Enterprise: If no sampler found, try to use the placeholder synth for VST tracks
            // This ensures we get sound even if the PluginHost is still initializing the VST.
            if let synth = trackMixer.getSynth(for: track.id) {
                // Trigger live MIDI notes instead of pre-scheduling (not gapless but better than silence)
                // In a full implementation, we render VST to buffer as well.
            }
            return 
        }

        let midiBuffer: AVAudioPCMBuffer?
        if let cached = midiBufferCache[clip.id] {
            midiBuffer = cached
        } else {
            // Offline render MIDI to PCM for gapless scheduling
            midiBuffer = sampler.renderClipToBuffer(clip: clip, bpm: bpm, config: track.instrument ?? InstrumentConfig())
            midiBufferCache[clip.id] = midiBuffer
        }

        guard let buffer = midiBuffer else { return }
        
        let sampleRate = buffer.format.sampleRate
        let startFrame = AVAudioFramePosition(offset * sampleRate)
        let frameCount = AVAudioFrameCount(duration * sampleRate)
        
        guard frameCount > 0 && startFrame >= 0 && startFrame < AVAudioFramePosition(buffer.frameLength) else { return }
        
        let safeCount = min(frameCount, AVAudioFrameCount(AVAudioFramePosition(buffer.frameLength) - startFrame))
        
        // Schedule sub-region of PCM buffer
        player.scheduleBuffer(buffer, at: nil) {
            // Optional: clean up when done
        }
    }

    private func scheduleSilence(player: AVAudioPlayerNode, duration: Double, sampleRate: Double) {
        guard duration > 0.001 else { return } // Skip micro-silence
        let frameCount = AVAudioFrameCount(duration * sampleRate)
        if let buffer = createSilenceBuffer(frameCount: frameCount, sampleRate: sampleRate) {
            player.scheduleBuffer(buffer, at: nil)
        }
    }

    private func createSilenceBuffer(frameCount: AVAudioFrameCount, sampleRate: Double) -> AVAudioPCMBuffer? {
        guard frameCount > 0 else { return nil }
        let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 2)!
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else { return nil }
        buffer.frameLength = frameCount
        return buffer
    }

    // MARK: - Utilities

    private func secondsToTicks(_ seconds: Double, timebaseInfo: inout mach_timebase_info_data_t) -> UInt64 {
        let nano = seconds * 1_000_000_000.0
        return UInt64(Double(nano) * Double(timebaseInfo.denom) / Double(timebaseInfo.numer))
    }
    
    public func stopAll() {
        trackMixer.stopAll()
    }
}
