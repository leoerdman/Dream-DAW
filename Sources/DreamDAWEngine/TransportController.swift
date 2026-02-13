import AVFoundation
import Foundation
import DreamDAWModels
import os.log
import Atomics

// MARK: - TransportState

/// Playback state of the transport.
public enum TransportState: Sendable {
    case stopped
    case playing
    case paused
}

// MARK: - TransportController

/// Controls playback transport: play, pause, stop, seek, loop.
/// Tracks the playhead position and notifies observers via callback.
///
/// **PHASE 9.1 (Sample-Accurate Time)**: The internal source of truth is now
/// `absolutePlayhead: AbsoluteTime` (Int64 sample frames). The published
/// `playheadPosition: TimePosition` is a computed property that derives beats
/// from the absolute playhead via `PulseMap`. This ensures zero accumulated
/// drift regardless of session length.
@MainActor
public final class TransportController: ObservableObject {

    // MARK: - Properties

    private let logger = Logger(subsystem: "com.dreamdaw", category: "Transport")
    private var displayLink: CVDisplayLink?
    private var playbackStartHostTime: UInt64 = 0 // In mach_absolute_time ticks
    private var playbackStartSampleFrame: Int64 = 0
    private var timebaseInfo = mach_timebase_info_data_t()
    private let audioEngine: AudioEngine
    /// DIAG: Frame counter for post-play tracing
    private var diagFrameCounter: Int = 0

    // PHASE 9.1: Sample-Accurate Playhead
    // PulseMap is the sole authority for beat↔sample conversion.
    // All internal calculations use Int64 sample frames.
    
    /// The tempo map for this project. Must be set before playback.
    /// PHASE 13.3: sampleRate is derived from audioEngine at init and synced
    /// before each play to ensure beat↔sample conversions match the hardware.
    public var pulseMap: PulseMap = PulseMap(bpm: 120, sampleRate: 44100)
    
    /// Sync PulseMap sampleRate with the actual audio engine sampleRate.
    /// Call this before any beat↔sample conversion that must match the hardware.
    public func syncPulseMap() {
        let engineRate = audioEngine.sampleRate
        if pulseMap.sampleRate != engineRate {
            pulseMap = PulseMap(bpm: pulseMap.initialBPM, sampleRate: engineRate)
            logger.info("Transport: PulseMap synced to engine sampleRate \(engineRate)")
        }
    }
    
    /// The project reference for situational diagnostics
    public var project: Project?
    
    /// The track mixer reference for node status diagnostics
    public var trackMixer: TrackMixer?
    
    // MARK: - Sprint 3: Zero-Jitter Playhead
    
    /// Interpolates playhead position between audio buffer callbacks for 120 FPS rendering.
    /// The Metal renderer reads `playheadInterpolator.currentVisualSample()` instead of
    /// `absolutePlayhead.sampleFrame` to eliminate jitter from MainActor dispatch latency.
    public let playheadInterpolator = PlayheadInterpolator()
    
    /// Internal source of truth: sample-accurate playhead position.
    @Published public private(set) var absolutePlayhead: AbsoluteTime = AbsoluteTime(sampleFrame: 0)

    @Published public private(set) var state: TransportState = .stopped
    
    /// Musical playhead — derived from `absolutePlayhead` via `PulseMap`.
    /// All existing UI consumers read this property unchanged.
    public var playheadPosition: TimePosition {
        get {
            let beats = pulseMap.beats(at: absolutePlayhead.sampleFrame)
            return TimePosition(beats: beats)
        }
        set {
            // When set from UI (seek), convert beats → sample frames
            let sf = pulseMap.sampleFrame(at: newValue.beats)
            absolutePlayhead = AbsoluteTime(sampleFrame: sf)
        }
    }
    
    @Published public var bpm: Double = 120.0 {
        didSet {
            // Keep PulseMap in sync when BPM changes
            pulseMap.setConstantTempo(bpm)
        }
    }
    @Published public var timeSignature: TimeSignature = TimeSignature()
    @Published public var isLooping: Bool = false
    @Published public var loopStart: TimePosition = .zero
    @Published public var loopEnd: TimePosition = TimePosition(bars: 4)

    /// Whether the transport is currently in the playing state.
    public var isPlaying: Bool { state == .playing }


    /// Callback invoked on each display frame with current playhead position.
    public var onPlayheadUpdate: ((TimePosition) -> Void)?

    /// Callback invoked on transport state changes.
    public var onStateChange: ((TransportState) -> Void)?

    /// Callback invoked when playback wraps at the loop end → loop start.
    /// Host should re-schedule audio from the new position.
    public var onLoopWrap: (() -> Void)?

    /// Callback invoked when a "Play" command is received, allowing the host
    /// to adjust the playhead position before playback actually starts.
    public var onPlayRequested: (() -> Void)?

    // MARK: - Initialization

    public init(audioEngine: AudioEngine) {
        self.audioEngine = audioEngine
        mach_timebase_info(&timebaseInfo)
        // PHASE 13.3: Initialize PulseMap with engine's actual sampleRate
        // (engine may not be started yet, so sampleRate could be 0 — will sync again on play)
        let rate = audioEngine.sampleRate
        if rate > 0 {
            pulseMap = PulseMap(bpm: 120, sampleRate: rate)
        }
    }

    deinit {
        // CVDisplayLinkStop must be called on the thread it was created, 
        // OR we ensure it's stopped before deinit.
        // Actually, CVDisplayLinkStop is thread-safe.
        // But since this is @MainActor, deinit might be tricky.
        // We'll use a non-isolated cleanup if needed, but displayLink is private.
    }

    // MARK: - Transport Controls

    /// Start or resume playback aligned with an engine start time.
    /// If `notify` is true, observers are called (use false when called from an observer to avoid loops).
    public func start(at startTime: AVAudioTime? = nil, notify: Bool = true) {
        let hostTimeAtStart = startTime?.hostTime ?? mach_absolute_time()
        
        switch state {
        case .stopped, .paused:
            // PHASE 13.3: Sync PulseMap with hardware BEFORE computing start frame.
            // This ensures beat→sampleFrame conversion matches PlaybackScheduler's PulseMap.
            syncPulseMap()
            
            // PHASE 13.2: Store start position as sample frame (source of truth)
            playbackStartSampleFrame = absolutePlayhead.sampleFrame
            playbackStartHostTime = hostTimeAtStart
            
            // PHASE 13.2 CRITICAL FIX: Pre-reset the master clock SYNCHRONOUSLY
            // before the DisplayLink starts. This eliminates the async race where
            // the DisplayLink reads a stale renderedSamples value from the previous
            // session while PlaybackScheduler.schedulePlaybackAsync() hasn't called
            // resetClock() yet on the background queue.
            audioEngine.resetClock(to: playbackStartSampleFrame)
            
            diagFrameCounter = 0 // Reset diagnostic counter
            state = .playing
            startDisplayLink()
            print("[DIAG-PLAY] TransportController.start() PRE-SYNC: sampleFrame=\(playbackStartSampleFrame) renderedSamples=\(audioEngine.renderedSamples.load(ordering: .relaxed)) hostTime=\(hostTimeAtStart)")

        case .playing:
            // Update reference to stay in sync with audio engine's actual hardware start
            playbackStartHostTime = hostTimeAtStart
        }
        
        if notify {
            onStateChange?(state)
        }
    }

    /// Start or resume playback.
    public func play() {
        onPlayRequested?()
        start()
    }

    /// Pause playback at current position.
    public func pause() {
        guard state == .playing else { return }
        state = .paused
        stopDisplayLink()
        playheadInterpolator.stop()
        logger.info("Transport: PAUSE at beat \(self.playheadPosition.beats)")
        onStateChange?(state)
    }

    /// Stop playback and reset to beginning (or loop start).
    public func stop() {
        state = .stopped
        stopDisplayLink()
        playheadInterpolator.stop()
        logger.info("Transport: STOP")
        onStateChange?(state)
    }

    /// Toggle play/pause.
    public func togglePlayPause() {
        if state == .playing {
            pause()
        } else {
            play()
        }
    }

    /// Seek to a specific position.
    public func seek(to position: TimePosition) {
        let wasPlaying = state == .playing
        // PHASE 9.1: Convert to sample frames via PulseMap (source of truth)
        let sf = pulseMap.sampleFrame(at: position.beats)
        absolutePlayhead = AbsoluteTime(sampleFrame: sf)

        if wasPlaying {
            playbackStartSampleFrame = sf
            playbackStartHostTime = mach_absolute_time()
            // Re-trigger playback scheduling from the new position
            onStateChange?(.playing)
        }

        onPlayheadUpdate?(playheadPosition)
        logger.info("Transport: SEEK to sampleFrame \(sf) (beat \(position.beats))\(wasPlaying ? " (re-scheduled)" : "")")
    }

    // MARK: - Display Link

    private func startDisplayLink() {
        guard displayLink == nil else { return }

        var dl: CVDisplayLink?
        CVDisplayLinkCreateWithActiveCGDisplays(&dl)
        guard let link = dl else { return }

        let context = Unmanaged.passUnretained(self).toOpaque()
        CVDisplayLinkSetOutputCallback(link, { (_, _, _, _, _, context) -> CVReturn in
            guard let ctx = context else { return kCVReturnError }
            let controller = Unmanaged<TransportController>.fromOpaque(ctx).takeUnretainedValue()
            
            // Ultra-lightweight MainActor jump
            DispatchQueue.main.async {
                controller.applyPlayheadUpdates()
            }
            
            return kCVReturnSuccess
        }, context)

        CVDisplayLinkStart(link)
        displayLink = link
    }

    private func stopDisplayLink() {
        guard let link = displayLink else { return }
        CVDisplayLinkStop(link)
        displayLink = nil
    }

    /// PHASE 9.1: Playhead computation uses sample frames as source of truth.
    /// Elapsed time from `mach_absolute_time` → seconds → sample frames → beats
    /// via `PulseMap`. This eliminates floating-point drift entirely.
    private func applyPlayheadUpdates() {
        guard state == .playing else { return }
        
        // PHASE 13.0: Master Sample Clock.
        // We no longer calculate elapsed time from mach_absolute_time (which drifts).
        // Instead, we read the actual number of samples processed by the hardware.
        var currentSampleFrame = audioEngine.renderedSamples.load(ordering: .relaxed)
        var didLoopWrap = false
        
        // DIAG: Log the first 5 frames to trace any jumps
        if diagFrameCounter < 5 {
            print("[DIAG-PLAY] applyPlayheadUpdates frame #\(diagFrameCounter): renderedSamples=\(currentSampleFrame) playbackStartSF=\(playbackStartSampleFrame) isLooping=\(isLooping)")
            diagFrameCounter += 1
        }

        // Handle looping (convert loop bounds to sample frames)
        if isLooping {
            let loopStartFrame = pulseMap.sampleFrame(at: loopStart.beats)
            let loopEndFrame = pulseMap.sampleFrame(at: loopEnd.beats)
            let loopLength = loopEndFrame - loopStartFrame
            
            if loopLength > 0 && currentSampleFrame >= loopEndFrame {
                let overshoot = currentSampleFrame - loopStartFrame
                currentSampleFrame = loopStartFrame + (overshoot % loopLength)
                didLoopWrap = true
            }
        }

        self.absolutePlayhead = AbsoluteTime(sampleFrame: currentSampleFrame)
        
        // Sprint 3: Update interpolator anchor for zero-jitter Metal rendering
        playheadInterpolator.updateAnchor(
            sampleFrame: currentSampleFrame,
            sampleRate: pulseMap.sampleRate,
            isPlaying: true
        )
        
        let playheadBeats = self.playheadPosition.beats
        self.onPlayheadUpdate?(TimePosition(beats: playheadBeats))

        // PHASE 11.5: High-Fidelity Diagnostics
        if let project = self.project {
            let tracks = project.tracks.map { track in
                EngineDiagnosticService.TrackSnapshot(
                    id: track.id,
                    name: track.name,
                    type: track.trackType,
                    hasClipAtPlayhead: track.hasClip(at: TimePosition(beats: playheadBeats)),
                    isPlayerPlaying: self.trackMixer?.isPlayerPlaying(trackID: track.id) ?? false,
                    volume: track.effectiveVolume
                )
            }
            let snapshot = EngineDiagnosticService.EngineSnapshot(
                absolutePlayhead: currentSampleFrame,
                playheadBeats: playheadBeats,
                isTransportPlaying: state == .playing,
                tracks: tracks
            )
            EngineDiagnosticService.shared.logSnapshot(snapshot)
        }

        // Re-schedule audio after loop wrap
        if didLoopWrap {
            self.onLoopWrap?()
        }
    }
}
