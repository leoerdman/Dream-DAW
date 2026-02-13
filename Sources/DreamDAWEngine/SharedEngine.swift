import Foundation
import DreamDAWModels

/// Enterprise-grade container for core audio services.
/// Allows for dependency injection and centralized lifecycle management.
@MainActor
public final class SharedEngine {
    public let audioEngine: AudioEngine
    public let transportController: TransportController
    public let trackMixer: TrackMixer
    public let playbackScheduler: PlaybackScheduler
    public let waveformCache: WaveformCache
    public let audioLevelMeter: AudioLevelMeter
    
    public init(
        audioEngine: AudioEngine,
        transportController: TransportController,
        trackMixer: TrackMixer,
        playbackScheduler: PlaybackScheduler,
        waveformCache: WaveformCache,
        audioLevelMeter: AudioLevelMeter
    ) {
        self.audioEngine = audioEngine
        self.transportController = transportController
        self.trackMixer = trackMixer
        self.playbackScheduler = playbackScheduler
        self.waveformCache = waveformCache
        self.audioLevelMeter = audioLevelMeter
    }
    
    /// Factory method to create a fully initialized engine suite.
    /// This performs heavy AudioEngine setup on a background thread.
    public static func createAsync() async -> SharedEngine {
        // Perform non-MainActor work first
        let engine = AudioEngine()
        let levelMeter = AudioLevelMeter()
        let mixer = TrackMixer(audioEngine: engine, audioLevelMeter: levelMeter)
        let scheduler = PlaybackScheduler(audioEngine: engine, trackMixer: mixer)
        let cache = WaveformCache()
        
        // Finalize on Main Actor for TransportController which is MainActor-bound
        return await MainActor.run {
            let transport = TransportController(audioEngine: engine)
            return SharedEngine(
                audioEngine: engine,
                transportController: transport,
                trackMixer: mixer,
                playbackScheduler: scheduler,
                waveformCache: cache,
                audioLevelMeter: levelMeter
            )
        }
    }
}
