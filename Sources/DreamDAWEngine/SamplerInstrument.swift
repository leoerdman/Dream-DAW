import AVFoundation
import Foundation
import DreamDAWModels
import os.log

// MARK: - SamplerInstrument

/// MIDI instrument that plays an audio sample triggered by MIDI notes.
/// Supports two modes:
/// - **oneShot**: Plays the full sample regardless of note duration.
/// - **loop**: Loops the sample for the duration of the MIDI note.
///
/// Renders MIDI clips to PCM buffers offline for scheduling.
public final class SamplerInstrument {

    // MARK: - Properties

    private let logger = Logger(subsystem: "com.dreamdaw", category: "SamplerInstrument")

    /// The loaded sample buffer (mono or stereo PCM float).
    private var sampleBuffer: AVAudioPCMBuffer?

    /// The sample file's format.
    private var sampleFormat: AVAudioFormat?

    /// The sample file's native sample rate.
    private var sampleRate: Double = 44100.0

    /// Playback mode.
    public var mode: SamplerMode = .oneShot

    /// The base MIDI note number for the loaded sample (default: C3 = 60).
    public var rootNote: UInt8 = 60

    // MARK: - Sample Loading

    /// Load an audio file as the sample source.
    public func loadSample(url: URL) throws {
        let file = try AVAudioFile(forReading: url)
        let format = file.processingFormat
        let frameCount = AVAudioFrameCount(file.length)

        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else {
            logger.error("Failed to create buffer for sample: \(url.lastPathComponent)")
            return
        }

        try file.read(into: buffer)
        buffer.frameLength = frameCount

        self.sampleBuffer = buffer
        self.sampleFormat = format
        self.sampleRate = format.sampleRate

        logger.info("Loaded sample: \(url.lastPathComponent) — \(frameCount) frames, \(format.sampleRate) Hz, \(format.channelCount) ch")
    }

    /// Whether a sample is currently loaded.
    public var isSampleLoaded: Bool {
        sampleBuffer != nil
    }

    /// Render a MIDI clip to a PCM buffer using this sampler.
    /// Each note triggers the sample at a pitch determined by the MIDI note vs rootNote.
    public func renderClipToBuffer(clip: MidiClip, bpm: Double, config: InstrumentConfig) -> AVAudioPCMBuffer? {
        guard let sampleBuffer = sampleBuffer, let sampleFormat = sampleFormat else {
            logger.warning("No sample loaded for sampler rendering")
            return nil
        }
        
        // Update local state from config
        self.mode = config.samplerMode

        let outputSampleRate = sampleFormat.sampleRate
        let clipDurationSeconds = clip.duration.toSeconds(bpm: bpm)
        let totalFrames = AVAudioFrameCount(clipDurationSeconds * outputSampleRate)

        guard totalFrames > 0 else { return nil }

        let outputFormat = AVAudioFormat(
            standardFormatWithSampleRate: outputSampleRate,
            channels: sampleFormat.channelCount
        )!

        guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: totalFrames) else {
            return nil
        }
        outputBuffer.frameLength = totalFrames

        // Zero fill
        for ch in 0..<Int(outputFormat.channelCount) {
            guard let data = outputBuffer.floatChannelData?[ch] else { continue }
            memset(data, 0, Int(totalFrames) * MemoryLayout<Float>.size)
        }

        // Render each note
        for note in clip.notes {
            let noteStartSeconds = note.position.toSeconds(bpm: bpm)
            let noteDurationSeconds = note.duration.toSeconds(bpm: bpm)

            let startFrame = AVAudioFramePosition(noteStartSeconds * outputSampleRate)
            guard startFrame < AVAudioFramePosition(totalFrames) else { continue }

            // ─── Offset / Length Calculation ───
            let sampleFrames = Double(sampleBuffer.frameLength)
            let startFrameOffset = Double(config.startPercent / 100.0) * sampleFrames
            let endFrameOffset = Double(config.endPercent / 100.0) * sampleFrames
            let effectiveSampleFrames = max(1.0, endFrameOffset - startFrameOffset)

            // Pitch shift ratio: semitone difference from root note
            let semitoneDiff = Double(note.pitch) - Double(rootNote)
            let pitchRatio = pow(2.0, semitoneDiff / 12.0)

            // Calculate how many output frames this note occupies
            let outputFramesForSample: Int = Int(effectiveSampleFrames / pitchRatio)
            let maxOutputFrames: Int
            switch mode {
            case .oneShot:
                // Play full sample (mapped to start/end)
                maxOutputFrames = outputFramesForSample
            case .loop:
                // Loop for note duration
                maxOutputFrames = Int(noteDurationSeconds * outputSampleRate)
            }

            let velocity = Float(note.velocity) / 127.0
            
            // ─── ADSR Setup ───
            let attackFrames = config.attack * outputSampleRate
            let decayFrames = config.decay * outputSampleRate
            let releaseFrames = config.release * outputSampleRate
            
            for outputOffset in 0..<maxOutputFrames {
                let outputFrame = Int(startFrame) + outputOffset
                guard outputFrame >= 0, outputFrame < Int(totalFrames) else { continue }

                // ─── Envelope Calculation ───
                var env: Double = 1.0
                let t = Double(outputOffset)
                
                if t < attackFrames {
                    env = t / attackFrames
                } else if t < attackFrames + decayFrames {
                    env = 1.0 - (1.0 - config.sustain) * ((t - attackFrames) / decayFrames)
                } else {
                    env = config.sustain
                }
                
                // Release: In this simple linear renderer, we'll just fade out at the end of maxOutputFrames
                // if it's oneShot or at the end of note duration.
                let framesRemaining = Double(maxOutputFrames - outputOffset)
                if framesRemaining < releaseFrames {
                    env *= (framesRemaining / releaseFrames)
                }

                // ─── Source position with pitch ratio ───
                var sourcePos = startFrameOffset + (Double(outputOffset) * pitchRatio)

                // Handle looping
                if mode == .loop {
                    let loopRange = effectiveSampleFrames
                    let relativePos = (Double(outputOffset) * pitchRatio).truncatingRemainder(dividingBy: loopRange)
                    sourcePos = startFrameOffset + relativePos
                } else {
                    if sourcePos >= endFrameOffset { break }
                }

                // Linear interpolation
                let srcIdx = Int(sourcePos)
                let frac = Float(sourcePos - Double(srcIdx))
                let idx0 = Int(srcIdx) % Int(sampleFrames)
                let idx1 = (Int(srcIdx) + 1) % Int(sampleFrames)

                for ch in 0..<Int(sampleFormat.channelCount) {
                    guard let srcData = sampleBuffer.floatChannelData?[ch],
                          let dstData = outputBuffer.floatChannelData?[ch] else { continue }

                    let s0 = srcData[idx0]
                    let s1 = srcData[idx1]
                    let interpolated = s0 * (1.0 - frac) + s1 * frac
                    let sample = interpolated * velocity * config.gain * Float(env)

                    dstData[outputFrame] += sample
                }
            }
        }

        return outputBuffer
    }
}
