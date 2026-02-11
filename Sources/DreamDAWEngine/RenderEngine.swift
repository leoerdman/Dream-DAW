import AVFoundation
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

        // Render each track
        for (trackIndex, track) in project.tracks.enumerated() {
            guard track.trackType != .master else { continue }
            guard !track.isMuted else { continue }

            let trackVolume = track.volume
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

                    for outOffset in 0..<outputFrameCount {
                        let outFrame = outputStartFrame + outOffset
                        guard outFrame >= 0, outFrame < totalFrames else { continue }

                        let srcPos = Double(sourceStartFrame) + Double(outOffset) * ratio
                        let srcIdx = Int(srcPos)
                        guard srcIdx >= 0, srcIdx < Int(fileFrames) else { continue }

                        for ch in 0..<Int(channelCount) {
                            let srcCh = min(ch, Int(fileFormat.channelCount) - 1)
                            guard let srcData = fileBuffer.floatChannelData?[srcCh],
                                  let dstData = masterBuffer.floatChannelData?[ch] else { continue }

                            let panGain: Float = ch == 0 ? min(1.0, 1.0 - trackPan) : min(1.0, 1.0 + trackPan)
                            dstData[outFrame] += srcData[srcIdx] * trackVolume * panGain
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
                        midiBuffer = sampler.renderClipToBuffer(clip: clip, bpm: bpm)
                    case .sineSynth:
                        midiBuffer = synth.renderClipToBuffer(clip: clip, bpm: bpm)
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

                for outOffset in 0..<Int(Double(bufferFrames) / ratio) {
                    let outFrame = outputStartFrame + outOffset
                    guard outFrame >= 0, outFrame < totalFrames else { continue }

                    let srcIdx = Int(Double(outOffset) * ratio)
                    guard srcIdx >= 0, srcIdx < bufferFrames else { continue }

                    for ch in 0..<Int(channelCount) {
                        let srcCh = min(ch, Int(buffer.format.channelCount) - 1)
                        guard let srcData = buffer.floatChannelData?[srcCh],
                              let dstData = masterBuffer.floatChannelData?[ch] else { continue }

                        let panGain: Float = ch == 0 ? min(1.0, 1.0 - trackPan) : min(1.0, 1.0 + trackPan)
                        dstData[outFrame] += srcData[srcIdx] * trackVolume * panGain
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
                for i in 0..<totalFrames {
                    data[i] *= masterVolume
                }
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
}
