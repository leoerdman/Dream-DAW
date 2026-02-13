import AVFoundation
import Foundation
import DreamDAWModels
import os.log

// MARK: - ParametricEQ

/// 8-band parametric EQ using AVAudioUnitEQ.
/// Each band can be configured as: Low Cut, Low Shelf, Parametric, High Shelf, High Cut.
/// This is a real-time audio processing unit that inserts into the audio graph.
public final class ParametricEQ {

    // MARK: - Properties

    private let logger = Logger(subsystem: "com.dreamdaw", category: "ParametricEQ")

    /// The AVAudioUnitEQ node (8 bands).
    public let eqNode: AVAudioUnitEQ

    /// Number of EQ bands.
    public static let bandCount = 8

    // MARK: - Initialization

    public init() {
        self.eqNode = AVAudioUnitEQ(numberOfBands: ParametricEQ.bandCount)

        // Set default global gain to unity
        eqNode.globalGain = 0.0

        // Initialize all bands with sensible defaults
        let defaultFreqs: [Float] = [30, 100, 250, 500, 1000, 2500, 6000, 16000]
        for i in 0..<ParametricEQ.bandCount {
            let band = eqNode.bands[i]
            band.frequency = defaultFreqs[i]
            band.gain = 0.0
            band.bandwidth = 1.0
            band.bypass = true
            band.filterType = i == 0 ? .highPass : (i == ParametricEQ.bandCount - 1 ? .lowPass : .parametric)
        }

        logger.info("ParametricEQ initialized with \(ParametricEQ.bandCount) bands")
    }

    // MARK: - Configuration

    /// Apply a full EQ configuration from model.
    public func applyConfig(_ bands: [EQBandConfig]) {
        for (i, config) in bands.enumerated() {
            guard i < ParametricEQ.bandCount else { break }
            applyBand(index: i, config: config)
        }
    }

    /// Apply a single band configuration.
    public func applyBand(index: Int, config: EQBandConfig) {
        guard index >= 0, index < ParametricEQ.bandCount else { return }

        let band = eqNode.bands[index]
        band.frequency = config.frequency
        band.gain = config.gain
        band.bandwidth = config.bandwidth
        band.bypass = !config.isEnabled
        band.filterType = mapFilterType(config.filterType)
    }

    /// Update a single parameter on a specific band.
    public func setBandFrequency(_ index: Int, frequency: Float) {
        guard index >= 0, index < ParametricEQ.bandCount else { return }
        eqNode.bands[index].frequency = frequency
    }

    public func setBandGain(_ index: Int, gain: Float) {
        guard index >= 0, index < ParametricEQ.bandCount else { return }
        eqNode.bands[index].gain = gain
    }

    public func setBandBandwidth(_ index: Int, bandwidth: Float) {
        guard index >= 0, index < ParametricEQ.bandCount else { return }
        eqNode.bands[index].bandwidth = bandwidth
    }

    public func setBandEnabled(_ index: Int, enabled: Bool) {
        guard index >= 0, index < ParametricEQ.bandCount else { return }
        eqNode.bands[index].bypass = !enabled
    }

    /// Set global output gain.
    public func setGlobalGain(_ gain: Float) {
        eqNode.globalGain = gain
    }

    // MARK: - Helpers

    private func mapFilterType(_ type: EQFilterType) -> AVAudioUnitEQFilterType {
        switch type {
        case .lowCut:     return .highPass
        case .lowShelf:   return .lowShelf
        case .parametric: return .parametric
        case .highShelf:  return .highShelf
        case .highCut:    return .lowPass
        }
    }
}
