import AVFoundation
import Foundation
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

    /// Map from Track ID to its mixer node.
    private var trackMixerNodes: [UUID: AVAudioMixerNode] = [:]

    /// Map from Track ID to its player node (for clip playback).
    private var trackPlayerNodes: [UUID: AVAudioPlayerNode] = [:]

    /// Map from Track ID to its EQ processor.
    private var trackEQNodes: [UUID: ParametricEQ] = [:]

    // MARK: - Initialization

    public init(audioEngine: AudioEngine) {
        self.audioEngine = audioEngine
    }

    // MARK: - Track Setup

    /// Set up mixer, EQ, and player nodes for a set of tracks.
    /// Signal chain: player → EQ → mixer → masterMixer
    public func configureTracks(_ tracks: [Track]) {
        let format = standardFormat
        logger.info("Configuring tracks with format: \(format.sampleRate)Hz, \(format.channelCount)ch")

        // Remove nodes for tracks that no longer exist
        let currentIDs = Set(tracks.map(\.id))
        for (id, node) in trackMixerNodes where !currentIDs.contains(id) {
            // Disconnect and detach EQ
            if let eq = trackEQNodes.removeValue(forKey: id) {
                audioEngine.disconnectNodeOutput(eq.eqNode)
                audioEngine.detach(eq.eqNode)
            }

            audioEngine.disconnectNodeOutput(node)
            audioEngine.detach(node)
            trackMixerNodes.removeValue(forKey: id)

            if let player = trackPlayerNodes.removeValue(forKey: id) {
                player.stop()
                audioEngine.disconnectNodeOutput(player)
                audioEngine.detach(player)
            }
        }

        // Create nodes for new tracks (skip master — it has no player)
        for track in tracks where track.trackType != .master {
            if trackMixerNodes[track.id] == nil {
                let mixer = AVAudioMixerNode()
                let player = AVAudioPlayerNode()
                let eq = ParametricEQ()

                audioEngine.attach(mixer)
                audioEngine.attach(player)
                audioEngine.attach(eq.eqNode)

                // Signal chain: player → EQ → mixer → masterMixer
                // CRITICAL: Use explicit format to prevent 0-channel negotiation
                audioEngine.connect(player, to: eq.eqNode, format: format)
                audioEngine.connect(eq.eqNode, to: mixer, format: format)
                audioEngine.connect(mixer, to: audioEngine.masterMixer, format: format)

                trackMixerNodes[track.id] = mixer
                trackPlayerNodes[track.id] = player
                trackEQNodes[track.id] = eq

                logger.info("Created mixer chain for track: \(track.name) [format: \(format)]")
            }

            // Apply current track settings
            applyTrackSettings(track)

            // Apply EQ config if track has EQ effect
            applyEQConfig(track)
        }
    }

    /// Apply volume, pan, and mute settings to a track's mixer node.
    public func applyTrackSettings(_ track: Track) {
        guard let mixer = trackMixerNodes[track.id] else { return }

        mixer.outputVolume = track.effectiveVolume
        mixer.pan = track.pan
    }

    /// Apply EQ configuration from track's effects list.
    public func applyEQConfig(_ track: Track) {
        guard let eq = trackEQNodes[track.id] else { return }

        // Find the EQ effect in track's effects chain
        if let eqConfig = track.effects.first(where: { $0.effectType == .eq }), eqConfig.isEnabled {
            eq.applyConfig(eqConfig.eqBands)
        } else {
            // Bypass all bands if no EQ or disabled
            for i in 0..<ParametricEQ.bandCount {
                eq.setBandEnabled(i, enabled: false)
            }
        }
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

    /// Get the player node for a given track.
    public func playerNode(for trackID: UUID) -> AVAudioPlayerNode? {
        trackPlayerNodes[trackID]
    }

    /// Get the mixer node for a given track.
    public func mixerNode(for trackID: UUID) -> AVAudioMixerNode? {
        trackMixerNodes[trackID]
    }

    /// Get the EQ processor for a given track.
    public func eqProcessor(for trackID: UUID) -> ParametricEQ? {
        trackEQNodes[trackID]
    }

    /// Stop all player nodes.
    public func stopAll() {
        for (_, player) in trackPlayerNodes {
            player.stop()
        }
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
        for (_, eq) in trackEQNodes {
            audioEngine.disconnectNodeOutput(eq.eqNode)
            audioEngine.detach(eq.eqNode)
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
        trackEQNodes.removeAll()
        logger.info("All track mixer nodes removed")
    }
}

