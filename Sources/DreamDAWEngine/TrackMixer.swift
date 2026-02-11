import AVFoundation
import Foundation
import DreamDAWModels
import os.log

// MARK: - TrackMixer

/// Manages per-track mixer nodes within the audio engine graph.
/// Each track gets its own AVAudioMixerNode for independent volume/pan/mute control.
public final class TrackMixer {

    // MARK: - Properties

    private let audioEngine: AudioEngine
    private let logger = Logger(subsystem: "com.dreamdaw", category: "TrackMixer")

    /// Map from Track ID to its mixer node.
    private var trackMixerNodes: [UUID: AVAudioMixerNode] = [:]

    /// Map from Track ID to its player node (for clip playback).
    private var trackPlayerNodes: [UUID: AVAudioPlayerNode] = [:]

    // MARK: - Initialization

    public init(audioEngine: AudioEngine) {
        self.audioEngine = audioEngine
    }

    // MARK: - Track Setup

    /// Set up mixer and player nodes for a set of tracks.
    public func configureTracks(_ tracks: [Track]) {
        // Remove nodes for tracks that no longer exist
        let currentIDs = Set(tracks.map(\.id))
        for (id, node) in trackMixerNodes where !currentIDs.contains(id) {
            audioEngine.disconnectNodeOutput(node)
            audioEngine.detach(node)
            trackMixerNodes.removeValue(forKey: id)

            if let player = trackPlayerNodes.removeValue(forKey: id) {
                player.stop()
                audioEngine.disconnectNodeOutput(player)
                audioEngine.detach(player)
            }
        }

        // Create nodes for new tracks
        for track in tracks {
            if trackMixerNodes[track.id] == nil {
                let mixer = AVAudioMixerNode()
                let player = AVAudioPlayerNode()

                audioEngine.attach(mixer)
                audioEngine.attach(player)

                audioEngine.connect(player, to: mixer, format: nil)
                audioEngine.connect(mixer, to: audioEngine.masterMixer, format: nil)

                trackMixerNodes[track.id] = mixer
                trackPlayerNodes[track.id] = player

                logger.info("Created mixer chain for track: \(track.name)")
            }

            // Apply current track settings
            applyTrackSettings(track)
        }
    }

    /// Apply volume, pan, and mute settings to a track's mixer node.
    public func applyTrackSettings(_ track: Track) {
        guard let mixer = trackMixerNodes[track.id] else { return }

        mixer.outputVolume = track.effectiveVolume
        mixer.pan = track.pan
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

    /// Stop all player nodes.
    public func stopAll() {
        for (_, player) in trackPlayerNodes {
            player.stop()
        }
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
        logger.info("All track mixer nodes removed")
    }
}
