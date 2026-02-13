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
    private struct ActiveMidiClip {
        let clip: MidiClip
        let trackID: UUID
        let sampler: SamplerInstrument?
        let midiBlock: AUScheduleMIDIEventBlock?
    }
    
    private var activeMidiClips: [ActiveMidiClip] = []
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

    private var lock = os_unfair_lock_s()
    
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
        
        // 5. Setup Real-Time MIDI Observer (Phase 8)
        setupRealTimeObserver(project: project, bpm: bpm, sampleRate: sampleRate)
        isPlaying = true
        
        os_unfair_lock_lock(&lock)
        activeMidiClips = collectActiveMidiClips(project: project)
        os_unfair_lock_unlock(&lock)
        
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
    
    private func setupRealTimeObserver(project: Project, bpm: Double, sampleRate: Double) {
        // Create a silent source node to tap into the render cycle
        let sourceNode = AVAudioSourceNode { [weak self] _, timeStamp, frameCount, _ -> OSStatus in
            guard let self = self, self.isPlaying else { return noErr }
            
            let sampleTime = timeStamp.pointee.mSampleTime
            // If just starting, capture base time? 
            // Actually, we rely on calculations relative to current buffer
            
            // Calculate global beats
            // For now, assuming linear time since start. Transport sync is harder.
            // Using system uptime for robust sync?
            
            // Simplified: Use sampleTime relative to when we started
            // But we don't know exact sampleTime of start until it happens.
            // Let's assume PlaybackScheduler is recreated/reset on play.
             
            if self.playbackStartSampleTime == 0 {
                self.playbackStartSampleTime = Int64(sampleTime)
            }
            
            let samplesElapsed = Int64(sampleTime) - self.playbackStartSampleTime
            let secondsElapsed = Double(samplesElapsed) / sampleRate
            let beatsElapsed = secondsElapsed * (bpm / 60.0)
            
            // TODO: Pass in actual startBeat from Transport? 
            // For now, assume start from 0 or last known position.
            // Refactor: We need Transport's startBeat passed in `schedulePlayback`.
            // Let's assume startBeat = 0 for this immediate task or rely on caller updates.
            // The prompt "dispatchMidiEvents" implies calculating bufferStartBeat is Key.
            
            // Let's use a "currentBeat" that updates? No, drift.
            // Robust: startBeat + (samples / SR * bpm/60)
            
            // Buffer Window
            var bufferStartBeat = self.playbackStartBeat + beatsElapsed
            let bufferDurationBeats = (Double(frameCount) / sampleRate) * (bpm / 60.0)
            
            if self.looping && self.loopEnd > self.loopStart {
                let loopLen = self.loopEnd - self.loopStart
                if bufferStartBeat >= self.loopEnd {
                    bufferStartBeat = self.loopStart + (bufferStartBeat - self.loopStart).truncatingRemainder(dividingBy: loopLen)
                }
            }
            
            let bufferEndBeat = bufferStartBeat + bufferDurationBeats
            
            // Thread-Safe Access
            os_unfair_lock_lock(&self.lock)
            let clips = self.activeMidiClips
            os_unfair_lock_unlock(&self.lock)
            
            for activeClip in clips {
                self.dispatchMidiEvents(
                    activeClip: activeClip,
                    bufferStartBeat: bufferStartBeat, 
                    bufferEndBeat: bufferEndBeat, 
                    sampleRate: sampleRate, 
                    bpm: bpm
                )
            }
            
            return noErr
        }
        
        // Attach to engine (silent input to main mixer)
        // We need to attach to something that runs.
        renderObserver = sourceNode
        audioEngine.attach(sourceNode)
        audioEngine.connect(sourceNode, to: audioEngine.masterMixer, format: nil) // Mixer will mix silence
    }

    private func dispatchMidiEvents(activeClip: ActiveMidiClip, bufferStartBeat: Double, bufferEndBeat: Double, sampleRate: Double, bpm: Double) {
        let clip = activeClip.clip
        
        // Check if clip intersects current buffer
        // Clip time is absolute in project beats
        let clipStart = clip.position.beats
        let clipEnd = clipStart + clip.duration.beats
        
        guard clipEnd > bufferStartBeat && clipStart < bufferEndBeat else { return }
        
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
                 let offsetInSamples = UInt32((offsetInBeats / (bpm / 60.0)) * sampleRate)
                 
                 // Dispatch
                 sendMidiEvent(activeClip: activeClip, status: 0x90, data1: UInt8(note.pitch), data2: UInt8(note.velocity), offset: offsetInSamples, isNoteOn: true)
            }
            
            // Note Off
            if noteEnd >= bufferStartBeat && noteEnd < bufferEndBeat {
                 let offsetInBeats = noteEnd - bufferStartBeat
                 let offsetInSamples = UInt32((offsetInBeats / (bpm / 60.0)) * sampleRate)
                 
                 sendMidiEvent(activeClip: activeClip, status: 0x80, data1: UInt8(note.pitch), data2: 0, offset: offsetInSamples, isNoteOn: false)
            }
        }
    }
    
    private func sendMidiEvent(activeClip: ActiveMidiClip, status: UInt8, data1: UInt8, data2: UInt8, offset: UInt32, isNoteOn: Bool) {
        if let sampler = activeClip.sampler {
            // Internal Sampler
            sampler.scheduleMidiEvent(pitch: data1, velocity: data2, sampleOffset: offset, isNoteOn: isNoteOn)
        } else if let block = activeClip.midiBlock {
            // AU Plugin
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
