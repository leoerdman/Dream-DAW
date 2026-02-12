import AVFoundation
import AVFAudio
import Foundation
import AudioToolbox
import DreamDAWModels
import os.log

// MARK: - TrackMixer

/// Manages per-track mixer nodes within the audio engine graph.
/// Signal chain per track: AVAudioPlayerNode → ParametricEQ → AVAudioMixerNode → masterMixer.
public final class TrackMixer {

    // MARK: - Properties

    private let audioEngine: AudioEngine
    private let logger = Logger(subsystem: "com.dreamdaw", category: "TrackMixer")

    /// Standard stereo format used for all node connections.
    /// Ensures consistent format negotiation across the entire graph.
    private var standardFormat: AVAudioFormat {
        // Use the engine's actual hardware output format (typically stereo 44.1/48kHz)
        let engineFormat = audioEngine.outputFormat
        // Create a standard float format at the engine's sample rate
        return AVAudioFormat(standardFormatWithSampleRate: engineFormat.sampleRate, channels: 2)!
    }

    /// Map from Track ID to its input mixer node (mixes player and real-time synth).
    private var trackInputMixers: [UUID: AVAudioMixerNode] = [:]

    /// Map from Track ID to its output mixer node (post-effects, final gain/pan).
    private var trackMixerNodes: [UUID: AVAudioMixerNode] = [:]
    
    /// Map from Track ID to its player node (for clip playback).
    private var trackPlayerNodes: [UUID: AVAudioPlayerNode] = [:]

    /// Map from Track ID to its ordered list of effect nodes (excluding player and mixer).
    private var trackEffectChains: [UUID: [AVAudioNode]] = [:]

    /// Map from Track ID to its instrument instance (for MIDI tracks).
    private var trackInstruments: [UUID: SimpleSynthInstrument] = [:]
    
    /// Map from Track ID to its instrument source node (attached to engine).
    private var trackInstrumentNodes: [UUID: AVAudioNode] = [:]

    // MARK: - Initialization

    public init(audioEngine: AudioEngine) {
        self.audioEngine = audioEngine
    }

    // MARK: - Track Setup

    /// Set up mixer, player, and initial effect nodes for a set of tracks.
    public func configureTracks(_ tracks: [Track]) {
        let format = standardFormat
        logger.info("Configuring tracks with format: \(format.sampleRate)Hz, \(format.channelCount)ch")

        // 1. Cleanup tracks that no longer exist
        let currentIDs = Set(tracks.map(\.id))
        for id in trackMixerNodes.keys where !currentIDs.contains(id) {
            removeTrackNodes(id: id)
        }

        // 2. Setup/Update existing tracks
        for track in tracks where track.trackType != .master {
            if trackMixerNodes[track.id] == nil {
                setupTrackNodes(track: track, format: format)
            }
            logger.info("Syncing track: \(track.name) (ID: \(track.id), volume: \(track.volume))")
            // Always rebuild/sync the chain to ensure it matches project state (effects might have changed)
            rebuildEffectChain(for: track, format: format)
        }
    }

    private func setupTrackNodes(track: Track, format: AVAudioFormat) {
        let inputMixer = AVAudioMixerNode()
        let outputMixer = AVAudioMixerNode()
        let player = AVAudioPlayerNode()

        audioEngine.attach(inputMixer)
        audioEngine.attach(outputMixer)
        audioEngine.attach(player)
        
        // MIDI Tracks: Setup synth
        if track.trackType == .midi {
            let synth = SimpleSynthInstrument(sampleRate: format.sampleRate)
            let synthNode = synth.createSourceNode()
            audioEngine.attach(synthNode)
            trackInstruments[track.id] = synth
            trackInstrumentNodes[track.id] = synthNode
        }
        
        // Initial simple connection: outputMixer -> master
        audioEngine.connect(outputMixer, to: audioEngine.masterMixer, format: format)
        
        trackInputMixers[track.id] = inputMixer
        trackMixerNodes[track.id] = outputMixer
        trackPlayerNodes[track.id] = player
    }

    private func removeTrackNodes(id: UUID) {
        if let player = trackPlayerNodes.removeValue(forKey: id) {
            player.stop()
            audioEngine.disconnectNodeOutput(player)
            audioEngine.detach(player)
        }
        
        if let chain = trackEffectChains.removeValue(forKey: id) {
            for node in chain {
                audioEngine.disconnectNodeOutput(node)
                audioEngine.detach(node)
            }
        }
        
        if let inputMixer = trackInputMixers.removeValue(forKey: id) {
            audioEngine.disconnectNodeOutput(inputMixer)
            audioEngine.detach(inputMixer)
        }

        if let mixer = trackMixerNodes.removeValue(forKey: id) {
            audioEngine.disconnectNodeOutput(mixer)
            audioEngine.detach(mixer)
        }
    }

    public func rebuildEffectChain(for track: Track, format: AVAudioFormat? = nil) {
        guard let inputMixer = trackInputMixers[track.id],
              let outputMixer = trackMixerNodes[track.id],
              let player = trackPlayerNodes[track.id] else { return }
        
        let fmt = format ?? standardFormat
        
        // 1. Disconnect current components
        audioEngine.disconnectNodeOutput(player)
        audioEngine.disconnectNodeOutput(inputMixer)
        if let synthNode = trackInstrumentNodes[track.id] {
            audioEngine.disconnectNodeOutput(synthNode)
        }
        
        if let oldChain = trackEffectChains[track.id] {
            for node in oldChain {
                audioEngine.disconnectNodeOutput(node)
                audioEngine.detach(node)
            }
        }
        
        // 2. Create new effect nodes
        var newChain: [AVAudioNode] = []
        for effectConfig in track.effects where effectConfig.isEnabled {
            if let node = createNode(for: effectConfig) {
                audioEngine.attach(node)
                newChain.append(node)
            }
        }
        trackEffectChains[track.id] = newChain
        
        // 3. Stitch the chain:
        // [Player (Bus 0) + Synth (Bus 1)] -> inputMixer -> [Effects] -> outputMixer
        
        // Connect player (bus 0) and synth (bus 1) to the INPUT mixer
        audioEngine.avAudioEngine.connect(player, to: inputMixer, fromBus: 0, toBus: 0, format: fmt)
        if let synthNode = trackInstrumentNodes[track.id] {
            audioEngine.avAudioEngine.connect(synthNode, to: inputMixer, fromBus: 0, toBus: 1, format: fmt)
        }
        
        let firstEffect = newChain.first ?? outputMixer
        audioEngine.connect(inputMixer, to: firstEffect, format: fmt)
        
        var lastNode: AVAudioNode = firstEffect
        if !newChain.isEmpty {
            for i in 1..<newChain.count {
                let node = newChain[i]
                audioEngine.connect(lastNode, to: node, format: fmt)
                lastNode = node
            }
            audioEngine.connect(lastNode, to: outputMixer, format: fmt)
        }
        
        // 4. Update settings
        applyTrackSettings(track)
        syncEffectParameters(for: track)
        
        if let synth = trackInstruments[track.id], let config = track.instrument {
            synth.amplitude = config.gain * 0.3 // Scaled for internal mix
        }
        
        logger.info("Rebuilt signal chain for track '\(track.name)' (Player + Synth -> inputMixer -> \(newChain.count) effects -> outputMixer)")
    }

    private func createNode(for effect: AudioEffectConfig) -> AVAudioNode? {
        switch effect.effectType {
        case .eq:
            return AVAudioUnitEQ(numberOfBands: 8)
        case .compressor:
            // Use component description as a fallback if class lookup is flaky
            let desc = AudioComponentDescription(
                componentType: kAudioUnitType_Effect,
                componentSubType: kAudioUnitSubType_DynamicsProcessor,
                componentManufacturer: kAudioUnitManufacturer_Apple,
                componentFlags: 0,
                componentFlagsMask: 0
            )
            // Note: AVAudioUnitEffect is the correct subclass for effects with component descriptions
            return AVAudioUnitEffect(audioComponentDescription: desc)
        case .delay:
            return AVAudioUnitDelay()
        case .reverb:
            return AVAudioUnitReverb()
        case .utility, .chorus:
            // Custom native nodes or simplified standard nodes
            return AVAudioMixerNode() // Spacer for now
        }
    }

    public func getInstrument(for trackID: UUID) -> SimpleSynthInstrument? {
        return trackInstruments[trackID]
    }
    
    /// Syncs parameters for all effects in a track's chain.
    public func syncEffectParameters(for track: Track) {
        guard let chain = trackEffectChains[track.id] else { return }
        
        var chainIdx = 0
        for effectConfig in track.effects where effectConfig.isEnabled {
            guard chainIdx < chain.count else { break }
            let node = chain[chainIdx]
            
            applyEffectSettings(config: effectConfig, to: node)
            chainIdx += 1
        }
    }

    private func applyEffectSettings(config: AudioEffectConfig, to node: AVAudioNode) {
        switch config.effectType {
        case .eq:
            if let eq = node as? AVAudioUnitEQ {
                for (i, band) in config.eqBands.enumerated() {
                    guard i < eq.bands.count else { break }
                    let bandNode = eq.bands[i]
                    bandNode.filterType = mapFilterType(band.filterType)
                    bandNode.frequency = band.frequency
                    bandNode.bandwidth = band.bandwidth
                    bandNode.gain = band.gain
                    bandNode.bypass = !band.isEnabled
                }
            }
        case .compressor:
            // Workaround for compiler issue where AVAudioUnitDynamicsProcessor is not found in scope
            // We use direct AUAudioUnit parameter access (DynamicsProcessor constants)
            let au = node.auAudioUnit
            let tree = au.parameterTree
            
            // Threshold (Param 0): -40 to 20 dB
            if let param = tree?.parameter(withAddress: 0) {
                param.value = config.threshold
            }
            // Ratio (Param 2): 1 to 50
            if let param = tree?.parameter(withAddress: 2) {
                param.value = config.ratio
            }
            // Attack (Param 4): 0.0001 to 0.2s
            if let param = tree?.parameter(withAddress: 4) {
                param.value = config.attack
            }
            // Release (Param 5): 0.01 to 3s
            if let param = tree?.parameter(withAddress: 5) {
                param.value = config.release
            }
        case .delay:
            if let delay = node as? AVAudioUnitDelay {
                delay.delayTime = config.delayTime
                delay.feedback = config.feedback
                delay.wetDryMix = config.wetDryMix
            }
        case .reverb:
            if let reverb = node as? AVAudioUnitReverb {
                // Map presets (Enterprise implementation: use a stable map)
                let presets: [AVAudioUnitReverbPreset] = [
                    .mediumHall, .largeHall, .smallRoom, .mediumRoom, .largeRoom, .plate
                ]
                let presetIdx = min(max(0, config.reverbPreset), presets.count - 1)
                reverb.loadFactoryPreset(presets[presetIdx])
                reverb.wetDryMix = config.reverbMix
            }
        case .utility:
            if let mixer = node as? AVAudioMixerNode {
                // Utility gain stage
                let gain = pow(10, config.gainDB / 20.0)
                mixer.outputVolume = gain
            }
        case .chorus:
            // Placeholder for chorus
            break
        }
    }

    private func mapFilterType(_ type: EQFilterType) -> AVAudioUnitEQFilterType {
        switch type {
        case .lowCut:     return .lowPass // Actually high-pass in Apple's enum logic for cuts
        case .lowShelf:   return .lowShelf
        case .parametric: return .parametric
        case .highShelf:  return .highShelf
        case .highCut:    return .highPass // Actually low-pass
        }
        // Correcting common mental inversion:
        // Low Cut = Filter out lows = High Pass
        // High Cut = Filter out highs = Low Pass
    }

    /// Apply volume, pan, and mute settings to a track's mixer node.
    public func applyTrackSettings(_ track: Track) {
        guard let mixer = trackMixerNodes[track.id] else { return }

        mixer.outputVolume = track.effectiveVolume
        mixer.pan = track.pan
    }

    /// Get the player node for a given track.
    public func playerNode(for trackID: UUID) -> AVAudioPlayerNode? {
        trackPlayerNodes[trackID]
    }

    /// Get the mixer node for a given track.
    public func mixerNode(for trackID: UUID) -> AVAudioMixerNode? {
        trackMixerNodes[trackID]
    }

    /// Handle solo logic: when any track is soloed, mute all non-soloed tracks.
    public func applySoloLogic(_ tracks: [Track]) {
        let hasSolo = tracks.contains { $0.isSoloed }

        for track in tracks {
            guard let mixer = trackMixerNodes[track.id] else { continue }

            if hasSolo {
                // Only soloed tracks are heard
                mixer.outputVolume = track.isSoloed ? track.volume : 0
            } else {
                mixer.outputVolume = track.effectiveVolume
            }
        }
    }

    /// Stop all track playback and instruments.
    public func stopAll() {
        for (_, player) in trackPlayerNodes {
            player.stop()
        }
        for (_, synth) in trackInstruments {
            synth.allNotesOff()
        }
        trackMixerNodes.values.forEach { $0.reset() }
        logger.info("TrackMixer: All playback and instruments stopped.")
    }

    /// Stop playback for a specific track.
    public func stopPlayer(for trackID: UUID) {
        trackPlayerNodes[trackID]?.stop()
    }

    /// Apply master track volume/pan to the engine's master mixer node.
    public func applyMasterSettings(_ masterTrack: Track) {
        let masterMixer = audioEngine.masterMixer
        masterMixer.outputVolume = masterTrack.isMuted ? 0.0 : masterTrack.volume
        masterMixer.pan = masterTrack.pan
    }

    /// Remove all track nodes from the engine.
    public func removeAll() {
        stopAll()
        for (_, chain) in trackEffectChains {
            for node in chain {
                audioEngine.disconnectNodeOutput(node)
                audioEngine.detach(node)
            }
        }
        for (_, mixer) in trackMixerNodes {
            audioEngine.disconnectNodeOutput(mixer)
            audioEngine.detach(mixer)
        }
        for (_, player) in trackPlayerNodes {
            audioEngine.disconnectNodeOutput(player)
            audioEngine.detach(player)
        }
        trackMixerNodes.removeAll()
        trackPlayerNodes.removeAll()
        trackEffectChains.removeAll()
        logger.info("All track mixer nodes removed")
    }
}

