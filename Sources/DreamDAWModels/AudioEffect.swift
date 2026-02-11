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

    public init(
        id: UUID = UUID(),
        instrumentType: InstrumentType = .sineSynth,
        isEnabled: Bool = true,
        sampleURL: URL? = nil,
        samplerMode: SamplerMode = .oneShot
    ) {
        self.id = id
        self.instrumentType = instrumentType
        self.isEnabled = isEnabled
        self.sampleURL = sampleURL
        self.samplerMode = samplerMode
    }

    // MARK: - Codable

    private enum CodingKeys: String, CodingKey {
        case id, instrumentType, isEnabled, sampleURL, samplerMode
    }

    public convenience init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try container.decode(UUID.self, forKey: .id),
            instrumentType: try container.decode(InstrumentType.self, forKey: .instrumentType),
            isEnabled: try container.decode(Bool.self, forKey: .isEnabled),
            sampleURL: try container.decodeIfPresent(URL.self, forKey: .sampleURL),
            samplerMode: try container.decodeIfPresent(SamplerMode.self, forKey: .samplerMode) ?? .oneShot
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(instrumentType, forKey: .instrumentType)
        try container.encode(isEnabled, forKey: .isEnabled)
        try container.encodeIfPresent(sampleURL, forKey: .sampleURL)
        try container.encode(samplerMode, forKey: .samplerMode)
    }
}
