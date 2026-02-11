import AVFoundation
import Foundation
import os.log

// MARK: - AudioEngine

/// Core audio engine wrapper around AVAudioEngine.
/// Manages the audio graph lifecycle, master output, and provides
/// thread-safe access to engine state.
public final class AudioEngine: @unchecked Sendable {

    // MARK: - Properties

    private let engine = AVAudioEngine()
    /// os_unfair_lock — fast, non-recursive lock for lifecycle operations.
    private var lock = os_unfair_lock_s()
    private let logger = Logger(subsystem: "com.dreamdaw", category: "AudioEngine")

    /// Master output mixer node.
    public let masterMixer: AVAudioMixerNode

    /// The engine's output audio format.
    public var outputFormat: AVAudioFormat {
        engine.outputNode.outputFormat(forBus: 0)
    }

    /// Current sample rate.
    public var sampleRate: Double {
        outputFormat.sampleRate
    }

    /// Whether the engine is currently running.
    public private(set) var isRunning: Bool = false

    // MARK: - Initialization

    public init() {
        self.masterMixer = AVAudioMixerNode()
        engine.attach(masterMixer)
        engine.connect(masterMixer, to: engine.mainMixerNode, format: nil)
        logger.info("AudioEngine initialized")
    }

    // MARK: - Lifecycle

    /// Start the audio engine.
    public func start() throws {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }

        guard !isRunning else { return }

        engine.prepare()
        try engine.start()
        isRunning = true
        logger.info("AudioEngine started — sample rate: \(self.sampleRate) Hz")
    }

    /// Stop the audio engine.
    public func stop() {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }

        guard isRunning else { return }

        engine.stop()
        isRunning = false
        logger.info("AudioEngine stopped")
    }

    /// Reset the audio engine graph.
    public func reset() {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }

        engine.reset()
        logger.info("AudioEngine reset")
    }

    // MARK: - Node Management

    /// Attach a node to the engine graph.
    public func attach(_ node: AVAudioNode) {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        engine.attach(node)
    }

    /// Detach a node from the engine graph.
    public func detach(_ node: AVAudioNode) {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        engine.detach(node)
    }

    /// Connect two nodes in the audio graph.
    public func connect(_ sourceNode: AVAudioNode, to destNode: AVAudioNode, format: AVAudioFormat?) {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        engine.connect(sourceNode, to: destNode, format: format)
    }

    /// Disconnect a node's outputs.
    public func disconnectNodeOutput(_ node: AVAudioNode) {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        engine.disconnectNodeOutput(node)
    }

    /// Access the underlying AVAudioEngine (use with caution).
    public var avAudioEngine: AVAudioEngine {
        engine
    }
}
