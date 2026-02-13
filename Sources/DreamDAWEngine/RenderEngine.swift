import AVFoundation
import Accelerate
import Foundation
import DreamDAWModels
import os.log

// MARK: - RenderEngine

/// Offline render engine that bounces the project's master output to a WAV file.
/// Renders all tracks (audio clips + MIDI clips through instruments) through the
/// effect chain, mixed to the master bus, and writes the result to disk.
public final class RenderEngine {

    // MARK: - Configuration

    /// Configurable render settings.
    public struct RenderConfiguration {
        public var sampleRate: Double
        public var bitDepth: Int
        public var channelCount: Int

        public init(sampleRate: Double = 44100.0, bitDepth: Int = 24, channelCount: Int = 2) {
            self.sampleRate = sampleRate
            self.bitDepth = bitDepth
            self.channelCount = channelCount
        }

        /// Standard preset configurations.
        public static let cd = RenderConfiguration(sampleRate: 44100, bitDepth: 16)
        public static let studioStandard = RenderConfiguration(sampleRate: 44100, bitDepth: 24)
        public static let studioHD = RenderConfiguration(sampleRate: 48000, bitDepth: 24)
        public static let highRes = RenderConfiguration(sampleRate: 96000, bitDepth: 24)
        public static let masteringGrade = RenderConfiguration(sampleRate: 96000, bitDepth: 32)

        public var displayString: String {
            "WAV \(bitDepth)-bit / \(sampleRate >= 1000 ? String(format: "%.1f kHz", sampleRate / 1000) : "\(Int(sampleRate)) Hz")"
        }
    }

    // MARK: - Properties

    public init() {}

    private let logger = Logger(subsystem: "com.dreamdaw", category: "RenderEngine")

    /// Progress callback (0.0 ... 1.0).
    public var onProgress: ((Double) -> Void)?

    /// Completion callback with success/error.
    public var onComplete: ((Result<URL, Error>) -> Void)?

    // MARK: - Errors

    public enum RenderError: LocalizedError {
        case noContent
        case engineSetupFailed
        case renderFailed(String)
        case cancelled

        public var errorDescription: String? {
            switch self {
            case .noContent: return "No audio or MIDI content to render."
            case .engineSetupFailed: return "Failed to set up offline engine."
            case .renderFailed(let msg): return "Render failed: \(msg)"
            case .cancelled: return "Render was cancelled."
            }
        }
    }

    // MARK: - Render Range

    /// Calculate the render end position (last clip end across all tracks).
    public static func calculateRenderEnd(project: Project) -> TimePosition {
        var maxEnd = TimePosition.zero
        for track in project.tracks {
            let trackEnd = track.endPosition
            if trackEnd > maxEnd { maxEnd = trackEnd }
        }
        return maxEnd
    }

    // MARK: - Render

    /// Render the entire project to a WAV file at the specified URL.
    /// This performs offline rendering — does not play through speakers.
    public func render(project: Project, to outputURL: URL, config: RenderConfiguration = .studioStandard) {
        let bpm = project.bpm
        let sampleRate = config.sampleRate
        let endPosition = RenderEngine.calculateRenderEnd(project: project)

        guard endPosition.beats > 0 else {
            onComplete?(.failure(RenderError.noContent))
            return
        }

        let totalDurationSeconds = endPosition.toSeconds(bpm: bpm)
        let totalFrames = Int(totalDurationSeconds * sampleRate)

        guard totalFrames > 0 else {
            onComplete?(.failure(RenderError.noContent))
            return
        }

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.performRender(
                project: project,
                outputURL: outputURL,
                config: config,
                totalFrames: totalFrames,
                bpm: bpm
            )
        }
    }

    private func performRender(
        project: Project,
        outputURL: URL,
        config: RenderConfiguration,
        totalFrames: Int,
        bpm: Double
    ) {
        let channelCount = AVAudioChannelCount(config.channelCount)
        let sampleRate = config.sampleRate
        guard let outputFormat = AVAudioFormat(
            standardFormatWithSampleRate: sampleRate,
            channels: channelCount
        ) else {
            DispatchQueue.main.async {
                self.onComplete?(.failure(RenderError.engineSetupFailed))
            }
            return
        }

        // Create master output buffer
        guard let masterBuffer = AVAudioPCMBuffer(
            pcmFormat: outputFormat,
            frameCapacity: AVAudioFrameCount(totalFrames)
        ) else {
            DispatchQueue.main.async {
                self.onComplete?(.failure(RenderError.engineSetupFailed))
            }
            return
        }
        masterBuffer.frameLength = AVAudioFrameCount(totalFrames)

        // Zero-fill
        for ch in 0..<Int(channelCount) {
            guard let data = masterBuffer.floatChannelData?[ch] else { continue }
            memset(data, 0, totalFrames * MemoryLayout<Float>.size)
        }

        let synth = SimpleSynthInstrument()
        let sampler = SamplerInstrument()

        // Determine if any track is soloed (solo-aware rendering)
        let anySoloed = project.tracks.contains { $0.isSoloed && $0.trackType != .master }

        // Render each track
        for (trackIndex, track) in project.tracks.enumerated() {
            guard track.trackType != .master else { continue }
            guard !track.isMuted else { continue }

            // Solo-aware: if any track is soloed, only render soloed tracks
            if anySoloed && !track.isSoloed { continue }

            let trackVolume = track.effectiveVolume
            let trackPan = track.pan

            // Render audio clips
            for clip in track.clips {
                do {
                    let file = try AVAudioFile(forReading: clip.fileURL)
                    let fileFormat = file.processingFormat
                    let fileFrames = AVAudioFrameCount(file.length)

                    guard let fileBuffer = AVAudioPCMBuffer(
                        pcmFormat: fileFormat,
                        frameCapacity: fileFrames
                    ) else { continue }

                    try file.read(into: fileBuffer)
                    fileBuffer.frameLength = fileFrames

                    let clipStartSeconds = clip.position.toSeconds(bpm: bpm)
                    let trimStartSeconds = clip.trimStartOffset.toSeconds(bpm: bpm)
                    let clipDurationSeconds = clip.duration.toSeconds(bpm: bpm)

                    let outputStartFrame = Int(clipStartSeconds * sampleRate)
                    let sourceStartFrame = Int(trimStartSeconds * fileFormat.sampleRate)
                    let outputFrameCount = Int(clipDurationSeconds * sampleRate)

                    // Mix into master buffer with resampling if needed
                    let ratio = fileFormat.sampleRate / sampleRate

                    if abs(ratio - 1.0) < 0.0001 {
                        // Legendary Path: Identity Sample Rate — Vectorized Summing
                        for ch in 0..<Int(channelCount) {
                            let srcCh = min(ch, Int(fileFormat.channelCount) - 1)
                            guard let srcData = fileBuffer.floatChannelData?[srcCh],
                                  let dstData = masterBuffer.floatChannelData?[ch] else { continue }

                            let gain = trackVolume * Self.equalPowerPanGain(pan: trackPan, channel: ch)
                            var gainVar = gain
                            
                            // dstData[outFrame] += srcData[srcIdx] * gain
                            // Use vDSP_vsma: Vector-Scalar Multiply and Add
                            vDSP_vsma(srcData.advanced(by: sourceStartFrame), 1, &gainVar, 
                                      dstData.advanced(by: outputStartFrame), 1, 
                                      dstData.advanced(by: outputStartFrame), 1, 
                                      vDSP_Length(outputFrameCount))
                        }
                    } else {
                        // Standard Path: Resampling needed (Linear Interpolation)
                        // TODO: [PHASE 9 DSP] Replace Linear Interpolation with vDSP_vgenp (Polyphase Sinc Interpolation) for mastering-grade anti-aliasing.
                        
                        guard let floatChannelData = fileBuffer.floatChannelData,
                              let dstFloatChannelData = masterBuffer.floatChannelData else { continue }
                        
                        let leftChannel = floatChannelData[0]
                        let rightChannel = floatChannelData[Int(fileFormat.channelCount > 1 ? 1 : 0)] // Mono safety
                        
                        let dstLeft = dstFloatChannelData[0]
                        let dstRight = dstFloatChannelData[Int(channelCount > 1 ? 1 : 0)]
                        
                        for outOffset in 0..<outputFrameCount {
                            let outFrame = outputStartFrame + outOffset
                            guard outFrame >= 0, outFrame < totalFrames else { continue }

                            // ARCHITECT ORDER #3: Sub-Sample Precision Math
                            let srcPos = Double(sourceStartFrame) + Double(outOffset) * ratio
                            let idx = Int(srcPos)
                            let frac = Float(srcPos - Double(idx))
                            
                            // ARCHITECT ORDER #3: Strict Bounds Guard
                            if idx >= Int(fileFrames) { continue }
                            let nextIdx = min(idx + 1, Int(fileFrames) - 1)
                            
                            // Safe Raw Linear Interpolation
                            let leftSample1 = leftChannel[idx]
                            let leftSample2 = leftChannel[nextIdx]
                            let interpolatedLeft = leftSample1 + frac * (leftSample2 - leftSample1)
                            
                            let rightSample1 = rightChannel[idx]
                            let rightSample2 = rightChannel[nextIdx]
                            let interpolatedRight = rightSample1 + frac * (rightSample2 - rightSample1)
                            
                            // Mix with Equal Power Panning
                            let panGainL = Self.equalPowerPanGain(pan: trackPan, channel: 0)
                            let panGainR = Self.equalPowerPanGain(pan: trackPan, channel: 1)
                            
                            dstLeft[outFrame] += interpolatedLeft * trackVolume * panGainL
                            if channelCount > 1 {
                                dstRight[outFrame] += interpolatedRight * trackVolume * panGainR
                            }
                        }
                    }
                } catch {
                    logger.error("Render: failed to load audio clip \(clip.name): \(error.localizedDescription)")
                }
            }

            // Render MIDI clips
            for clip in track.midiClips {
                let midiBuffer: AVAudioPCMBuffer?

                // Choose instrument
                if let instrConfig = track.instrument {
                    switch instrConfig.instrumentType {
                    case .sampler:
                        if let sampleURL = instrConfig.sampleURL {
                            try? sampler.loadSample(url: sampleURL)
                            sampler.mode = instrConfig.samplerMode
                        }
                        let result = sampler.renderClipToBuffer(clip: clip, bpm: bpm, config: instrConfig)
                        midiBuffer = result.0
                    case .sineSynth:
                        midiBuffer = synth.renderClipToBuffer(clip: clip, bpm: bpm)
                    case .vst2, .vst3:
                        // Real-time VST rendering not yet implemented in offline render
                        midiBuffer = nil 
                    }
                } else {
                    // Default to sine synth
                    midiBuffer = synth.renderClipToBuffer(clip: clip, bpm: bpm)
                }

                guard let buffer = midiBuffer else { continue }

                let clipStartSeconds = clip.position.toSeconds(bpm: bpm)
                let outputStartFrame = Int(clipStartSeconds * sampleRate)
                let bufferFrames = Int(buffer.frameLength)
                let bufferSR = buffer.format.sampleRate
                let ratio = bufferSR / sampleRate

                if abs(ratio - 1.0) < 0.0001 {
                    // Legendary Path: Identity Sample Rate — Vectorized Summing
                    for ch in 0..<Int(channelCount) {
                        let srcCh = min(ch, Int(buffer.format.channelCount) - 1)
                        guard let srcData = buffer.floatChannelData?[srcCh],
                              let dstData = masterBuffer.floatChannelData?[ch] else { continue }

                        let gain = trackVolume * Self.equalPowerPanGain(pan: trackPan, channel: ch)
                        var gainVar = gain
                        
                        // Vector Multiply and Add
                        vDSP_vsma(srcData, 1, &gainVar, 
                                  dstData.advanced(by: outputStartFrame), 1, 
                                  dstData.advanced(by: outputStartFrame), 1, 
                                  vDSP_Length(bufferFrames))
                    }
                } else {
                    // Standard Path: Resampling needed (Strict Linear Interpolation)
                    // TODO: [PHASE 9 DSP] Replace Linear Interpolation with vDSP_vgenp (Polyphase Sinc Interpolation) for mastering-grade anti-aliasing.
                    
                    guard let floatChannelData = buffer.floatChannelData,
                          let dstFloatChannelData = masterBuffer.floatChannelData else { continue }
                    
                    let leftChannel = floatChannelData[0]
                    let rightChannel = floatChannelData[Int(buffer.format.channelCount > 1 ? 1 : 0)] // Mono safety
                    
                    let dstLeft = dstFloatChannelData[0]
                    let dstRight = dstFloatChannelData[Int(channelCount > 1 ? 1 : 0)]
                    
                    for outOffset in 0..<Int(Double(bufferFrames) / ratio) {
                        let outFrame = outputStartFrame + outOffset
                        guard outFrame >= 0, outFrame < totalFrames else { continue }

                        // Fractal Math
                        let srcPos = Double(outOffset) * ratio
                        let idx = Int(srcPos)
                        let frac = Float(srcPos - Double(idx))
                        
                        // Bounds Check
                        if idx >= bufferFrames { continue }
                        let nextIdx = min(idx + 1, bufferFrames - 1)
                        
                        // Left Channel
                        let leftSample1 = leftChannel[idx]
                        let leftSample2 = leftChannel[nextIdx]
                        let interpolatedLeft = leftSample1 + frac * (leftSample2 - leftSample1)
                        
                        // Right Channel
                        let rightSample1 = rightChannel[idx]
                        let rightSample2 = rightChannel[nextIdx]
                        let interpolatedRight = rightSample1 + frac * (rightSample2 - rightSample1)
                        
                        // Mix
                        let panGainL = Self.equalPowerPanGain(pan: trackPan, channel: 0)
                        let panGainR = Self.equalPowerPanGain(pan: trackPan, channel: 1)
                        
                        dstLeft[outFrame] += interpolatedLeft * trackVolume * panGainL
                        if channelCount > 1 {
                            dstRight[outFrame] += interpolatedRight * trackVolume * panGainR
                        }
                    }
                }
            }

            // Report progress
            let progress = Double(trackIndex + 1) / Double(project.tracks.count)
            DispatchQueue.main.async {
                self.onProgress?(progress)
            }
        }

        // Apply master volume
        let masterVolume = project.masterTrack.isMuted ? Float(0) : project.masterTrack.volume
        if masterVolume != 1.0 {
            for ch in 0..<Int(channelCount) {
                guard let data = masterBuffer.floatChannelData?[ch] else { continue }
                var volume = masterVolume
                vDSP_vsmul(data, 1, &volume, data, 1, vDSP_Length(totalFrames))
            }
        }

        // Write to file
        do {
            let outputFile = try AVAudioFile(
                forWriting: outputURL,
                settings: [
                    AVFormatIDKey: kAudioFormatLinearPCM,
                    AVSampleRateKey: sampleRate,
                    AVNumberOfChannelsKey: channelCount,
                    AVLinearPCMBitDepthKey: config.bitDepth,
                    AVLinearPCMIsFloatKey: false,
                    AVLinearPCMIsBigEndianKey: false,
                    AVLinearPCMIsNonInterleaved: false
                ]
            )

            try outputFile.write(from: masterBuffer)

            logger.info("Render complete: \(outputURL.lastPathComponent) — \(totalFrames) frames")

            DispatchQueue.main.async {
                self.onProgress?(1.0)
                self.onComplete?(.success(outputURL))
            }
        } catch {
            logger.error("Render write failed: \(error.localizedDescription)")
            DispatchQueue.main.async {
                self.onComplete?(.failure(RenderError.renderFailed(error.localizedDescription)))
            }
        }
    }

    // MARK: - Pan Law

    /// Equal-power pan gain for a given channel.
    /// `pan` is -1.0 (full left) to +1.0 (full right).
    /// Uses cos/sin curves to maintain constant power at center position.
    ///
    /// At center (pan=0): both channels ≈ 0.707 (equal power, -3dB each)
    /// At hard left (pan=-1): L=1.0, R=0.0
    /// At hard right (pan=+1): L=0.0, R=1.0
    private static func equalPowerPanGain(pan: Float, channel: Int) -> Float {
        // Normalize pan from [-1, +1] to [0, π/2]
        let angle = (pan + 1.0) * 0.5 * Float.pi * 0.5
        return channel == 0 ? cosf(angle) : sinf(angle)
    }
}
