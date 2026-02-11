import AVFoundation
import Foundation
import DreamDAWModels
import os.log

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
public final class TransportController: ObservableObject {

    // MARK: - Properties

    private let logger = Logger(subsystem: "com.dreamdaw", category: "Transport")
    private var displayLink: CVDisplayLink?
    private var playbackStartTime: CFAbsoluteTime = 0
    private var playbackStartBeat: Double = 0

    @Published public private(set) var state: TransportState = .stopped
    @Published public var playheadPosition: TimePosition = .zero
    @Published public var bpm: Double = 120.0
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

    // MARK: - Initialization

    public init() {}

    deinit {
        stopDisplayLink()
    }

    // MARK: - Transport Controls

    /// Start or resume playback.
    public func play() {
        switch state {
        case .stopped:
            playbackStartBeat = playheadPosition.beats
            playbackStartTime = CFAbsoluteTimeGetCurrent()
            state = .playing
            startDisplayLink()
            logger.info("Transport: PLAY from beat \(self.playheadPosition.beats)")

        case .paused:
            playbackStartBeat = playheadPosition.beats
            playbackStartTime = CFAbsoluteTimeGetCurrent()
            state = .playing
            startDisplayLink()
            logger.info("Transport: RESUME from beat \(self.playheadPosition.beats)")

        case .playing:
            break
        }
        onStateChange?(state)
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
        // Do not reset playheadPosition to .zero — let it stay where it stopped.
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
        playheadPosition = position

        if wasPlaying {
            playbackStartBeat = position.beats
            playbackStartTime = CFAbsoluteTimeGetCurrent()
            // Re-trigger playback scheduling from the new position
            onStateChange?(.playing)
        }

        onPlayheadUpdate?(playheadPosition)
        logger.info("Transport: SEEK to beat \(position.beats)\(wasPlaying ? " (re-scheduled)" : "")")
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
            controller.updatePlayhead()
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

    private func updatePlayhead() {
        let now = CFAbsoluteTimeGetCurrent()
        let elapsed = now - playbackStartTime
        let beatsElapsed = elapsed * (bpm / 60.0)
        var currentBeat = playbackStartBeat + beatsElapsed
        var didLoopWrap = false

        // Handle looping
        if isLooping && loopEnd.beats > loopStart.beats {
            if currentBeat >= loopEnd.beats {
                // Wrap to loop start
                let loopLength = loopEnd.beats - loopStart.beats
                let overshoot = currentBeat - loopStart.beats
                currentBeat = loopStart.beats + overshoot.truncatingRemainder(dividingBy: loopLength)
                playbackStartBeat = currentBeat
                playbackStartTime = now
                didLoopWrap = true
            }
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.playheadPosition = TimePosition(beats: currentBeat)
            self.onPlayheadUpdate?(self.playheadPosition)

            // Re-schedule audio after loop wrap (must happen on main thread)
            if didLoopWrap {
                self.onLoopWrap?()
            }
        }
    }
}
