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
    private let audioLevelMeter: AudioLevelMeter
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
    private var trackSynths: [UUID: SimpleSynthInstrument] = [:]
    
    /// Map from Track ID to its sampler instance.
    private var trackSamplers: [UUID: SamplerInstrument] = [:]
    
    /// Map from Track ID to its instrument source node (attached to engine).
    private var trackInstrumentNodes: [UUID: AVAudioNode] = [:]

    // MARK: - Initialization

    public init(audioEngine: AudioEngine, audioLevelMeter: AudioLevelMeter) {
        self.audioEngine = audioEngine
        self.audioLevelMeter = audioLevelMeter
    }

    // MARK: - Track Setup

    /// Set up mixer, player, and initial effect nodes for a set of tracks.
    public func configureTracks(_ tracks: [Track], masterTrack: Track? = nil) {
        let format = standardFormat
        logger.info("Configuring tracks with format: \(format.sampleRate)Hz, \(format.channelCount)ch")

        // 1. Cleanup tracks that no longer exist
        let allTracks = masterTrack != nil ? tracks + [masterTrack!] : tracks
        let currentIDs = Set(allTracks.map(\.id))
        
        for id in trackMixerNodes.keys where !currentIDs.contains(id) {
            removeTrackNodes(id: id)
        }

        // 2. Setup/Update all tracks (including Master and Groups)
        for track in allTracks {
            if trackMixerNodes[track.id] == nil {
                setupTrackNodes(track: track, format: format)
            }
            // Rebuild the chain to ensure correctly routed
            rebuildEffectChain(for: track, format: format, allTracks: allTracks)
        }
    }

    private func setupTrackNodes(track: Track, format: AVAudioFormat) {
        let inputMixer = AVAudioMixerNode()
        let outputMixer = AVAudioMixerNode()
        let player = AVAudioPlayerNode()

        audioEngine.attach(inputMixer)
        audioEngine.attach(outputMixer)
        audioEngine.attach(player)
        
        // Setup instrument if applicable (even for Master if user wants generators there)
        if track.trackType == .midi || track.instrument != nil {
            setupInstrumentNode(track: track, format: format)
            logger.info("TrackMixer: [SIGNAL] Setup instrument node for track \(track.name) (ID: \(track.id))")
        }
        
        trackInputMixers[track.id] = inputMixer
        trackMixerNodes[track.id] = outputMixer
        trackPlayerNodes[track.id] = player
        
        logger.info("TrackMixer: [SIGNAL] Created node set for track \(track.name)")
    }
    
    private func setupInstrumentNode(track: Track, format: AVAudioFormat) {
        let instrType = track.instrument?.instrumentType ?? .sineSynth
        let sourceNode: AVAudioNode
        
        switch instrType {
        case .sineSynth:
            let synth = SimpleSynthInstrument(sampleRate: format.sampleRate)
            sourceNode = synth.createSourceNode()
            trackSynths[track.id] = synth
        case .sampler:
            let sampler = SamplerInstrument()
            sourceNode = sampler.createSourceNode()
            trackSamplers[track.id] = sampler
        case .vst2, .vst3:
            // Use PluginHost for enterprise-grade VST/AU loading
            if let identifier = track.instrument?.pluginIdentifier {
                PluginHost.shared.instantiate(identifier: identifier, type: instrType) { [weak self] unit, error in
                    DispatchQueue.main.async {
                        guard let self = self, let unit = unit else {
                            self?.logger.error("TrackMixer: Failed to load VST \(identifier)")
                            return
                        }
                        
                        self.audioEngine.attach(unit)
                        self.trackInstrumentNodes[track.id] = unit
                        PluginHost.shared.registerInstance(track.id, unit: unit)
                        
                        // Trigger a chain rebuild to include the new plugin (main thread safe)
                        self.rebuildEffectChain(for: track)
                    }
                }
                // Return placeholder during async load to prevent silent track
                let synth = SimpleSynthInstrument(sampleRate: format.sampleRate)
                sourceNode = synth.createSourceNode()
            } else {
                let synth = SimpleSynthInstrument(sampleRate: format.sampleRate)
                sourceNode = synth.createSourceNode()
            }
        @unknown default:
            let synth = SimpleSynthInstrument(sampleRate: format.sampleRate)
            sourceNode = synth.createSourceNode()
        }
        
        audioEngine.attach(sourceNode)
        trackInstrumentNodes[track.id] = sourceNode
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
            audioLevelMeter.removeTap(trackID: id, point: .preEffects)
            audioEngine.detach(inputMixer)
        }

        if let mixer = trackMixerNodes.removeValue(forKey: id) {
            audioEngine.disconnectNodeOutput(mixer)
            audioLevelMeter.removeTap(trackID: id, point: .postEffects)
            audioEngine.detach(mixer)
        }
    }

    public func rebuildEffectChain(for track: Track, format: AVAudioFormat? = nil, allTracks: [Track] = []) {
        guard let inputMixer = trackInputMixers[track.id],
              let outputMixer = trackMixerNodes[track.id],
              let player = trackPlayerNodes[track.id] else { return }
        
        let fmt = format ?? standardFormat
        
        // 1. Disconnect current components
        audioEngine.disconnectNodeOutput(player)
        audioEngine.disconnectNodeOutput(inputMixer)
        audioEngine.disconnectNodeOutput(outputMixer)
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
            if effectConfig.effectType == .vst2 || effectConfig.effectType == .vst3 {
                if let identifier = effectConfig.pluginIdentifier {
                    // Asynchronous load for VST effects
                    PluginHost.shared.instantiate(identifier: identifier, type: .vst2) { [weak self] unit, error in
                        DispatchQueue.main.async {
                            guard let self = self, let unit = unit else {
                                self?.logger.error("TrackMixer: Failed to load VST Effect \(identifier)")
                                return
                            }
                            self.audioEngine.attach(unit)
                            PluginHost.shared.registerInstance(effectConfig.id, unit: unit)
                            // Rebuild again to stitch this new node in
                            self.rebuildEffectChain(for: track)
                        }
                    }
                }
            } else if let node = createNode(for: effectConfig) {
                audioEngine.attach(node)
                newChain.append(node)
            }
            
            // Re-fetch any already loaded VST instances from PluginHost
            if (effectConfig.effectType == .vst2 || effectConfig.effectType == .vst3),
               let unit = PluginHost.shared.getInstance(effectConfig.id) {
                if unit.engine == nil { audioEngine.attach(unit) }
                newChain.append(unit)
            }
        }
        trackEffectChains[track.id] = newChain
        
        // 3. Stitch the internal track chain:
        // [Player (Bus 0) + Synth (Bus 1)] -> inputMixer -> [Effects] -> outputMixer
        
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
        
        // 4. ROUTING: Connect outputMixer to destination
        connectTrackOutput(track, outputMixer: outputMixer, format: fmt, allTracks: allTracks)
        
        // 5. Update settings
        applyTrackSettings(track)
        syncEffectParameters(for: track)
        
        // Sync instrument parameters
        if let config = track.instrument {
            syncInstrumentParameters(trackID: track.id, config: config)
        }
        
        logger.info("Rebuilt signal chain for '\(track.name)' -> \(track.outputDestinationID?.uuidString ?? "Master")")
    }

    private func connectTrackOutput(_ track: Track, outputMixer: AVAudioMixerNode, format: AVAudioFormat, allTracks: [Track]) {
        if track.trackType == .master {
            // Master always goes to the hardware mainMixerNode
            audioEngine.connect(outputMixer, to: audioEngine.avAudioEngine.mainMixerNode, format: format)
            logger.info("TrackMixer: [SIGNAL] \(track.name) -> HARDWARE OUTPUT")
            return
        }
        
        if let destID = track.outputDestinationID,
           !hasCircularRouting(startTrack: track.id, destTrack: destID, allTracks: allTracks),
           let destMixer = trackInputMixers[destID] {
            audioEngine.connect(outputMixer, to: destMixer, format: format)
            let destName = allTracks.first(where: { $0.id == destID })?.name ?? "Unknown"
            logger.info("TrackMixer: [SIGNAL] \(track.name) -> ROUTED TO \(destName)")
        } else {
            // Default to Master
            audioEngine.connect(outputMixer, to: audioEngine.masterMixer, format: format)
            logger.info("TrackMixer: [SIGNAL] \(track.name) -> ROUTED TO MASTER")
        }
    }

    private func hasCircularRouting(startTrack: UUID, destTrack: UUID, allTracks: [Track]) -> Bool {
        var current = destTrack
        var visited = Set<UUID>()
        visited.insert(startTrack)
        
        while true {
            if visited.contains(current) { return true }
            visited.insert(current)
            
            guard let track = allTracks.first(where: { $0.id == current }),
                  let nextDest = track.outputDestinationID else {
                break
            }
            current = nextDest
        }
        return false
    }

    private func syncInstrumentParameters(trackID: UUID, config: InstrumentConfig) {
        if let synth = trackSynths[trackID] {
            synth.amplitude = config.gain * 0.3
        } else if let sampler = trackSamplers[trackID] {
            sampler.gain = config.gain
            sampler.attack = config.attack
            sampler.decay = config.decay
            sampler.sustain = config.sustain
            sampler.release = config.release
            sampler.startPercent = config.startPercent
            sampler.endPercent = config.endPercent
            sampler.mode = config.samplerMode
            sampler.fadePercent = config.fadePercent
            sampler.filterCutoff = config.filterCutoff
            sampler.filterResonance = config.filterResonance
            
            if let sampleURL = config.sampleURL {
                try? sampler.loadSample(url: sampleURL)
            }
        }
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
        case .vst2, .vst3:
            // VST nodes are instantiated asynchronously in rebuildEffectChain
            return nil
        @unknown default:
            return AVAudioMixerNode()
        }
    }

    public func noteOn(trackID: UUID, pitch: Int, velocity: Int) {
        trackSynths[trackID]?.noteOn(pitch: pitch, velocity: velocity)
        trackSamplers[trackID]?.noteOn(pitch: pitch, velocity: velocity)
    }
    
    public func noteOff(trackID: UUID, pitch: Int) {
        trackSynths[trackID]?.noteOff(pitch: pitch)
        trackSamplers[trackID]?.noteOff(pitch: pitch)
    }

    public func getSynth(for trackID: UUID) -> SimpleSynthInstrument? {
        return trackSynths[trackID]
    }
    
    public func getSampler(for trackID: UUID) -> SamplerInstrument? {
        return trackSamplers[trackID]
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
        case .vst2, .vst3:
            // Placeholder: logic for syncing VST parameters
            break
        @unknown default:
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

    /// Apply volume, pan, and instrument settings to a track's signal chain.
    public func applyTrackSettings(_ track: Track) {
        guard let mixer = trackMixerNodes[track.id] else { return }

        mixer.outputVolume = track.effectiveVolume
        mixer.pan = track.pan

        // Sync instrument parameters in real-time
        if let config = track.instrument {
            if let sampler = trackSamplers[track.id] {
                sampler.gain = config.gain
                sampler.attack = config.attack
                sampler.decay = config.decay
                sampler.sustain = config.sustain
                sampler.release = config.release
                sampler.startPercent = config.startPercent
                sampler.endPercent = config.endPercent
                sampler.mode = config.samplerMode
                sampler.fadePercent = config.fadePercent
                sampler.filterEnabled = config.filterEnabled
                sampler.filterCutoff = config.filterCutoff
                sampler.filterResonance = config.filterResonance
                
                // Note: Sample URL loading is handled during clip render or explicit change
            } else if let synth = trackSynths[track.id] {
                synth.amplitude = config.gain * 0.3 // Scaled
            }
        }
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
        for (_, synth) in trackSynths {
            synth.allNotesOff()
        }
        for (_, sampler) in trackSamplers {
            sampler.allNotesOff()
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

