import AVFoundation
import Foundation
import DreamDAWModels
import os.log

// MARK: - SamplerInstrument

/// MIDI instrument that plays an audio sample triggered by MIDI notes.
public final class SamplerInstrument {

    // MARK: - Types
    
    /// Internal voice for polyphonic playback.
    private final class Voice {
        var pitch: Int
        var velocity: Float
        var currentFrame: Double
        var isReleasing: Bool = false
        var releaseFrame: Double = 0
        var phase: Double = 0 // For looping or multi-sample logic
        
        init(pitch: Int, velocity: Float, currentFrame: Double) {
            self.pitch = pitch
            self.velocity = velocity
            self.currentFrame = currentFrame
        }
    }

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
    
    /// Real-time voice state
    private var activeVoices: [Voice] = []
    private var voiceLock = os_unfair_lock_s()
    
    // Configurable parameters (mirrored from InstrumentConfig)
    public var gain: Float = 1.0
    public var attack: Double = 0.001
    public var decay: Double = 0.6
    public var sustain: Double = 1.0
    public var release: Double = 0.05
    public var startPercent: Double = 0.0
    public var endPercent: Double = 100.0

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

    // MARK: - Real-time Control
    
    public func noteOn(pitch: Int, velocity: Int) {
        os_unfair_lock_lock(&voiceLock)
        defer { os_unfair_lock_unlock(&voiceLock) }
        
        // Remove existing voice with same pitch if any (mono-per-pitch)
        activeVoices.removeAll { $0.pitch == pitch }
        
        let sampleFrames = Double(sampleBuffer?.frameLength ?? 0)
        let startFrame = (startPercent / 100.0) * sampleFrames
        
        activeVoices.append(Voice(
            pitch: pitch,
            velocity: Float(velocity) / 127.0,
            currentFrame: startFrame
        ))
    }
    
    public func noteOff(pitch: Int) {
        os_unfair_lock_lock(&voiceLock)
        defer { os_unfair_lock_unlock(&voiceLock) }
        
        for i in 0..<activeVoices.count {
            if activeVoices[i].pitch == pitch && !activeVoices[i].isReleasing {
                activeVoices[i].isReleasing = true
                activeVoices[i].releaseFrame = 0 // Start release from 0
            }
        }
    }
    
    public func allNotesOff() {
        os_unfair_lock_lock(&voiceLock)
        activeVoices.removeAll()
        os_unfair_lock_unlock(&voiceLock)
    }

    // MARK: - Real-time Rendering
    
    public func createSourceNode() -> AVAudioSourceNode {
        return AVAudioSourceNode { [weak self] _, _, frameCount, audioBufferList -> OSStatus in
            guard let self = self, let sampleBuffer = self.sampleBuffer else { return noErr }
            
            let ablPointer = UnsafeMutableAudioBufferListPointer(audioBufferList)
            let outChannels = ablPointer.count
            let outFrames = Int(frameCount)
            let sr = self.sampleRate
            
            // Mirror parameters for this block to avoid lock contention for every frame
            // In a pro engine these would be atomic or dual-buffered.
            let gain = self.gain
            let attackF = self.attack * sr
            let decayF = self.decay * sr
            let releaseF = self.release * sr
            let sustain = self.sustain
            let mode = self.mode
            let root = Double(self.rootNote)
            let sampleFrames = Double(sampleBuffer.frameLength)
            let startF = (self.startPercent / 100.0) * sampleFrames
            let endF = (self.endPercent / 100.0) * sampleFrames
            
            os_unfair_lock_lock(&self.voiceLock)
            var currentVoices = self.activeVoices
            os_unfair_lock_unlock(&self.voiceLock)
            
            // Performance: only process if there are voices
            if currentVoices.isEmpty {
                for ch in 0..<outChannels {
                    memset(ablPointer[ch].mData, 0, outFrames * MemoryLayout<Float>.size)
                }
                return noErr
            }

            for f in 0..<outFrames {
                var mixL: Float = 0
                var mixR: Float = 0
                
                var i = 0
                while i < currentVoices.count {
                    let voice = currentVoices[i]
                    
                    // Pitch Calculation
                    let semitoneDiff = Double(voice.pitch) - root
                    let pitchRatio = pow(2.0, semitoneDiff / 12.0)
                    
                    // Envelope logic
                    var env: Double = 1.0
                    let t = voice.currentFrame - startF
                    
                    if !voice.isReleasing {
                        if t < attackF {
                            env = t / attackF
                        } else if t < attackF + decayF {
                            env = 1.0 - (1.0 - sustain) * ((t - attackF) / decayF)
                        } else {
                            env = sustain
                        }
                    } else {
                        // Release phase
                        let rt = voice.releaseFrame
                        env = sustain * (1.0 - (rt / releaseF))
                        if env <= 0 {
                            currentVoices.remove(at: i)
                            continue
                        }
                        currentVoices[i].releaseFrame += 1.0
                    }
                    
                    // Sample Reading with interpolation
                    let pos = voice.currentFrame
                    let idx0 = Int(pos)
                    let frac = Float(pos - Double(idx0))
                    let idx1 = (idx0 + 1) % Int(sampleFrames)
                    
                    let s0_L = sampleBuffer.floatChannelData?[0][idx0] ?? 0
                    let s1_L = sampleBuffer.floatChannelData?[0][idx1] ?? 0
                    let interpL = s0_L * (1.0 - frac) + s1_L * frac
                    
                    let vGain = voice.velocity * gain * Float(env)
                    mixL += interpL * vGain
                    
                    if sampleBuffer.format.channelCount > 1 {
                        let s0_R = sampleBuffer.floatChannelData?[1][idx0] ?? 0
                        let s1_R = sampleBuffer.floatChannelData?[1][idx1] ?? 0
                        let interpR = s0_R * (1.0 - frac) + s1_R * frac
                        mixR += interpR * vGain
                    } else {
                        mixR += interpL * vGain
                    }
                    
                    // Advance pos
                    currentVoices[i].currentFrame += pitchRatio
                    
                    // Bounds / Mode handling
                    if currentVoices[i].currentFrame >= endF {
                        if mode == .loop {
                            currentVoices[i].currentFrame = startF + (currentVoices[i].currentFrame - endF)
                        } else {
                            currentVoices.remove(at: i)
                            continue 
                        }
                    }
                    
                    i += 1
                }
                
                // Write to buffers
                if outChannels > 0 {
                    let ptrL = ablPointer[0].mData!.assumingMemoryBound(to: Float.self)
                    ptrL[f] = mixL
                }
                if outChannels > 1 {
                    let ptrR = ablPointer[1].mData!.assumingMemoryBound(to: Float.self)
                    ptrR[f] = mixR
                }
            }
            
            // Sync back voices
            os_unfair_lock_lock(&self.voiceLock)
            self.activeVoices = currentVoices
            os_unfair_lock_unlock(&self.voiceLock)
            
            return noErr
        }
    }

    // MARK: - Offline Rendering

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
