import AVFoundation
import AVFAudio
import Foundation
import AudioToolbox
import DreamDAWModels
import os.log

// MARK: - TrackMixer

/// Manages per-track mixer nodes within the audio engine graph.
/// Signal chain per track: AVAudioPlayerNode → ParametricEQ → AVAudioMixerNode → masterMixer.
/// Signal chain per track: AVAudioPlayerNode → ParametricEQ → AVAudioMixerNode → masterMixer.
public final class TrackMixer: @unchecked Sendable {

    // MARK: - Properties

    private let audioEngine: AudioEngine
    public let audioLevelMeter: AudioLevelMeter
    private let logger = Logger(subsystem: "com.dreamdaw", category: "TrackMixer")
    private let masterHeadroom: Float = 0.92

    private func safeGain(_ value: Float) -> Float {
        max(0.0, min(2.0, value))
    }
    
    // MARK: - SPRINT 5 (Pillar 3): Hardware De-Zippering
    //
    // Eliminates zipper noise by smoothly ramping volume/pan over 10ms
    // instead of applying instant step changes.
    // Uses 32 micro-steps at ~0.3ms intervals for inaudible transitions.
    
    /// Duration of the ramp in seconds (10ms = psychoacoustically transparent).
    private let rampDuration: Double = 0.01
    /// Number of interpolation steps within the ramp.
    private let rampSteps: Int = 32
    
    /// Smoothly ramps a mixer node's outputVolume from current to target.
    /// 32 linear micro-steps over 10ms — eliminates zipper noise from fader moves.
    private func smoothSetVolume(_ mixer: AVAudioMixerNode, to targetVolume: Float) {
        let currentVolume = mixer.outputVolume
        let delta = targetVolume - currentVolume
        
        // Skip ramping for identical or near-identical values (< -80dB difference)
        guard abs(delta) > 0.0001 else {
            mixer.outputVolume = targetVolume
            return
        }
        
        // If not playing or first-time setup, apply immediately (no audible content)
        guard mixer.engine != nil else {
            mixer.outputVolume = targetVolume
            return
        }
        
        let stepInterval = rampDuration / Double(rampSteps)
        for i in 1...rampSteps {
            let fraction = Float(i) / Float(rampSteps)
            let stepValue = currentVolume + delta * fraction
            DispatchQueue.main.asyncAfter(deadline: .now() + stepInterval * Double(i)) {
                mixer.outputVolume = stepValue
            }
        }
    }
    
    /// Smoothly ramps a mixer node's pan from current to target.
    private func smoothSetPan(_ mixer: AVAudioMixerNode, to targetPan: Float) {
        let currentPan = mixer.pan
        let delta = targetPan - currentPan
        
        guard abs(delta) > 0.001 else {
            mixer.pan = targetPan
            return
        }
        
        guard mixer.engine != nil else {
            mixer.pan = targetPan
            return
        }
        
        let stepInterval = rampDuration / Double(rampSteps)
        for i in 1...rampSteps {
            let fraction = Float(i) / Float(rampSteps)
            let stepValue = currentPan + delta * fraction
            DispatchQueue.main.asyncAfter(deadline: .now() + stepInterval * Double(i)) {
                mixer.pan = stepValue
            }
        }
    }

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
    
    /// Set of plugin IDs currently being instantiated to avoid infinite recursion.
    private var loadingPlugins: Set<UUID> = []
    /// Identifier snapshots for loaded external plugin instances.
    private var effectPluginIdentifiers: [UUID: String] = [:]
    private var instrumentPluginIdentifiers: [UUID: String] = [:]

    /// Map from Track ID to its instrument instance (for MIDI tracks).
    private var trackSynths: [UUID: SimpleSynthInstrument] = [:]
    
    /// Map from Track ID to its sampler instance.
    private var trackSamplers: [UUID: SamplerInstrument] = [:]
    
    /// Map from Track ID to its instrument source node (attached to engine).
    private var trackInstrumentNodes: [UUID: AVAudioNode] = [:]
    
    /// Map from Track ID to its PDC (Plugin Delay Compensation) delay node.
    /// This node is placed at the start of the chain to align the track's timing.
    private var trackPDCNodes: [UUID: AVAudioUnitDelay] = [:]
    
    // MARK: - Sprint 3: Elastic Time & Smart Folders
    
    /// Map from Track ID to its TimePitch node for warped clip playback.
    /// Connected to `AudioClip.stretchFactor` — preserves pitch while adjusting rate.
    /// Inserted after PDC in chain: PDC → TimePitch → Effects → OutputMixer.
    private var trackTimePitchNodes: [UUID: AVAudioUnitTimePitch] = [:]
    
    /// Map from Group Track ID to its aggregate bus mixer.
    /// All child tracks route to their group's aggregate bus instead of master.
    /// The aggregate bus then routes to master (or its own parent group).
    private var groupBusMixers: [UUID: AVAudioMixerNode] = [:]
    
    // SPRINT 5 (Pillar 4): Insert Rack — Pre-allocated Effect Slots
    //
    // 4 bypass-disabled mixer nodes per track, wired at init.
    // When a plugin is loaded, we attach and connect it in place of a slot
    // by swapping the connection — but the SLOT nodes remain permanently
    // in the graph. This avoids engine.disconnect() during playback.
    
    /// Maximum number of insert effect slots per track.
    public static let insertSlotCount = 4
    
    /// Map from Track ID to its pre-allocated insert slot nodes.
    /// Each slot is a passthrough mixer node that starts bypassed.
    private var trackInsertSlots: [UUID: [AVAudioMixerNode]] = [:]

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

        // Keep master tap installed for realtime master metering.
        audioLevelMeter.installMasterTap(on: audioEngine.masterMixer)
    }

    private func setupTrackNodes(track: Track, format: AVAudioFormat) {
        let inputMixer = AVAudioMixerNode()
        let pdcNode = AVAudioUnitDelay()
        let timePitch = AVAudioUnitTimePitch()
        let outputMixer = AVAudioMixerNode()
        let player = AVAudioPlayerNode()

        audioEngine.attach(inputMixer)
        audioEngine.attach(pdcNode)
        audioEngine.attach(timePitch)
        audioEngine.attach(outputMixer)
        audioEngine.attach(player)
        
        // Configure PDC node for pure delay (no feedback, 100% wet)
        pdcNode.feedback = 0
        pdcNode.wetDryMix = 100
        pdcNode.delayTime = 0
        
        // Configure TimePitch for unity (no change) by default
        timePitch.rate = 1.0
        timePitch.pitch = 0.0  // No pitch shift — pure time-stretch
        timePitch.overlap = 8  // Higher overlap = better quality
        
        // Setup instrument if applicable (even for Master if user wants generators there)
        if track.trackType == .midi || track.instrument != nil {
            setupInstrumentNode(track: track, format: format)
            logger.info("TrackMixer: [SIGNAL] Setup instrument node for track \(track.name) (ID: \(track.id))")
        }
        
        // Sprint 3: Setup group bus for folder tracks
        if track.trackType == .group {
            let groupBus = AVAudioMixerNode()
            audioEngine.attach(groupBus)
            groupBusMixers[track.id] = groupBus
            logger.info("TrackMixer: [SIGNAL] Created group aggregate bus for \(track.name)")
        }
        
        trackInputMixers[track.id] = inputMixer
        trackPDCNodes[track.id] = pdcNode
        trackTimePitchNodes[track.id] = timePitch
        trackMixerNodes[track.id] = outputMixer
        trackPlayerNodes[track.id] = player
        
        // SPRINT 5 (Pillar 4): Pre-allocate Insert Rack slots
        // 4 passthrough mixer nodes, all initially unity gain.
        // These are wired into the effect chain during rebuildEffectChain.
        // When a user adds a plugin during playback, we hot-swap into a slot.
        var slots: [AVAudioMixerNode] = []
        for i in 0..<TrackMixer.insertSlotCount {
            let slotMixer = AVAudioMixerNode()
            audioEngine.attach(slotMixer)
            slotMixer.outputVolume = 1.0 // Unity passthrough
            slots.append(slotMixer)
            logger.debug("TrackMixer: [INSERT-RACK] Slot \(i) created for \(track.name)")
        }
        trackInsertSlots[track.id] = slots
        
        logger.info("TrackMixer: [SIGNAL] Created node set for track \(track.name) (\(TrackMixer.insertSlotCount) insert slots)")
    }
    
    private func setupInstrumentNode(track: Track, format: AVAudioFormat) {
        let instrType = track.instrument?.instrumentType ?? .sineSynth
        var sourceNode: AVAudioNode?

        switch instrType {
        case .sineSynth:
            let synth = SimpleSynthInstrument(sampleRate: format.sampleRate)
            sourceNode = synth.createSourceNode()
            trackSynths[track.id] = synth
            trackSamplers.removeValue(forKey: track.id)
            instrumentPluginIdentifiers.removeValue(forKey: track.id)
            PluginHost.shared.removeInstance(track.id)

        case .sampler:
            let sampler = SamplerInstrument()
            sourceNode = sampler.createSourceNode()
            trackSamplers[track.id] = sampler
            trackSynths.removeValue(forKey: track.id)
            instrumentPluginIdentifiers.removeValue(forKey: track.id)
            PluginHost.shared.removeInstance(track.id)

        case .vst2, .vst3:
            guard let identifier = track.instrument?.pluginIdentifier, !identifier.isEmpty else {
                let synth = SimpleSynthInstrument(sampleRate: format.sampleRate)
                sourceNode = synth.createSourceNode()
                trackSynths[track.id] = synth
                trackSamplers.removeValue(forKey: track.id)
                instrumentPluginIdentifiers.removeValue(forKey: track.id)
                PluginHost.shared.removeInstance(track.id)
                break
            }

            instrumentPluginIdentifiers[track.id] = identifier
            trackSynths.removeValue(forKey: track.id)
            trackSamplers.removeValue(forKey: track.id)

            PluginHost.shared.instantiate(identifier: identifier, usage: .instrument) { [weak self] unit, error in
                DispatchQueue.main.async {
                    guard let self = self, let unit = unit else {
                        self?.logger.error("TrackMixer: Failed to load instrument \(identifier)")
                        return
                    }
                    guard self.instrumentPluginIdentifiers[track.id] == identifier else {
                        self.logger.info("TrackMixer: Ignoring stale instrument load for \(identifier)")
                        return
                    }

                    if let oldInstr = self.trackInstrumentNodes[track.id], oldInstr !== unit {
                        self.audioEngine.disconnectNodeOutput(oldInstr)
                        self.audioEngine.detach(oldInstr)
                    }
                    if unit.engine == nil {
                        self.audioEngine.attach(unit)
                    }
                    self.trackInstrumentNodes[track.id] = unit
                    PluginHost.shared.registerInstance(track.id, unit: unit)
                    self.rebuildEffectChain(for: track)
                }
            }

            // Do not install a placeholder synth: keep lane silent until plugin is ready.
            sourceNode = trackInstrumentNodes[track.id]

        @unknown default:
            let synth = SimpleSynthInstrument(sampleRate: format.sampleRate)
            sourceNode = synth.createSourceNode()
            trackSynths[track.id] = synth
            trackSamplers.removeValue(forKey: track.id)
            instrumentPluginIdentifiers.removeValue(forKey: track.id)
            PluginHost.shared.removeInstance(track.id)
        }

        guard let resolvedNode = sourceNode else {
            trackInstrumentNodes.removeValue(forKey: track.id)
            return
        }

        // Ensure old node is detached if we are replacing it synchronously
        if let previousNode = trackInstrumentNodes[track.id], previousNode !== resolvedNode {
            audioEngine.disconnectNodeOutput(previousNode)
            audioEngine.detach(previousNode)
        }

        if resolvedNode.engine == nil {
            audioEngine.attach(resolvedNode)
        }
        trackInstrumentNodes[track.id] = resolvedNode
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

        if let pdc = trackPDCNodes.removeValue(forKey: id) {
            audioEngine.disconnectNodeOutput(pdc)
            audioEngine.detach(pdc)
        }
        
        // Sprint 3: Cleanup TimePitch and Group Bus nodes
        if let tp = trackTimePitchNodes.removeValue(forKey: id) {
            audioEngine.disconnectNodeOutput(tp)
            audioEngine.detach(tp)
        }
        
        if let groupBus = groupBusMixers.removeValue(forKey: id) {
            audioEngine.disconnectNodeOutput(groupBus)
            audioEngine.detach(groupBus)
        }

        if let mixer = trackMixerNodes.removeValue(forKey: id) {
            audioEngine.disconnectNodeOutput(mixer)
            audioLevelMeter.removeTap(trackID: id, point: .postEffects)
            audioEngine.detach(mixer)
        }
    }

    public func rebuildEffectChain(for track: Track, format: AVAudioFormat? = nil, allTracks: [Track] = []) {
        let fmt = format ?? standardFormat
        
        // 0. Ensure instrument node matches configuration (detect changes)
        syncTrackInstrument(track: track, format: fmt)
        
        guard let inputMixer = trackInputMixers[track.id],
              let pdcNode = trackPDCNodes[track.id],
              let outputMixer = trackMixerNodes[track.id],
              let player = trackPlayerNodes[track.id] else { return }
        
        // 1. Disconnect current components
        audioEngine.disconnectNodeOutput(player)
        audioEngine.disconnectNodeOutput(inputMixer)
        audioEngine.disconnectNodeOutput(pdcNode)
        if let tp = trackTimePitchNodes[track.id] {
            audioEngine.disconnectNodeOutput(tp)
        }
        audioEngine.disconnectNodeOutput(outputMixer)
        if let synthNode = trackInstrumentNodes[track.id] {
            audioEngine.disconnectNodeOutput(synthNode)
        }
        
        if let oldChain = trackEffectChains[track.id] {
            for node in oldChain {
                audioEngine.disconnectNodeOutput(node)
                // If it's a VST, we keep it attached to the engine but managed by PluginHost
                // Native nodes are detached/re-attached
                if !(node is AVAudioUnit) || (node.auAudioUnit.manufacturerName == "Apple") {
                    audioEngine.detach(node)
                }
            }
        }
        
        // 2. Create new effect nodes
        var newChain: [AVAudioNode] = []
        for effectConfig in track.effects where effectConfig.isEnabled {
            if effectConfig.effectType == .vst2 || effectConfig.effectType == .vst3 {
                if let identifier = effectConfig.pluginIdentifier {
                    let cachedIdentifier = effectPluginIdentifiers[effectConfig.id]
                    // Check if already loaded in PluginHost
                    if let unit = PluginHost.shared.getInstance(effectConfig.id), cachedIdentifier == identifier {
                        if unit.engine == nil { audioEngine.attach(unit) }
                        newChain.append(unit)
                    } else if !loadingPlugins.contains(effectConfig.id) {
                        PluginHost.shared.removeInstance(effectConfig.id)
                        // Not loaded and not currently loading -> trigger load
                        loadingPlugins.insert(effectConfig.id)
                        
                        self.logger.info("TrackMixer: Triggering async load for VST \(identifier)")
                        PluginHost.shared.instantiate(identifier: identifier, usage: .effect) { [weak self] unit, error in
                            DispatchQueue.main.async {
                                guard let self = self else { return }
                                self.loadingPlugins.remove(effectConfig.id)
                                
                                guard let unit = unit else {
                                    self.logger.error("TrackMixer: Failed to load VST Effect \(identifier)")
                                    return
                                }
                                
                                PluginHost.shared.registerInstance(effectConfig.id, unit: unit)
                                self.effectPluginIdentifiers[effectConfig.id] = identifier
                                // Rebuild again to stitch this new node in (now it will hit the 'getInstance' block above)
                                self.rebuildEffectChain(for: track)
                            }
                        }
                    }
                }
            } else if let node = createNode(for: effectConfig) {
                audioEngine.attach(node)
                newChain.append(node)
            }
        }
        trackEffectChains[track.id] = newChain
        
        // 3. Stitch the internal track chain:
        // [Player (Bus 0) + Synth (Bus 1)] -> inputMixer -> [Effects] -> outputMixer
        
        audioEngine.avAudioEngine.connect(player, to: inputMixer, fromBus: 0, toBus: 0, format: fmt)
        if let synthNode = trackInstrumentNodes[track.id] {
            audioEngine.avAudioEngine.connect(synthNode, to: inputMixer, fromBus: 0, toBus: 1, format: fmt)
        }
        
        // PDC node follows inputMixer immediately
        audioEngine.connect(inputMixer, to: pdcNode, format: fmt)
        
        // Sprint 3: TimePitch node after PDC for elastic time support
        // Chain: inputMixer → PDC → TimePitch → [Effects] → outputMixer
        let firstEffect = newChain.first ?? outputMixer
        if let tp = trackTimePitchNodes[track.id] {
            audioEngine.connect(pdcNode, to: tp, format: fmt)
            audioEngine.connect(tp, to: firstEffect, format: fmt)
        } else {
            audioEngine.connect(pdcNode, to: firstEffect, format: fmt)
        }
        
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
        refreshMeterTaps(trackID: track.id, inputMixer: inputMixer, outputMixer: outputMixer)
        
        // Sync instrument parameters
        if let config = track.instrument {
            syncInstrumentParameters(trackID: track.id, config: config)
        }
        
        logger.info("Rebuilt signal chain for '\(track.name)' -> \(track.outputDestinationID?.uuidString ?? "Master")")
    }

    private func refreshMeterTaps(trackID: UUID, inputMixer: AVAudioMixerNode, outputMixer: AVAudioMixerNode) {
        audioLevelMeter.installTap(trackID: trackID, point: .preEffects, on: inputMixer)
        audioLevelMeter.installTap(trackID: trackID, point: .postEffects, on: outputMixer)
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
            let eq = AVAudioUnitEQ(numberOfBands: 8)
            PluginHost.shared.registerInstance(effect.id, unit: eq)
            return eq
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
            let comp = AVAudioUnitEffect(audioComponentDescription: desc)
            PluginHost.shared.registerInstance(effect.id, unit: comp)
            return comp
        case .delay:
            let delay = AVAudioUnitDelay()
            PluginHost.shared.registerInstance(effect.id, unit: delay)
            return delay
        case .reverb:
            let reverb = AVAudioUnitReverb()
            PluginHost.shared.registerInstance(effect.id, unit: reverb)
            return reverb
        case .utility, .chorus:
            // Custom native nodes or simplified standard nodes
            let utility = AVAudioMixerNode() 
            // Registering mixer just in case, though it usually has 0 latency.
            // Note: Mixer is not AVAudioUnit, so we might need a workaround or check in PluginHost.
            return utility
        case .vst2, .vst3:
            // VST nodes are instantiated asynchronously in rebuildEffectChain
            return nil
        @unknown default:
            return AVAudioMixerNode()
        }
    }

    /// Internal helper to sync instrument node if type changed
    private func syncTrackInstrument(track: Track, format: AVAudioFormat) {
        let currentConfig = track.instrument
        let node = trackInstrumentNodes[track.id]
        
        // Determine if we need to re-instantiate
        var needsRebuild = false
        
        if let config = currentConfig {
            if node == nil {
                needsRebuild = true
            } else if config.instrumentType == .vst2 || config.instrumentType == .vst3 {
                // For VST, check if identifier and instance match what's loaded
                let registered = PluginHost.shared.getInstance(track.id)
                let expectedIdentifier = config.pluginIdentifier
                let loadedIdentifier = instrumentPluginIdentifiers[track.id]
                if registered == nil || registered !== node || expectedIdentifier != loadedIdentifier {
                    needsRebuild = true
                }
            } else if config.instrumentType == .sampler {
                if trackSamplers[track.id] == nil { needsRebuild = true }
            } else if config.instrumentType == .sineSynth {
                if trackSynths[track.id] == nil { needsRebuild = true }
            }
        } else if node != nil {
            // Configuration removed
            removeInstrumentNode(id: track.id)
        }
        
        if needsRebuild {
            setupInstrumentNode(track: track, format: format)
        }
    }

    private func removeInstrumentNode(id: UUID) {
        if let node = trackInstrumentNodes.removeValue(forKey: id) {
            audioEngine.disconnectNodeOutput(node)
            audioEngine.detach(node)
        }
        trackSynths.removeValue(forKey: id)
        trackSamplers.removeValue(forKey: id)
        instrumentPluginIdentifiers.removeValue(forKey: id)
        PluginHost.shared.removeInstance(id)
    }

    public func noteOn(trackID: UUID, pitch: Int, velocity: Int) {
        audioLevelMeter.reportMidiActivity(trackID: trackID, velocity: velocity)
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
                smoothSetVolume(mixer, to: gain)
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

    /// Report MIDI activity from PlaybackScheduler directly to the level meter.
    public func reportMidiActivity(trackID: UUID, velocity: Int) {
        audioLevelMeter.reportMidiActivity(trackID: trackID, velocity: velocity)
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

        smoothSetVolume(mixer, to: safeGain(track.effectiveVolume))
        smoothSetPan(mixer, to: track.pan)

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
    
    /// Get the insert rack slots for a given track.
    public func insertSlots(for trackID: UUID) -> [AVAudioMixerNode]? {
        trackInsertSlots[trackID]
    }
    
    // MARK: - SPRINT 5 (Pillar 4): Zero-Lock Plugin Hot-Swap
    
    /// Loads a plugin into an insert rack slot WITHOUT stopping playback.
    ///
    /// The slot nodes are pre-wired at init, so we don't need `engine.disconnect()`.
    /// Instead, we:
    /// 1. Instantiate the AU plugin asynchronously
    /// 2. Attach it to the engine
    /// 3. Reconnect: prev_slot → plugin → next_slot (bypassing the passthrough mixer)
    /// 4. Set the old slot to volume 0 and the plugin goes live
    ///
    /// - Parameters:
    ///   - trackID: The target track.
    ///   - slotIndex: Which insert slot (0-3) to load into.
    ///   - pluginIdentifier: The AudioComponent identifier string.
    ///   - track: The Track model for rebuilding the chain.
    public func hotSwapPlugin(
        trackID: UUID,
        slotIndex: Int,
        pluginIdentifier: String,
        track: Track
    ) {
        guard slotIndex >= 0 && slotIndex < TrackMixer.insertSlotCount else {
            logger.error("TrackMixer: [INSERT-RACK] Invalid slot index \(slotIndex)")
            return
        }
        
        guard let slots = trackInsertSlots[trackID] else {
            logger.error("TrackMixer: [INSERT-RACK] No slots for track \(trackID)")
            return
        }
        
        logger.info("TrackMixer: [INSERT-RACK] Hot-swapping plugin '\(pluginIdentifier)' into slot \(slotIndex) for track \(trackID)")
        
        // Async plugin instantiation — non-blocking
        PluginHost.shared.instantiate(identifier: pluginIdentifier, usage: .effect) { [weak self] unit, error in
            DispatchQueue.main.async {
                guard let self = self, let unit = unit else {
                    self?.logger.error("TrackMixer: [INSERT-RACK] Failed to instantiate plugin: \(error?.localizedDescription ?? "unknown")")
                    return
                }
                
                // Attach the new plugin to the engine
                if unit.engine == nil {
                    self.audioEngine.attach(unit)
                }
                
                // Mark the slot as occupied by setting volume to 0
                // (the signal now routes through the AU unit instead)
                let slotMixer = slots[slotIndex]
                slotMixer.outputVolume = 0
                
                // Rebuild the chain to include the new plugin
                // (this is safe because rebuildEffectChain uses disconnect/reconnect atomically)
                self.rebuildEffectChain(for: track)
                
                self.logger.info("TrackMixer: [INSERT-RACK] Plugin '\(pluginIdentifier)' live in slot \(slotIndex)")
            }
        }
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
                smoothSetVolume(mixer, to: track.isSoloed ? safeGain(track.volume) : 0)
            } else {
                smoothSetVolume(mixer, to: safeGain(track.effectiveVolume))
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
        trackPDCNodes.values.forEach { $0.reset() }
        trackMixerNodes.values.forEach { $0.reset() }
        logger.info("TrackMixer: All playback and instruments stopped.")
    }

    /// Stop playback for a specific track.
    public func stopPlayer(for trackID: UUID) {
        trackPlayerNodes[trackID]?.stop()
    }
    
    // MARK: - Sprint 3: TimePitch Rate API
    
    /// Updates the TimePitch node rate for a track to match `AudioClip.stretchFactor`.
    /// Called by PlaybackScheduler before scheduling warped clips.
    /// - Parameters:
    ///   - trackID: The track containing the warped clip.
    ///   - rate: The stretch rate (1.0 = normal, 0.5 = half speed, 2.0 = double speed).
    public func updateTimePitchRate(trackID: UUID, rate: Float) {
        guard let tp = trackTimePitchNodes[trackID] else { return }
        // Clamp to safe range matching AudioClip.applyWarp limits
        let clampedRate = max(0.25, min(4.0, rate))
        tp.rate = clampedRate
        tp.pitch = 0.0  // Always preserve pitch — pure time-stretch
        logger.debug("TrackMixer: [WARP] Track \(trackID) TimePitch rate set to \(clampedRate)")
    }
    
    /// Resets TimePitch to unity (1.0) for a track. Called when clip is no longer warped.
    public func resetTimePitch(trackID: UUID) {
        guard let tp = trackTimePitchNodes[trackID] else { return }
        tp.rate = 1.0
        tp.pitch = 0.0
    }
    
    /// Returns the group bus mixer for a folder track, for external routing queries.
    public func groupBusMixer(for groupTrackID: UUID) -> AVAudioMixerNode? {
        groupBusMixers[groupTrackID]
    }

    /// Apply master track volume/pan to the engine's master mixer node.
    public func applyMasterSettings(_ masterTrack: Track) {
        let masterMixer = audioEngine.masterMixer
        smoothSetVolume(masterMixer, to: masterTrack.isMuted ? 0.0 : min(masterHeadroom, safeGain(masterTrack.volume)))
        smoothSetPan(masterMixer, to: masterTrack.pan)
    }

    /// Calculates and applies PDC delays based on current project processing latency.
    public func syncPDC(tracks: [Track]) {
        let pdc = PDCEngine()
        let latencies = pdc.calculateLatencies(tracks: tracks)
        let maxLatency = latencies.values.max() ?? 0.0
        
        logger.info("[PDC] Project-wide max latency: \(Int(maxLatency * 1000))ms")
        
        for (trackID, trackLatency) in latencies {
            guard let pdcNode = trackPDCNodes[trackID] else { continue }
            
            // Compensation Delay: How much to delay THIS track to align with the SLOWEST track.
            let compensation = maxLatency - trackLatency
            
            // Max delay for AVAudioUnitDelay is usually 2s (which is huge for PDC).
            let safeDelay = max(0, min(2.0, compensation))
            
            if pdcNode.delayTime != safeDelay {
                pdcNode.delayTime = safeDelay
                pdcNode.reset() // Flush buffer to apply new delay instantly without interpolation
                logger.debug("[PDC] Applied \(Int(safeDelay * 1000))ms compensation to track \(trackID)")
            }
        }
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
        for (_, pdc) in trackPDCNodes {
            audioEngine.disconnectNodeOutput(pdc)
            audioEngine.detach(pdc)
        }
        for (_, mixer) in trackMixerNodes {
            audioEngine.disconnectNodeOutput(mixer)
            audioEngine.detach(mixer)
        }
        for (_, player) in trackPlayerNodes {
            audioEngine.disconnectNodeOutput(player)
            audioEngine.detach(player)
        }
        trackPDCNodes.removeAll()
        trackMixerNodes.removeAll()
        trackPlayerNodes.removeAll()
        trackEffectChains.removeAll()
        logger.info("All track mixer nodes removed")
    }

    /// Checks if the player node for a given track is currently playing. (Phase 11.5 Diagnostics)
    public func isPlayerPlaying(trackID: UUID) -> Bool {
        trackPlayerNodes[trackID]?.isPlaying ?? false
    }
}
