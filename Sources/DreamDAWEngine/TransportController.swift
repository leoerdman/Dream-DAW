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

    // PHASE 9.1: Sample-Accurate Playhead
    // PulseMap is the sole authority for beat↔sample conversion.
    // All internal calculations use Int64 sample frames.
    
    /// The tempo map for this project. Must be set before playback.
    public var pulseMap: PulseMap = PulseMap(bpm: 120, sampleRate: 44100)
    
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

    public init() {
        mach_timebase_info(&timebaseInfo)
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
            // PHASE 9.1: Store start position as sample frame (source of truth)
            playbackStartSampleFrame = absolutePlayhead.sampleFrame
            playbackStartHostTime = hostTimeAtStart
            state = .playing
            startDisplayLink()
            logger.info("Transport: START at hostTime \(hostTimeAtStart), sampleFrame \(self.absolutePlayhead.sampleFrame)")

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
        logger.info("Transport: PAUSE at beat \(self.playheadPosition.beats)")
        onStateChange?(state)
    }

    /// Stop playback and reset to beginning (or loop start).
    public func stop() {
        state = .stopped
        stopDisplayLink()
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
        
        let now = mach_absolute_time()
        
        // If now is before start time, a fresh start is pending
        if now < playbackStartHostTime {
            // Stay at the seeked position until hardware starts
            self.onPlayheadUpdate?(self.playheadPosition)
            return
        }

        // Calculate elapsed seconds using high-precision mach_absolute_time
        let elapsedTicks = now - playbackStartHostTime
        let elapsedNano = (elapsedTicks * UInt64(timebaseInfo.numer)) / UInt64(timebaseInfo.denom)
        let elapsedSeconds = Double(elapsedNano) / 1_000_000_000.0
        
        // PHASE 9.1: Convert elapsed seconds → sample frames (integer, no drift)
        let elapsedSamples = Int64(elapsedSeconds * pulseMap.sampleRate)
        var currentSampleFrame = playbackStartSampleFrame + elapsedSamples
        var didLoopWrap = false

        // Handle looping (convert loop bounds to sample frames)
        if isLooping {
            let loopStartFrame = pulseMap.sampleFrame(at: loopStart.beats)
            let loopEndFrame = pulseMap.sampleFrame(at: loopEnd.beats)
            let loopLength = loopEndFrame - loopStartFrame
            
            if loopLength > 0 && currentSampleFrame >= loopEndFrame {
                let overshoot = currentSampleFrame - loopStartFrame
                currentSampleFrame = loopStartFrame + (overshoot % loopLength)
                
                // Perfect loop wrap sync
                playbackStartSampleFrame = currentSampleFrame
                playbackStartHostTime = now
                didLoopWrap = true
            }
        }

        self.absolutePlayhead = AbsoluteTime(sampleFrame: currentSampleFrame)
        self.onPlayheadUpdate?(self.playheadPosition)

        // Re-schedule audio after loop wrap
        if didLoopWrap {
            self.onLoopWrap?()
        }
    }
}
