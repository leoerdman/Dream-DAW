import Foundation

// MARK: - AudioEffectType

/// Built-in audio effect types.
public enum AudioEffectType: String, Codable, CaseIterable, Sendable {
    case eq = "eq"
    case utility = "utility"
    case compressor = "compressor"
    case delay = "delay"
    case reverb = "reverb"
    case chorus = "chorus"

    public var displayName: String {
        switch self {
        case .eq: return "EQ Eight"
        case .utility: return "Utility"
        case .compressor: return "Compressor"
        case .delay: return "Delay"
        case .reverb: return "Reverb"
        case .chorus: return "Chorus-Ensemble"
        }
    }

    public var icon: String {
        switch self {
        case .eq: return "slider.horizontal.3"
        case .utility: return "wrench"
        case .compressor: return "waveform.path.ecg"
        case .delay: return "clock.arrow.2.circlepath"
        case .reverb: return "waveform.badge.magnifyingglass"
        case .chorus: return "waveform.path"
        }
    }
}

// MARK: - EQBandConfig

/// Configuration for a single EQ band.
public struct EQBandConfig: Codable, Identifiable, Sendable {
    public let id: UUID
    public var frequency: Float     // Hz (20...20000)
    public var gain: Float          // dB (-12...+12)
    public var bandwidth: Float     // Octaves (0.1...4.0)
    public var isEnabled: Bool
    public var filterType: EQFilterType

    public init(
        id: UUID = UUID(),
        frequency: Float = 1000.0,
        gain: Float = 0.0,
        bandwidth: Float = 1.0,
        isEnabled: Bool = true,
        filterType: EQFilterType = .parametric
    ) {
        self.id = id
        self.frequency = frequency
        self.gain = gain
        self.bandwidth = bandwidth
        self.isEnabled = isEnabled
        self.filterType = filterType
    }
}

// MARK: - EQFilterType

public enum EQFilterType: String, Codable, CaseIterable, Sendable {
    case lowCut       = "lowCut"
    case lowShelf     = "lowShelf"
    case parametric   = "parametric"
    case highShelf    = "highShelf"
    case highCut      = "highCut"

    public var displayName: String {
        switch self {
        case .lowCut:     return "Low Cut"
        case .lowShelf:   return "Low Shelf"
        case .parametric: return "Parametric"
        case .highShelf:  return "High Shelf"
        case .highCut:    return "High Cut"
        }
    }
}

// MARK: - AudioEffectConfig

/// Configuration for an audio effect instance on a track.
public final class AudioEffectConfig: ObservableObject, Identifiable, Codable {
    public let id: UUID
    @Published public var effectType: AudioEffectType
    @Published public var isEnabled: Bool
    @Published public var eqBands: [EQBandConfig]
    @Published public var gainDB: Float   // For Utility: -60...+6 dB (default 0.0)

    public init(
        id: UUID = UUID(),
        effectType: AudioEffectType = .eq,
        isEnabled: Bool = true,
        eqBands: [EQBandConfig] = AudioEffectConfig.defaultEQBands(),
        gainDB: Float = 0.0
    ) {
        self.id = id
        self.effectType = effectType
        self.isEnabled = isEnabled
        self.eqBands = eqBands
        self.gainDB = gainDB
    }

    /// Default 8-band EQ configuration matching Ableton EQ Eight frequencies.
    public static func defaultEQBands() -> [EQBandConfig] {
        let freqs: [(Float, EQFilterType)] = [
            (30,    .lowCut),
            (100,   .lowShelf),
            (250,   .parametric),
            (500,   .parametric),
            (1000,  .parametric),
            (2500,  .parametric),
            (6000,  .highShelf),
            (16000, .highCut)
        ]
        return freqs.enumerated().map { (i, pair) in
            EQBandConfig(
                frequency: pair.0,
                gain: 0.0,
                bandwidth: 1.0,
                isEnabled: i >= 1 && i <= 6, // Bands 2-7 enabled by default
                filterType: pair.1
            )
        }
    }

    // MARK: - Codable

    private enum CodingKeys: String, CodingKey {
        case id, effectType, isEnabled, eqBands, gainDB
    }

    public convenience init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try container.decode(UUID.self, forKey: .id),
            effectType: try container.decode(AudioEffectType.self, forKey: .effectType),
            isEnabled: try container.decode(Bool.self, forKey: .isEnabled),
            eqBands: try container.decodeIfPresent([EQBandConfig].self, forKey: .eqBands)
                ?? AudioEffectConfig.defaultEQBands(),
            gainDB: try container.decodeIfPresent(Float.self, forKey: .gainDB) ?? 0.0
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(effectType, forKey: .effectType)
        try container.encode(isEnabled, forKey: .isEnabled)
        try container.encode(eqBands, forKey: .eqBands)
        try container.encode(gainDB, forKey: .gainDB)
    }
}

// MARK: - InstrumentType

/// Built-in MIDI instrument types.
public enum InstrumentType: String, Codable, CaseIterable, Sendable {
    case sineSynth = "sineSynth"
    case sampler   = "sampler"

    public var displayName: String {
        switch self {
        case .sineSynth: return "Simple Sine Synth"
        case .sampler:   return "Sampler"
        }
    }

    public var icon: String {
        switch self {
        case .sineSynth: return "waveform.path"
        case .sampler:   return "waveform.badge.plus"
        }
    }
}

// MARK: - SamplerMode

/// Sampler playback mode.
public enum SamplerMode: String, Codable, CaseIterable, Sendable {
    case oneShot = "oneShot"
    case loop    = "loop"

    public var displayName: String {
        switch self {
        case .oneShot: return "One-Shot"
        case .loop:    return "Loop"
        }
    }
}

// MARK: - InstrumentConfig

/// Configuration for a MIDI instrument on a track.
public final class InstrumentConfig: ObservableObject, Identifiable, Codable {
    public let id: UUID
    @Published public var instrumentType: InstrumentType
    @Published public var isEnabled: Bool
    @Published public var sampleURL: URL?          // For sampler: loaded sample path
    @Published public var samplerMode: SamplerMode // For sampler: oneShot or loop
    
    // Sampler Parameters (Ableton Simpler Style)
    @Published public var gain: Float              // 0.0 ... 2.0 (standard 1.0)
    @Published public var startPercent: Double     // 0.0 ... 100.0
    @Published public var endPercent: Double       // 0.0 ... 100.0
    @Published public var loopPercent: Double      // 0.0 ... 100.0
    @Published public var fadePercent: Double      // 0.0 ... 100.0
    
    // ADSR Envelope
    @Published public var attack: Double           // Seconds
    @Published public var decay: Double            // Seconds
    @Published public var sustain: Double          // 0.0 ... 1.0 (linear gain)
    @Published public var release: Double          // Seconds
    
    // Filter
    @Published public var filterType: Int          // 0=LowPass, 1=HighPass, etc.
    @Published public var filterCutoff: Double     // 20 ... 22000 Hz
    @Published public var filterResonance: Double  // 0.0 ... 1.0
    
    // LFO
    @Published public var lfoRate: Double          // Hz
    @Published public var lfoAmount: Double        // 0.0 ... 1.0
    @Published public var lfoType: Int             // 0=Sine, 1=Triangle, etc.

    public init(
        id: UUID = UUID(),
        instrumentType: InstrumentType = .sineSynth,
        isEnabled: Bool = true,
        sampleURL: URL? = nil,
        samplerMode: SamplerMode = .oneShot,
        gain: Float = 1.0,
        startPercent: Double = 0.0,
        endPercent: Double = 100.0,
        loopPercent: Double = 100.0,
        fadePercent: Double = 0.0,
        attack: Double = 0.001,
        decay: Double = 0.6,
        sustain: Double = 1.0,
        release: Double = 0.05,
        filterType: Int = 0,
        filterCutoff: Double = 22000.0,
        filterResonance: Double = 0.0,
        lfoRate: Double = 1.0,
        lfoAmount: Double = 0.0,
        lfoType: Int = 0
    ) {
        self.id = id
        self.instrumentType = instrumentType
        self.isEnabled = isEnabled
        self.sampleURL = sampleURL
        self.samplerMode = samplerMode
        self.gain = gain
        self.startPercent = startPercent
        self.endPercent = endPercent
        self.loopPercent = loopPercent
        self.fadePercent = fadePercent
        self.attack = attack
        self.decay = decay
        self.sustain = sustain
        self.release = release
        self.filterType = filterType
        self.filterCutoff = filterCutoff
        self.filterResonance = filterResonance
        self.lfoRate = lfoRate
        self.lfoAmount = lfoAmount
        self.lfoType = lfoType
    }

    // MARK: - Codable

    private enum CodingKeys: String, CodingKey {
        case id, instrumentType, isEnabled, sampleURL, samplerMode
        case gain, startPercent, endPercent, loopPercent, fadePercent
        case attack, decay, sustain, release
        case filterType, filterCutoff, filterResonance
        case lfoRate, lfoAmount, lfoType
    }

    public convenience init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try container.decode(UUID.self, forKey: .id),
            instrumentType: try container.decode(InstrumentType.self, forKey: .instrumentType),
            isEnabled: try container.decode(Bool.self, forKey: .isEnabled),
            sampleURL: try container.decodeIfPresent(URL.self, forKey: .sampleURL),
            samplerMode: try container.decodeIfPresent(SamplerMode.self, forKey: .samplerMode) ?? .oneShot,
            gain: try container.decodeIfPresent(Float.self, forKey: .gain) ?? 1.0,
            startPercent: try container.decodeIfPresent(Double.self, forKey: .startPercent) ?? 0.0,
            endPercent: try container.decodeIfPresent(Double.self, forKey: .endPercent) ?? 100.0,
            loopPercent: try container.decodeIfPresent(Double.self, forKey: .loopPercent) ?? 100.0,
            fadePercent: try container.decodeIfPresent(Double.self, forKey: .fadePercent) ?? 0.0,
            attack: try container.decodeIfPresent(Double.self, forKey: .attack) ?? 0.001,
            decay: try container.decodeIfPresent(Double.self, forKey: .decay) ?? 0.6,
            sustain: try container.decodeIfPresent(Double.self, forKey: .sustain) ?? 1.0,
            release: try container.decodeIfPresent(Double.self, forKey: .release) ?? 0.05,
            filterType: try container.decodeIfPresent(Int.self, forKey: .filterType) ?? 0,
            filterCutoff: try container.decodeIfPresent(Double.self, forKey: .filterCutoff) ?? 22000.0,
            filterResonance: try container.decodeIfPresent(Double.self, forKey: .filterResonance) ?? 0.0,
            lfoRate: try container.decodeIfPresent(Double.self, forKey: .lfoRate) ?? 1.0,
            lfoAmount: try container.decodeIfPresent(Double.self, forKey: .lfoAmount) ?? 0.0,
            lfoType: try container.decodeIfPresent(Int.self, forKey: .lfoType) ?? 0
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(instrumentType, forKey: .instrumentType)
        try container.encode(isEnabled, forKey: .isEnabled)
        try container.encodeIfPresent(sampleURL, forKey: .sampleURL)
        try container.encode(samplerMode, forKey: .samplerMode)
        try container.encode(gain, forKey: .gain)
        try container.encode(startPercent, forKey: .startPercent)
        try container.encode(endPercent, forKey: .endPercent)
        try container.encode(loopPercent, forKey: .loopPercent)
        try container.encode(fadePercent, forKey: .fadePercent)
        try container.encode(attack, forKey: .attack)
        try container.encode(decay, forKey: .decay)
        try container.encode(sustain, forKey: .sustain)
        try container.encode(release, forKey: .release)
        try container.encode(filterType, forKey: .filterType)
        try container.encode(filterCutoff, forKey: .filterCutoff)
        try container.encode(filterResonance, forKey: .filterResonance)
        try container.encode(lfoRate, forKey: .lfoRate)
        try container.encode(lfoAmount, forKey: .lfoAmount)
        try container.encode(lfoType, forKey: .lfoType)
    }
}
