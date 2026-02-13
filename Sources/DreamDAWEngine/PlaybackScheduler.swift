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
    //
    // PHASE 9.3 (AbsoluteTime): Each ActiveMidiClip now carries pre-computed
    // sample-frame positions for the clip and its notes. This eliminates
    // floating-point beat→sample conversion on every render callback.
    private struct ActiveMidiClip {
        let clip: MidiClip
        let trackID: UUID
        let sampler: SamplerInstrument?
        let midiBlock: AUScheduleMIDIEventBlock?
        
        // Pre-computed sample-frame positions (Phase 9.3)
        let clipStartFrame: Int64
        let clipEndFrame: Int64
        
        /// Pre-computed note positions in sample frames relative to project start.
        struct NoteFrameData {
            let pitch: Int
            let velocity: Int
            let startFrame: Int64
            let endFrame: Int64
        }
        let noteFrames: [NoteFrameData]
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

            let actualEnd = looping ? loopEnd.beats : max(project.totalDuration.beats, position.beats + 128.0)
            
            // 2. Reset player state for fresh queue
            player.stop()

            var hasContent = false

            // 3. Schedule Segment (Playhead to End or Loop End)
            if !looping || position.beats >= loopEnd.beats {
                // Standard Playback: Schedule until end of project
                _ = scheduleTrackRange(track: track, player: player, start: position, end: TimePosition(beats: actualEnd), bpm: bpm, sampleRate: sampleRate, baseStartTime: baseStartTime!)
                hasContent = true 
            } else {
                // Looping Playback
                // First: schedule from playhead to loop end
                if position.beats < loopEnd.beats {
                   let actualStart = position.beats
                    
                   // Schedule initial chunk
                   let rangeStart = TimePosition(beats: actualStart)
                   let rangeEnd = TimePosition(beats: actualEnd)
                   
                   _ = scheduleTrackRange(track: track, player: player, start: rangeStart, end: rangeEnd, bpm: bpm, sampleRate: sampleRate, baseStartTime: baseStartTime!)
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
        baseStartTime: AVAudioTime
    ) -> Double {
        let rangeStartBeats = start.beats
        let rangeEndBeats = end.beats

        // Filter clips touching this range
        var clipsInRange: [AudioClip] = []
        if track.trackType == .audio {
            clipsInRange = track.clips.filter {
                $0.endPosition.beats > rangeStartBeats && $0.position.beats < rangeEndBeats
            }
        }
        
        // Sort by time
        clipsInRange.sort { $0.position.beats < $1.position.beats }

        for clip in clipsInRange {
            // Calculate clip intersection with the requested range
            let clipStartBeats = clip.position.beats
            let clipEndBeats = clip.endPosition.beats

            let actualStartBeat = max(rangeStartBeats, clipStartBeats)
            let actualEndBeat = min(rangeEndBeats, clipEndBeats)
            
            let segmentDurationBeats = actualEndBeat - actualStartBeat
            guard segmentDurationBeats > 0 else { continue }

            // 1. Calculate the START TIME for this segment relative to the project start
            let startOffsetBeats = actualStartBeat - rangeStartBeats
            let startOffsetSeconds = startOffsetBeats / bpm * 60.0
            
            // 2. Adjust base audio time for this segment
            let segmentStartTime = baseStartTime.atSeconds(startOffsetSeconds)

            // 3. Calculate internal clip offset (if we are starting mid-clip)
            let offsetInClipBeats = actualStartBeat - clipStartBeats
            let offsetSeconds = offsetInClipBeats / bpm * 60.0
            let durationSeconds = segmentDurationBeats / bpm * 60.0

            scheduleAudioSegment(
                player: player, 
                clip: clip, 
                offset: offsetSeconds, 
                duration: durationSeconds, 
                at: segmentStartTime,
                bpm: bpm
            )
        }

        return 0 // Drift no longer relevant with absolute timing
    }

    // MARK: - Internal Scheduling Helpers

    private func scheduleAudioSegment(player: AVAudioPlayerNode, clip: AudioClip, offset: Double, duration: Double, at startTime: AVAudioTime, bpm: Double) {
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

            player.scheduleSegment(file, startingFrame: fileStartFrame, frameCount: safeFrameCount, at: startTime)
        } catch {
            logger.error("PlaybackScheduler: Failed to load audio file \(clip.fileURL.lastPathComponent): \(error)")
        }
    }

    // MARK: - Real-Time DSP (Phase 8)
    
    /// PHASE 9.3 (AbsoluteTime): Pre-computes sample-frame positions for all MIDI clips
    /// and their notes. This work happens ONCE on the main thread before the render
    /// observer starts — the audio thread reads from immutable pre-computed frames.
    private func collectActiveMidiClips(project: Project) -> [ActiveMidiClip] {
        var clips: [ActiveMidiClip] = []
        let sampleRate = audioEngine.sampleRate
        let bpm = project.bpm
        
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
                // Use AbsoluteTime when available; fall back to beat→sample conversion
                let clipStartFrame: Int64
                let clipDurationFrames: Int64
                
                if clip.absolutePosition.sampleFrame != 0 || clip.position.beats == 0 {
                    clipStartFrame = clip.absolutePosition.sampleFrame
                    clipDurationFrames = clip.absoluteDuration.sampleFrame
                } else {
                    // Backward compatibility: compute from beats
                    let secondsPerBeat = 60.0 / bpm
                    clipStartFrame = Int64(clip.position.beats * secondsPerBeat * sampleRate)
                    clipDurationFrames = Int64(clip.duration.beats * secondsPerBeat * sampleRate)
                }
                
                let clipEndFrame = clipStartFrame + clipDurationFrames
                
                // Pre-compute note positions in absolute sample frames
                var noteFrames: [ActiveMidiClip.NoteFrameData] = []
                noteFrames.reserveCapacity(clip.notes.count)
                
                let secondsPerBeat = 60.0 / bpm
                for note in clip.notes {
                    let noteOffsetFrames = Int64(note.position.beats * secondsPerBeat * sampleRate)
                    let noteDurationFrames = Int64(note.duration.beats * secondsPerBeat * sampleRate)
                    let noteStart = clipStartFrame + noteOffsetFrames
                    let noteEnd = noteStart + noteDurationFrames
                    
                    noteFrames.append(ActiveMidiClip.NoteFrameData(
                        pitch: note.pitch,
                        velocity: note.velocity,
                        startFrame: noteStart,
                        endFrame: noteEnd
                    ))
                }
                
                clips.append(ActiveMidiClip(
                    clip: clip,
                    trackID: track.id,
                    sampler: sampler,
                    midiBlock: midiBlock,
                    clipStartFrame: clipStartFrame,
                    clipEndFrame: clipEndFrame,
                    noteFrames: noteFrames
                ))
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
    /// PHASE 9.3 + 9.4: The render observer now works in sample frames (Int64) instead
    /// of floating-point beats. Combined with pre-computed note frame data from
    /// collectActiveMidiClips(), this eliminates ALL floating-point arithmetic
    /// from the audio thread's hot path.
    private func setupRealTimeObserver(midiSnapshot: [ActiveMidiClip], bpm: Double, sampleRate: Double) {
        // Pre-compute loop boundaries in sample frames (done once, not per-callback)
        let loopStartFrame = Int64(self.loopStart * (60.0 / bpm) * sampleRate)
        let loopEndFrame = Int64(self.loopEnd * (60.0 / bpm) * sampleRate)
        let playbackStartFrame = Int64(self.playbackStartBeat * (60.0 / bpm) * sampleRate)
        let isLooping = self.looping
        
        // Create a silent source node to tap into the render cycle.
        // The midiSnapshot is captured by value here — immutable for the
        // entire lifetime of this render observer.
        let sourceNode = AVAudioSourceNode { [weak self] _, timeStamp, frameCount, _ -> OSStatus in
            guard let self = self, self.isPlaying else { return noErr }
            
            let sampleTime = timeStamp.pointee.mSampleTime
             
            if self.playbackStartSampleTime == 0 {
                self.playbackStartSampleTime = Int64(sampleTime)
            }
            
            // PHASE 9.3: Work entirely in sample frames — zero floating-point conversion.
            let samplesElapsed = Int64(sampleTime) - self.playbackStartSampleTime
            let bufferStartFrame = playbackStartFrame + samplesElapsed
            let bufferFrameCount = Int64(frameCount)
            
            // PHASE 10 Audit: Handle loop boundary straddling (Split Dispatch).
            // A single buffer might start before loopEndFrame and end after it.
            // We must process this in two chunks to ensure MIDI events at the wrap point are scheduled correctly.
            var framesProcessed: Int64 = 0
            var currentBufferPosition = bufferStartFrame // This changes during wrap-around
            
            while framesProcessed < bufferFrameCount {
                var remainingInChunk = bufferFrameCount - framesProcessed
                
                // If looping is on, check if this chunk crosses the loop end
                if isLooping && loopEndFrame > loopStartFrame {
                    let samplesToLoopEnd = loopEndFrame - currentBufferPosition
                    if samplesToLoopEnd > 0 && samplesToLoopEnd < remainingInChunk {
                        // Split! Process exactly up to loopEndFrame
                        remainingInChunk = samplesToLoopEnd
                    }
                }
                
                let currentChunkEnd = currentBufferPosition + remainingInChunk
                
                // Dispatch for this safe sub-range
                for activeClip in midiSnapshot {
                    self.dispatchMidiEventsAbsolute(
                        activeClip: activeClip,
                        bufferStartFrame: currentBufferPosition,
                        bufferEndFrame: currentChunkEnd,
                        playbackStartPointFrame: playbackStartFrame,
                        frameCount: UInt32(bufferFrameCount),
                        bufferOffset: UInt32(framesProcessed)
                    )
                }
                
                framesProcessed += remainingInChunk
                currentBufferPosition += remainingInChunk
                
                // Wrap-around for the NEXT chunk if we just hit loopEndFrame
                if isLooping && loopEndFrame > loopStartFrame && currentBufferPosition >= loopEndFrame {
                    currentBufferPosition = loopStartFrame
                }
            }
            
            return noErr
        }
        
        // Attach to engine (silent input to main mixer)
        renderObserver = sourceNode
        audioEngine.attach(sourceNode)
        audioEngine.connect(sourceNode, to: audioEngine.masterMixer, format: nil)
    }

    /// PHASE 9.3 (AbsoluteTime): Dispatches MIDI events using pre-computed sample
    /// frame positions. All arithmetic is integer — zero floating-point on the hot path.
    ///
    /// - Parameters:
    ///   - bufferOffset: Offset in frames from the start of the ACTUAL hardware buffer.
    ///     Used when the buffer is split due to looping.
    private func dispatchMidiEventsAbsolute(
        activeClip: ActiveMidiClip,
        bufferStartFrame: Int64,
        bufferEndFrame: Int64,
        playbackStartPointFrame: Int64,
        frameCount: UInt32,
        bufferOffset: UInt32 = 0
    ) {
        // Check if clip intersects current buffer (integer comparison)
        guard activeClip.clipEndFrame > bufferStartFrame &&
              activeClip.clipStartFrame < bufferEndFrame else { return }
        
        for note in activeClip.noteFrames {
            // If playback begins in the middle of a sustained note, fire note-on immediately.
            // PHASE 10 Audit: We only do this if this is the very first sample of the transport start.
            if note.startFrame < bufferStartFrame && note.endFrame > bufferStartFrame {
                if bufferStartFrame == playbackStartPointFrame {
                    sendMidiEvent(
                        activeClip: activeClip,
                        status: 0x90,
                        data1: UInt8(note.pitch),
                        data2: UInt8(note.velocity),
                        offset: Int64(bufferOffset), // Start immediately at the correct buffer offset
                        isNoteOn: true
                    )
                }
            }
            
            // Note On — integer math only
            if note.startFrame >= bufferStartFrame && note.startFrame < bufferEndFrame {
                let internalOffset = note.startFrame - bufferStartFrame
                let totalOffset = Int64(bufferOffset) + internalOffset
                // Order #1 Compliance: Clamp to [0, frameCount-1] to prevent Integer Underflow Fatal Error
                let finalOffset = max(0, min(Int64(frameCount) - 1, totalOffset))
                
                sendMidiEvent(
                    activeClip: activeClip,
                    status: 0x90,
                    data1: UInt8(note.pitch),
                    data2: UInt8(note.velocity),
                    offset: finalOffset,
                    isNoteOn: true
                )
            }
            
            // Note Off — integer math only
            if note.endFrame >= bufferStartFrame && note.endFrame < bufferEndFrame {
                let internalOffset = note.endFrame - bufferStartFrame
                let totalOffset = Int64(bufferOffset) + internalOffset
                // Order #1 Compliance: Same clamping for Note Off
                let finalOffset = max(0, min(Int64(frameCount) - 1, totalOffset))
                
                sendMidiEvent(
                    activeClip: activeClip,
                    status: 0x80,
                    data1: UInt8(note.pitch),
                    data2: 0,
                    offset: finalOffset,
                    isNoteOn: false
                )
            }
        }
    }
    
    /// Legacy beat-based dispatch — kept for backward compatibility with
    /// any callers that haven't migrated to AbsoluteTime yet.
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
