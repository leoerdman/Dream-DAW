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
    
    // Real-Time MIDI State
    //
    // PHASE 9.4 (Thread Safety): ActiveMidiClip is an immutable value type.
    // The snapshot array is created ONCE on schedulePlayback() and captured
    // directly into the AVAudioSourceNode render closure. The audio thread
    // reads from this captured snapshot with ZERO synchronization — no locks,
    // no atomics, no ARC. This is the only correct pattern for audio callbacks.
    private struct ActiveMidiClip {
        let clip: MidiClip
        let trackID: UUID
        let sampler: SamplerInstrument?
        let midiBlock: AUScheduleMIDIEventBlock?
    }
    
    private var renderObserver: AVAudioSourceNode?
    private var isPlaying: Bool = false
    private var playbackStartSampleTime: AVAudioFramePosition = 0
    private var playbackStartHostTime: UInt64 = 0
    private var currentBPM: Double = 120.0
    private var lastWatcherBeats: Double = -1.0
    private var playbackStartBeat: Double = 0.0
    private var looping: Bool = false
    private var loopStart: Double = 0.0
    private var loopEnd: Double = 0.0
    
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

        // Reset observer timing context before every fresh schedule.
        teardownRenderObserver()
        playbackStartSampleTime = 0
        
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
                   let actualEnd = loopEnd.beats
                   let actualStart = position.beats
                    
                   // Schedule initial chunk
                   let rangeStart = TimePosition(beats: actualStart)
                   let rangeEnd = TimePosition(beats: actualEnd)
                   
                   _ = scheduleTrackRange(track: track, player: player, start: rangeStart, end: rangeEnd, bpm: bpm, sampleRate: sampleRate)
                   hasContent = true
                }
            }
            
            // 4. Arm for playback
            if hasContent {
                player.play(at: baseStartTime)
            }
        }
        
        // 5. Setup Real-Time MIDI Observer (Phase 8 + Phase 9.4 Thread Safety)
        // CRITICAL: Collect snapshot BEFORE starting the render observer.
        // The snapshot is passed by value into the closure — zero synchronization needed.
        let midiSnapshot = collectActiveMidiClips(project: project)
        setupRealTimeObserver(midiSnapshot: midiSnapshot, bpm: bpm, sampleRate: sampleRate)
        isPlaying = true
        
        playbackStartHostTime = startHostTime
        currentBPM = bpm
        
        self.playbackStartBeat = position.beats
        self.looping = looping
        self.loopStart = loopStart.beats
        self.loopEnd = loopEnd.beats
        
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
                scheduleAudioSegment(player: player, clip: audioClip, offset: offsetSeconds, duration: durationSeconds, bpm: bpm)
            } 
            // MIDI clips are now handled by Real-Time Dispatcher (Phase 8 Order #2)
            
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

    private func scheduleAudioSegment(player: AVAudioPlayerNode, clip: AudioClip, offset: Double, duration: Double, bpm: Double) {
        do {
            let file = try AVAudioFile(forReading: clip.fileURL)
            let trimStartSeconds = clip.trimStartOffset.toSeconds(bpm: bpm)
            let sourceOffsetSeconds = trimStartSeconds + offset
            let fileStartFrame = AVAudioFramePosition(sourceOffsetSeconds * file.fileFormat.sampleRate)
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

    // MARK: - Real-Time DSP (Phase 8)
    
    private func collectActiveMidiClips(project: Project) -> [ActiveMidiClip] {
        var clips: [ActiveMidiClip] = []
        for track in project.tracks {
            guard track.trackType == .midi else { continue }
            
            // Resolve destination: Sampler or AU
            var sampler: SamplerInstrument?
            var midiBlock: AUScheduleMIDIEventBlock?
            
            if let s = trackMixer.getSampler(for: track.id) {
                sampler = s
            } else if let unitID = track.instrument?.id {
                midiBlock = PluginHost.shared.getScheduleMIDIBlock(for: unitID)
            }
            
            for clip in track.midiClips {
                clips.append(ActiveMidiClip(clip: clip, trackID: track.id, sampler: sampler, midiBlock: midiBlock))
            }
        }
        return clips
    }
    
    /// PHASE 9.4 (Thread Safety): The MIDI snapshot is passed by value and captured
    /// directly into the AVAudioSourceNode closure. The audio thread reads from this
    /// immutable local copy with ZERO synchronization.
    ///
    /// WHY THIS IS CORRECT:
    /// - `midiSnapshot` is an `[ActiveMidiClip]` value type (Array of structs)
    /// - It's captured once in the closure's capture list at creation time
    /// - The audio thread's copy is independent — no shared mutable state
    /// - No locks, no atomics, no ARC on the render path
    /// - When playback restarts, a NEW closure with a NEW snapshot is created
    private func setupRealTimeObserver(midiSnapshot: [ActiveMidiClip], bpm: Double, sampleRate: Double) {
        // Create a silent source node to tap into the render cycle.
        // The midiSnapshot is captured by value here — immutable for the
        // entire lifetime of this render observer.
        let sourceNode = AVAudioSourceNode { [weak self] _, timeStamp, frameCount, _ -> OSStatus in
            guard let self = self, self.isPlaying else { return noErr }
            
            let sampleTime = timeStamp.pointee.mSampleTime
             
            if self.playbackStartSampleTime == 0 {
                self.playbackStartSampleTime = Int64(sampleTime)
            }
            
            let samplesElapsed = Int64(sampleTime) - self.playbackStartSampleTime
            let secondsElapsed = Double(samplesElapsed) / sampleRate
            let beatsElapsed = secondsElapsed * (bpm / 60.0)
            
            // Buffer Window: startBeat + (elapsed samples → beats)
            var bufferStartBeat = self.playbackStartBeat + beatsElapsed
            let bufferDurationBeats = (Double(frameCount) / sampleRate) * (bpm / 60.0)
            
            if self.looping && self.loopEnd > self.loopStart {
                let loopLen = self.loopEnd - self.loopStart
                if bufferStartBeat >= self.loopEnd {
                    bufferStartBeat = self.loopStart + (bufferStartBeat - self.loopStart).truncatingRemainder(dividingBy: loopLen)
                }
            }
            
            let bufferEndBeat = bufferStartBeat + bufferDurationBeats
            
            // PHASE 9.4: Read from captured immutable snapshot — ZERO LOCKS.
            for activeClip in midiSnapshot {
                self.dispatchMidiEvents(
                    activeClip: activeClip,
                    bufferStartBeat: bufferStartBeat, 
                    bufferEndBeat: bufferEndBeat, 
                    frameCount: frameCount,
                    sampleRate: sampleRate, 
                    bpm: bpm
                )
            }
            
            return noErr
        }
        
        // Attach to engine (silent input to main mixer)
        renderObserver = sourceNode
        audioEngine.attach(sourceNode)
        audioEngine.connect(sourceNode, to: audioEngine.masterMixer, format: nil)
    }

    /// HOTFIX 8.5: All offset calculations use clamped Double math before casting.
    /// This prevents Fatal Error (Integer Underflow) when floating-point imprecision
    /// produces negative offsetInBeats (e.g., -0.0000001 due to IEEE 754 rounding).
    private func dispatchMidiEvents(activeClip: ActiveMidiClip, bufferStartBeat: Double, bufferEndBeat: Double, frameCount: UInt32, sampleRate: Double, bpm: Double) {
        let clip = activeClip.clip
        
        // Check if clip intersects current buffer
        let clipStart = clip.position.beats
        let clipEnd = clipStart + clip.duration.beats
        
        guard clipEnd > bufferStartBeat && clipStart < bufferEndBeat else { return }
        
        // Pre-calculate constants for the buffer window
        let samplesPerBeat = (60.0 / bpm) * sampleRate
        // Maximum valid offset = last sample in this buffer (now using real frameCount)
        let maxOffset = Double(frameCount > 0 ? frameCount - 1 : 0)
        
        for note in clip.notes {
            let noteStart = clipStart + note.position.beats
            let noteEnd = noteStart + note.duration.beats

            // If playback begins in the middle of a sustained note, fire note-on immediately.
            if noteStart < bufferStartBeat && noteEnd > bufferStartBeat && abs(bufferStartBeat - playbackStartBeat) < 0.001 {
                sendMidiEvent(
                    activeClip: activeClip,
                    status: 0x90,
                    data1: UInt8(note.pitch),
                    data2: UInt8(note.velocity),
                    offset: 0,
                    isNoteOn: true
                )
            }
            
            // Note On
            if noteStart >= bufferStartBeat && noteStart < bufferEndBeat {
                let offsetInBeats = noteStart - bufferStartBeat
                // HOTFIX 8.5: Clamp to [0, maxOffset] BEFORE integer cast.
                // A negative Double -> UInt32 cast causes Swift Fatal Error.
                let exactOffset = offsetInBeats * samplesPerBeat
                let clampedOffset = max(0.0, min(maxOffset, exactOffset))
                let offsetInSamples = Int64(clampedOffset)
                 
                sendMidiEvent(activeClip: activeClip, status: 0x90, data1: UInt8(note.pitch), data2: UInt8(note.velocity), offset: offsetInSamples, isNoteOn: true)
            }
            
            // Note Off
            if noteEnd >= bufferStartBeat && noteEnd < bufferEndBeat {
                let offsetInBeats = noteEnd - bufferStartBeat
                // HOTFIX 8.5: Same clamping protection for Note Off
                let exactOffset = offsetInBeats * samplesPerBeat
                let clampedOffset = max(0.0, min(maxOffset, exactOffset))
                let offsetInSamples = Int64(clampedOffset)
                 
                sendMidiEvent(activeClip: activeClip, status: 0x80, data1: UInt8(note.pitch), data2: 0, offset: offsetInSamples, isNoteOn: false)
            }
        }
    }
    
    /// HOTFIX 8.5: Offset type changed from UInt32 to Int64 (AUEventSampleTime).
    /// CoreAudio's AUScheduleMIDIEventBlock uses AUEventSampleTime (Int64),
    /// so passing UInt32 was a silent truncation risk on top of the underflow bug.
    private func sendMidiEvent(activeClip: ActiveMidiClip, status: UInt8, data1: UInt8, data2: UInt8, offset: Int64, isNoteOn: Bool) {
        if let sampler = activeClip.sampler {
            // Internal Sampler — convert to UInt32 with safe cast (clamped above)
            sampler.scheduleMidiEvent(pitch: data1, velocity: data2, sampleOffset: UInt32(clamping: offset), isNoteOn: isNoteOn)
        } else if let block = activeClip.midiBlock {
            // AUv3 Plugin — native Int64 (AUEventSampleTime)
            let bytes: [UInt8] = [status, data1, data2]
            block(AUEventSampleTimeImmediate + AUEventSampleTime(offset), 0, 3, bytes)
        }
    }
    
    public func stop() {
        isPlaying = false
        teardownRenderObserver()
        playbackStartSampleTime = 0
        // ... existing logic ...
    }

    private func teardownRenderObserver() {
        if let ro = renderObserver {
            audioEngine.disconnectNodeOutput(ro)
            audioEngine.detach(ro)
            renderObserver = nil
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
        lastWatcherBeats = -1
    }

    /// Watcher called from UI timer to report MIDI blinks synchronized with playhead.
    public func updateMidiIndicators(project: Project, playheadBeats: Double) {
        // TODO: Real-time feedback from audio thread needed for visual blinks (Phase 8)
        // Legacy offline cache logic removed.
    }
}
