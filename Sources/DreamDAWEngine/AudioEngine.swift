import AVFoundation
import Foundation
import os.log
import Atomics
import DreamDAWModels

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

    /// PHASE 13.0: Master Sample Clock.
    /// Thread-safe counter of total samples processed by the hardware.
    /// Used by TransportController for sample-accurate playhead updates.
    public let renderedSamples = ManagedAtomic<Int64>(0)

    /// Master output mixer node.
    public let masterMixer: AVAudioMixerNode

    /// Test tone generator node.
    private var testToneNode: AVAudioSourceNode?
    private var testTonePhase: Float = 0
    
    /// CPU Usage Simulator thread.
    private var cpuLoadThread: Thread?
    private var isCpuLoadThreadRunning = false
    

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

    /// Callback triggered when the engine configuration changes (e.g. headphone plug/unplug).
    public var onConfigurationChange: (() -> Void)?

    // MARK: - Initialization

    public init() {
        self.masterMixer = AVAudioMixerNode()
        setupGraph()
        setupObservers()
        setupTestTone()
        logger.info("AudioEngine initialized")
    }


    private func setupTestTone() {
        testToneNode = AVAudioSourceNode { [weak self] (_, _, frameCount, audioBufferList) -> OSStatus in
            guard let self = self, AppSettings.shared.testToneEnabled else { return noErr }
            
            let ablPointer = UnsafeMutableAudioBufferListPointer(audioBufferList)
            let phaseStep = Float(AppSettings.shared.testToneFrequency) / Float(self.sampleRate) * .pi * 2.0
            let amplitude = pow(10.0, Float(AppSettings.shared.testToneVolume) / 20.0)
            
            for frame in 0..<Int(frameCount) {
                let val = sin(self.testTonePhase) * amplitude
                self.testTonePhase += phaseStep
                if self.testTonePhase > .pi * 2.0 {
                    self.testTonePhase -= .pi * 2.0
                }
                
                for buffer in ablPointer {
                    if let ptr = buffer.mData?.assumingMemoryBound(to: Float.self) {
                        ptr[frame] = val
                    }
                }
            }
            return noErr
        }
        
        if let node = testToneNode {
            engine.attach(node)
            // Connect to master mixer
            engine.connect(node, to: masterMixer, format: nil)
        }
    }

    private func setupGraph() {
        engine.attach(masterMixer)
        let format = engine.mainMixerNode.outputFormat(forBus: 0)
        engine.connect(masterMixer, to: engine.mainMixerNode, format: format)
        logger.info("Connected masterMixer to mainMixerNode with format: \(format.sampleRate)Hz")
    }

    private func setupObservers() {
        NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: .main
        ) { [weak self] _ in
            self?.handleConfigurationChange()
        }
    }

    private func handleConfigurationChange() {
        logger.info("AVAudioEngine configuration changed. Rebuilding graph...")
        // If the engine was running, it will stop automatically.
        // We notify the controller to re-configure tracks and restart if needed.
        onConfigurationChange?()
    }

    // MARK: - Lifecycle

    /// Start the audio engine.
    public func start() throws {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }

        guard !isRunning else { 
            logger.info("AudioEngine: start() called but already running.")
            return 
        }

        logger.info("AudioEngine: Preparing to start...")
        
        // Safety: Ensure masterMixer is connected to mainMixerNode.
        // Even if connected in init, some state changes can break the connection.
        let format = engine.mainMixerNode.outputFormat(forBus: 0)
        engine.connect(masterMixer, to: engine.mainMixerNode, format: format)
        
        // PHASE 10.0: Apply user's preferred buffer size and sample rate to output hardware
        let preferredBuffer = AppSettings.shared.audioBufferSize
        let preferredRate = AppSettings.shared.audioSampleRate
        
        if let outputDeviceUID = AppSettings.shared.audioOutputDeviceUID {
            AudioDeviceEnumerator.setSampleRateForDevice(uid: outputDeviceUID, rate: preferredRate)
            AudioDeviceEnumerator.setBufferSizeForDevice(uid: outputDeviceUID, size: UInt32(preferredBuffer))
            
            // Safety: Give Core Audio a moment to settle after hardware changes
            // This prevents "clapping/clicking" during engine start
            Thread.sleep(forTimeInterval: 0.1)
        }
        
        engine.prepare()
        
        do {
            try engine.start()
            isRunning = true
            startCpuSimulator()
            logger.info("AudioEngine: STARTED successfully — sample rate: \(self.sampleRate) Hz")
        } catch {
            logger.error("AudioEngine: FAILED to start: \(error.localizedDescription)")
            throw error
        }
    }

    /// Stop the audio engine.
    public func stop() {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }

        guard isRunning else { return }

        engine.stop()
        isRunning = false
        stopCpuSimulator()
        logger.info("AudioEngine stopped")
    }

    /// Emergency stop for all audio processing.
    public func panic() {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }

        engine.stop()
        engine.reset()
        isRunning = false
        logger.warning("Panic! Audio engine halted and reset.")
    }

    /// Reset the audio engine graph.
    public func reset() {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }

        engine.reset()
        logger.info("AudioEngine: [ENGINE] RESET (All paths cleared)")
    }

    /// PHASE 13.1 Reset Sequence: Safely reset the master clock.
    /// Uses sequentially consistent ordering to ensure all threads see the reset.
    public func resetClock(to frame: Int64 = 0) {
        renderedSamples.store(frame, ordering: .sequentiallyConsistent)
        logger.info("AudioEngine: Master clock reset to \(frame)")
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

    // MARK: - Performance Simulation

    private func startCpuSimulator() {
        guard !isCpuLoadThreadRunning else { return }
        isCpuLoadThreadRunning = true
        
        cpuLoadThread = Thread { [weak self] in
            while let self = self, self.isCpuLoadThreadRunning {
                let load = AppSettings.shared.cpuUsageSimulator // 0-100
                if load > 0 {
                    let totalMs: Double = 10.0
                    let loadMs = totalMs * (Double(load) / 100.0)
                    let idleMs = totalMs - loadMs
                    
                    let startTime = CACurrentMediaTime()
                    while (CACurrentMediaTime() - startTime) < (loadMs / 1000.0) {
                        // Busy wait to simulate CPU load
                        _ = sqrt(Double.random(in: 0...1000000))
                    }
                    
                    if idleMs > 0 {
                        Thread.sleep(forTimeInterval: idleMs / 1000.0)
                    }
                } else {
                    Thread.sleep(forTimeInterval: 0.1)
                }
            }
        }
        cpuLoadThread?.name = "com.dreamdaw.cpu-simulator"
        cpuLoadThread?.qualityOfService = .userInitiated
        cpuLoadThread?.start()
    }

    private func stopCpuSimulator() {
        isCpuLoadThreadRunning = false
        cpuLoadThread = nil
    }

    /// Access the underlying AVAudioEngine (use with caution).
    public var avAudioEngine: AVAudioEngine {
        engine
    }
}
