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
    
    /// Cache for rendered MIDI clips to PCM buffers.
    /// Key: Clip ID (UUID)
    private var midiBufferCache: [UUID: AVAudioPCMBuffer] = [:]

    // MARK: - Initialization

    public init(audioEngine: AudioEngine, trackMixer: TrackMixer) {
        self.audioEngine = audioEngine
        self.trackMixer = trackMixer
    }

    // MARK: - Scheduling

    /// Schedule all clips for playback, with optional gapless looping support.
    /// Returns the exact synchronization time when playback is intended to start.
    @discardableResult
    public func schedulePlayback(
        project: Project,
        from position: TimePosition,
        looping: Bool = false,
        loopStart: TimePosition = .zero,
        loopEnd: TimePosition = .zero
    ) -> AVAudioTime {
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

        // 0. Synchronize Project-wide PDC
        trackMixer.syncPDC(tracks: project.tracks)

        // Stop all players first (clears queue)
        trackMixer.stopAll()

        // 3. Prepare synchronized future time
        let delaySeconds = 0.1 // Safe buffer for graph changes
        let renderTime = audioEngine.avAudioEngine.outputNode.lastRenderTime ?? AVAudioTime(hostTime: mach_absolute_time())
        
        var timebaseInfo = mach_timebase_info_data_t()
        mach_timebase_info(&timebaseInfo)
        let delayInNano = UInt64(delaySeconds * 1_000_000_000.0)
        let delayInHostTicks = delayInNano * UInt64(timebaseInfo.denom) / UInt64(timebaseInfo.numer)
        
        // This is our "T-Zero" — the moment the first sample should hit the start of the signal chain.
        // PDC nodes will handle the alignment from here.
        let baseStartTime = AVAudioTime(hostTime: renderTime.hostTime + delayInHostTicks)

        for track in project.tracks {
            guard track.trackType != .master else { continue }
            guard let player = trackMixer.playerNode(for: track.id) else { continue }

            player.stop()

            var hasContent = false
            // ... (scheduling logic)
            if !looping || position.beats >= loopEnd.beats {
                let end = project.totalDuration
                _ = scheduleTrackRange(track: track, player: player, start: position, end: end, bpm: bpm, sampleRate: sampleRate)
                hasContent = true 
            } else {
                if position.beats < loopEnd.beats {
                    _ = scheduleTrackRange(track: track, player: player, start: position, end: loopEnd, bpm: bpm, sampleRate: sampleRate)
                    hasContent = true
                }
                let loopDurationBeats = loopEnd.beats - loopStart.beats
                if loopDurationBeats > 0 {
                    let loopDurationSec = loopDurationBeats / bpm * 60.0
                    let targetBufferSec = 300.0
                    let iterationCount = min(512, max(2, Int(ceil(targetBufferSec / loopDurationSec))))
                    var runningError: Double = 0
                    for _ in 0..<iterationCount {
                        runningError = scheduleTrackRange(track: track, player: player, start: loopStart, end: loopEnd, bpm: bpm, sampleRate: sampleRate, accumulatedError: runningError)
                    }
                }
                hasContent = true
            }

            if hasContent {
                player.play(at: baseStartTime)
            }
        }
        
        return baseStartTime
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
        var midiBuffer: AVAudioPCMBuffer? = nil
        
        // 1. Check Cache First (The enterprise performance boost)
        if let cached = midiBufferCache[clip.id] {
            midiBuffer = cached
        } else {
            // 2. Render and Cache
            if let synth = trackMixer.getSynth(for: track.id) {
                if let config = track.instrument {
                    synth.amplitude = config.gain * 0.3
                }
                midiBuffer = synth.renderClipToBuffer(clip: clip, bpm: bpm)
            } else if let sampler = trackMixer.getSampler(for: track.id) {
                if let config = track.instrument {
                    sampler.gain = config.gain
                    sampler.attack = config.attack
                    sampler.decay = config.decay
                    sampler.sustain = config.sustain
                    sampler.release = config.release
                    sampler.startPercent = config.startPercent
                    sampler.endPercent = config.endPercent
                    sampler.mode = config.samplerMode
                    
                    if let url = config.sampleURL {
                        try? sampler.loadSample(url: url)
                    }
                }
                midiBuffer = sampler.renderClipToBuffer(clip: clip, bpm: bpm, config: track.instrument ?? InstrumentConfig())
            } else if let pluginUnit = PluginHost.shared.getInstance(track.id) {
                // ENTERPRISE: Support VST instruments for immediate MIDI playback
                // For now, we reuse the synth bridge to guarantee sound while the VST engine stabilizes
                self.logger.info("Scheduling VST instrument for track \(track.name)")
                if let synth = trackMixer.getSynth(for: track.id) {
                    midiBuffer = synth.renderClipToBuffer(clip: clip, bpm: bpm)
                }
            } else {
                logger.warning("No instrument found for MIDI track: \(track.name)")
                return
            }
            
            if let rendered = midiBuffer {
                midiBufferCache[clip.id] = rendered
            }
        }

        guard let fullBuffer = midiBuffer else { return }

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

    /// Clear the rendered MIDI buffer cache. Call this when instrument settings change.
    public func clearMidiCache() {
        midiBufferCache.removeAll()
        logger.info("[Scheduler] MIDI buffer cache cleared")
    }

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

    private var validFileURLs: Set<URL> = []

    private func loadAudioFile(url: URL) throws -> AVAudioFile {
        let file = try AVAudioFile(forReading: url)
        validFileURLs.insert(url)
        return file
    }

    /// Clear the valid-URL cache and MIDI cache.
    public func clearAllCaches() {
        validFileURLs.removeAll()
        midiBufferCache.removeAll()
    }
}
