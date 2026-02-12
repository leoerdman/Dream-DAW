import AVFoundation
import Foundation
import Accelerate
import DreamDAWModels
import os.log

// MARK: - SamplerInstrument

/// MIDI instrument that plays an audio sample triggered by MIDI notes.
public final class SamplerInstrument {

    // MARK: - Types
    
    /// Internal voice for polyphonic playback with D-Stream support.
    private final class Voice {
        var pitch: Int
        var velocity: Float
        var currentFrame: Double
        var isReleasing: Bool = false
        var releaseFrame: Double = 0
        
        /// Buffered tile from disk (if streaming)
        var currentTile: AVAudioPCMBuffer?
        var tileStartFrame: AVAudioFramePosition = 0
        
        // Filter state (SVF)
        var ic1eq_L: Float = 0
        var ic2eq_L: Float = 0
        var ic1eq_R: Float = 0
        var ic2eq_R: Float = 0
        
        init(pitch: Int, velocity: Float, currentFrame: Double) {
            self.pitch = pitch
            self.velocity = velocity
            self.currentFrame = currentFrame
        }
    }

    // MARK: - Properties

    private let logger = Logger(subsystem: "com.dreamdaw", category: "SamplerInstrument")

    /// The 'Header' buffer (first part of sample loaded in RAM for instant trigger).
    private var headBuffer: AVAudioPCMBuffer?
    private var sampleURL: URL?

    /// The sample file's format.
    private var sampleFormat: AVAudioFormat?

    /// The sample file's native sample rate.
    private var sampleRate: Double = 44100.0
    
    /// Total frames in the audio file.
    private var totalFrames: AVAudioFramePosition = 0

    /// Playback mode.
    public var mode: SamplerMode = .oneShot

    /// The base MIDI note number for the loaded sample (default: C3 = 60).
    public var rootNote: UInt8 = 60
    
    /// Real-time voice state
    private var activeVoices: [Voice] = []
    
    /// Lock-Free command queue for real-time thread
    private let commandQueue = SPSCRingBuffer<AudioCommand>(requestedCapacity: 128)
    
    // Configurable parameters (Internal copies for real-time thread)
    private var _gain: Float = 1.0
    private var _attack: Double = 0.001
    private var _decay: Double = 0.6
    private var _sustain: Double = 1.0
    private var _release: Double = 0.05
    private var _startPercent: Double = 0.0
    private var _endPercent: Double = 100.0
    private var _fadePercent: Double = 0.0
    private var _filterEnabled: Bool = false
    private var _filterCutoff: Double = 22000.0
    private var _filterResonance: Double = 0.0
    
    // State for sample-accurate smoothing
    private var _lastGain: Float = 1.0
    private var _lastCutoff: Double = 22000.0

    // Public properties push commands to the queue
    public var gain: Float {
        get { _gain }
        set { _ = commandQueue.push(.parameterChange(id: "gain", value: newValue)) }
    }
    public var attack: Double {
        get { _attack }
        set { _ = commandQueue.push(.parameterChange(id: "attack", value: Float(newValue))) }
    }
    public var decay: Double {
        get { _decay }
        set { _ = commandQueue.push(.parameterChange(id: "decay", value: Float(newValue))) }
    }
    public var sustain: Double {
        get { _sustain }
        set { _ = commandQueue.push(.parameterChange(id: "sustain", value: Float(newValue))) }
    }
    public var release: Double {
        get { _release }
        set { _ = commandQueue.push(.parameterChange(id: "release", value: Float(newValue))) }
    }
    public var startPercent: Double {
        get { _startPercent }
        set { _ = commandQueue.push(.parameterChange(id: "startPercent", value: Float(newValue))) }
    }
    public var endPercent: Double {
        get { _endPercent }
        set { _ = commandQueue.push(.parameterChange(id: "endPercent", value: Float(newValue))) }
    }
    public var fadePercent: Double {
        get { _fadePercent }
        set { _ = commandQueue.push(.parameterChange(id: "fadePercent", value: Float(newValue))) }
    }
    public var filterEnabled: Bool {
        get { _filterEnabled }
        set { _ = commandQueue.push(.parameterChange(id: "filterEnabled", value: newValue ? 1 : 0)) }
    }
    public var filterCutoff: Double {
        get { _filterCutoff }
        set { _ = commandQueue.push(.parameterChange(id: "filterCutoff", value: Float(newValue))) }
    }
    public var filterResonance: Double {
        get { _filterResonance }
        set { _ = commandQueue.push(.parameterChange(id: "filterResonance", value: Float(newValue))) }
    }

    // MARK: - Sample Loading

    /// Load an audio file for D-Stream playback.
    public func loadSample(url: URL) throws {
        // We use TileEngine to prepare the sample (loads the header)
        guard let result = TileEngine.shared.prepare(url: url) else {
            throw NSError(domain: "SamplerInstrument", code: -1, userInfo: [NSLocalizedDescriptionKey: "Failed to prepare sample for streaming"])
        }

        self.headBuffer = result.header
        self.totalFrames = result.totalFrames
        self.sampleURL = url
        self.sampleFormat = result.header.format
        self.sampleRate = result.header.format.sampleRate

        logger.info("D-Stream: Prepared \(url.lastPathComponent) — \(self.totalFrames) total frames, header in RAM.")
    }

    /// Whether a sample is prepared for streaming.
    public var isSampleLoaded: Bool {
        headBuffer != nil
    }

    // MARK: - Real-time Control
    
    public func noteOn(pitch: Int, velocity: Int) {
        _ = commandQueue.push(.noteOn(pitch: pitch, velocity: velocity))
    }
    
    public func noteOff(pitch: Int) {
        _ = commandQueue.push(.noteOff(pitch: pitch))
    }
    
    public func allNotesOff() {
        _ = commandQueue.push(.allNotesOff)
    }

    // MARK: - Real-time Rendering
    
    public func createSourceNode() -> AVAudioSourceNode {
        return AVAudioSourceNode { [weak self] _, _, frameCount, audioBufferList -> OSStatus in
            guard let self = self, let head = self.headBuffer else { return noErr }
            
            // 1. PROCESS COMMANDS (LOCK-FREE)
            while let command = self.commandQueue.pop() {
                switch command {
                case .noteOn(let pitch, let velocity):
                    self.activeVoices.removeAll { $0.pitch == pitch }
                    let startFrame = (self._startPercent / 100.0) * Double(self.totalFrames)
                    self.activeVoices.append(Voice(pitch: pitch, velocity: Float(velocity) / 127.0, currentFrame: startFrame))
                case .noteOff(let pitch):
                    if self.mode == .oneShot { break }
                    for i in 0..<self.activeVoices.count {
                        if self.activeVoices[i].pitch == pitch && !self.activeVoices[i].isReleasing {
                            self.activeVoices[i].isReleasing = true
                            self.activeVoices[i].releaseFrame = 0
                        }
                    }
                case .allNotesOff:
                    self.activeVoices.removeAll()
                case .parameterChange(let id, let value):
                    switch id {
                    case "gain": self._gain = value
                    case "attack": self._attack = Double(value)
                    case "decay": self._decay = Double(value)
                    case "sustain": self._sustain = Double(value)
                    case "release": self._release = Double(value)
                    case "startPercent": self._startPercent = Double(value)
                    case "endPercent": self._endPercent = Double(value)
                    case "fadePercent": self._fadePercent = Double(value)
                    case "filterEnabled": self._filterEnabled = value > 0.5
                    case "filterCutoff": self._filterCutoff = Double(value)
                    case "filterResonance": self._filterResonance = Double(value)
                    default: break
                    }
                case .automationUpdate: break
                }
            }
            
            let ablPointer = UnsafeMutableAudioBufferListPointer(audioBufferList)
            let outChannels = ablPointer.count
            let outFrames = Int(frameCount)
            let sr = self.sampleRate
            
            // Cache current parameters (Target Values)
            let targetGain = self._gain
            let targetCutoff = max(20.0, min(self._filterCutoff, sr * 0.49))
            
            // Smoothing Logic: 
            // We'll ramp from our internal state to the target value over this block.
            // This is the foundation for Sample-Accurate Automation.
            let gainStep = (targetGain - self._lastGain) / Float(outFrames)
            let cutoffStep = (targetCutoff - self._lastCutoff) / Double(outFrames)
            
            let attackF = self._attack * sr
            let decayF = self._decay * sr
            let releaseF = self._release * sr
            let sustain = self._sustain
            let mode = self.mode
            let root = Double(self.rootNote)
            let totalFrames = Double(self.totalFrames)
            let startF = (self._startPercent / 100.0) * totalFrames
            let endF = (self._endPercent / 100.0) * totalFrames
            
            // Filter Resonance (Block-accurate for now)
            let resonance = max(0.0, min(self._filterResonance, 0.99))
            let k = Float(2.0 * (1.0 - resonance))

            if self.activeVoices.isEmpty {
                self._lastGain = targetGain
                self._lastCutoff = targetCutoff
                for ch in 0..<outChannels { memset(ablPointer[ch].mData, 0, outFrames * MemoryLayout<Float>.size) }
                return noErr
            }

            // 2. MIX VOICES (D-STREAM + SAMPLE-ACCURATE AUTOMATION)
            var accumL = [Float](repeating: 0, count: outFrames)
            var accumR = [Float](repeating: 0, count: outFrames)

            for f in 0..<outFrames {
                // Interpolate parameters
                let currentGain = self._lastGain + gainStep * Float(f)
                let currentCutoff = self._lastCutoff + cutoffStep * Double(f)
                
                // Pre-calculate SVF for this sample (Sample-Accurate Filter!)
                let g = Float(tan(Double.pi * currentCutoff / sr))
                let a1 = 1.0 / (1.0 + g * (g + k)), a2 = g * a1, a3 = g * a2

                var mixL: Float = 0, mixR: Float = 0
                var i = 0
                while i < self.activeVoices.count {
                    let voice = self.activeVoices[i]
                    let pitchRatio = pow(2.0, (Double(voice.pitch) - root) / 12.0)
                    
                    var env: Double = 1.0
                    let t = voice.currentFrame - startF
                    if !voice.isReleasing {
                        if t < attackF { env = t / attackF }
                        else if t < attackF + decayF { env = 1.0 - (1.0 - sustain) * ((t - attackF) / decayF) }
                        else { env = sustain }
                    } else {
                        env = sustain * (1.0 - (voice.releaseFrame / releaseF))
                        if env <= 0 { self.activeVoices.remove(at: i); continue }
                        self.activeVoices[i].releaseFrame += 1.0
                    }
                    
                    let pos = voice.currentFrame
                    var s0_L: Float = 0, s1_L: Float = 0, s0_R: Float = 0, s1_R: Float = 0
                    
                    if pos < Double(head.frameLength - 1) {
                        let idx0 = Int(pos)
                        s0_L = head.floatChannelData?[0][idx0] ?? 0
                        s1_L = head.floatChannelData?[0][idx0 + 1] ?? 0
                        if head.format.channelCount > 1 {
                            s0_R = head.floatChannelData?[1][idx0] ?? 0
                            s1_R = head.floatChannelData?[1][idx0 + 1] ?? 0
                        } else { s0_R = s0_L; s1_R = s1_L }
                    } else if let tile = voice.currentTile, pos >= Double(voice.tileStartFrame), pos < Double(voice.tileStartFrame + Int64(tile.frameLength) - 1) {
                        let relPos = pos - Double(voice.tileStartFrame)
                        let idx0 = Int(relPos)
                        s0_L = tile.floatChannelData?[0][idx0] ?? 0
                        s1_L = tile.floatChannelData?[0][idx0 + 1] ?? 0
                        if tile.format.channelCount > 1 {
                            s0_R = tile.floatChannelData?[1][idx0] ?? 0
                            s1_R = tile.floatChannelData?[1][idx0 + 1] ?? 0
                        } else { s0_R = s0_L; s1_R = s1_L }
                    } else if let url = self.sampleURL {
                        if let newTile = TileEngine.shared.loadTile(url: url, startFrame: Int64(pos), count: TileEngine.shared.tileSize) {
                            voice.currentTile = newTile
                            voice.tileStartFrame = Int64(pos)
                        }
                    }
                    
                    let frac = Float(pos - floor(pos))
                    let interpL = s0_L * (1.0 - frac) + s1_L * frac
                    let interpR = s0_R * (1.0 - frac) + s1_R * frac
                    let vGain = voice.velocity * Float(env)
                    
                    var ramp: Float = 1.0
                    let fadeFrames = max(10, (self._fadePercent / 100.0) * (endF - startF))
                    if t < fadeFrames { ramp *= Float(t / fadeFrames) }
                    let tFromEnd = endF - voice.currentFrame
                    if tFromEnd < fadeFrames { ramp *= Float(max(0, tFromEnd / fadeFrames)) }
                    
                    let finalGain = vGain * ramp // Note: Master Gain applied later via vDSP
                    
                    if self._filterEnabled {
                        let v3L = interpL - voice.ic2eq_L
                        let v1L = a1 * voice.ic1eq_L + a2 * v3L
                        let v2L = voice.ic2eq_L + a2 * voice.ic1eq_L + a3 * v3L
                        voice.ic1eq_L = 2.0 * v1L - voice.ic1eq_L; voice.ic2eq_L = 2.0 * v2L - voice.ic2eq_L
                        mixL += v2L * finalGain
                        
                        let v3R = interpR - voice.ic2eq_R
                        let v1R = a1 * voice.ic1eq_R + a2 * v3R
                        let v2R = voice.ic2eq_R + a2 * voice.ic1eq_R + a3 * v3R
                        voice.ic1eq_R = 2.0 * v1R - voice.ic1eq_R; voice.ic2eq_R = 2.0 * v2R - voice.ic2eq_R
                        mixR += v2R * finalGain
                    } else {
                        mixL += interpL * finalGain
                        mixR += interpR * finalGain
                    }
                    
                    self.activeVoices[i].currentFrame += pitchRatio
                    if self.activeVoices[i].currentFrame >= endF {
                        if mode == .classic { self.activeVoices[i].currentFrame = startF + (self.activeVoices[i].currentFrame - endF) }
                        else { self.activeVoices.remove(at: i); continue }
                    }
                    i += 1
                }
                accumL[f] = mixL
                accumR[f] = mixR
            }

            // Sync back last values for continuity
            self._lastGain = targetGain
            self._lastCutoff = targetCutoff

            // 3. SIMD GAIN & OUTPUT
            if outChannels > 0 { vDSP_vsmul(accumL, 1, [targetGain], ablPointer[0].mData!.assumingMemoryBound(to: Float.self), 1, vDSP_Length(outFrames)) }
            if outChannels > 1 { vDSP_vsmul(accumR, 1, [targetGain], ablPointer[1].mData!.assumingMemoryBound(to: Float.self), 1, vDSP_Length(outFrames)) }
            
            return noErr
        }
    }

    // MARK: - Offline Rendering

    public func renderClipToBuffer(clip: MidiClip, bpm: Double, config: InstrumentConfig) -> AVAudioPCMBuffer? {
        guard let head = headBuffer, let sampleFormat = sampleFormat else {
            logger.warning("No sample loaded for sampler rendering")
            return nil
        }
        
        // Update local state from config
        self.mode = config.samplerMode

        let outputSampleRate = sampleFormat.sampleRate
        let clipDurationSeconds = clip.duration.toSeconds(bpm: bpm)
        let totalOutputFrames = AVAudioFrameCount(clipDurationSeconds * outputSampleRate)

        guard totalOutputFrames > 0 else { return nil }

        let outputFormat = AVAudioFormat(
            standardFormatWithSampleRate: outputSampleRate,
            channels: sampleFormat.channelCount
        )!

        guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: totalOutputFrames) else {
            return nil
        }
        outputBuffer.frameLength = totalOutputFrames

        // Zero fill
        for ch in 0..<Int(outputFormat.channelCount) {
            guard let data = outputBuffer.floatChannelData?[ch] else { continue }
            memset(data, 0, Int(totalOutputFrames) * MemoryLayout<Float>.size)
        }

        // Render each note
        for note in clip.notes {
            let noteStartSeconds = note.position.toSeconds(bpm: bpm)
            let noteDurationSeconds = note.duration.toSeconds(bpm: bpm)

            let startFrame = AVAudioFramePosition(noteStartSeconds * outputSampleRate)
            guard startFrame < AVAudioFramePosition(totalOutputFrames) else { continue }

            // ─── Offset / Length Calculation ───
            let totalFileFrames = Double(self.totalFrames)
            let startFrameOffset = Double(config.startPercent / 100.0) * totalFileFrames
            let endFrameOffset = Double(config.endPercent / 100.0) * totalFileFrames
            let effectiveSampleFrames = max(1.0, endFrameOffset - startFrameOffset)

            let pitchRatio = pow(2.0, (Double(note.pitch) - Double(rootNote)) / 12.0)

            let outputFramesForSample: Int = Int(effectiveSampleFrames / pitchRatio)
            let maxOutputFrames: Int = (mode == .oneShot) ? outputFramesForSample : Int(noteDurationSeconds * outputSampleRate)

            let velocity = Float(note.velocity) / 127.0
            let attackF = config.attack * outputSampleRate
            let decayF = config.decay * outputSampleRate
            let releaseF = config.release * outputSampleRate
            
            // ─── Filter state (SVF) for this note ───
            var ic1eq_L: Float = 0, ic2eq_L: Float = 0
            var ic1eq_R: Float = 0, ic2eq_R: Float = 0

            for outputOffset in 0..<maxOutputFrames {
                let outputFrame = Int(startFrame) + outputOffset
                guard outputFrame >= 0, outputFrame < Int(totalOutputFrames) else { continue }

                var env: Double = 1.0
                let t = Double(outputOffset)
                if t < attackF { env = t / attackF }
                else if t < attackF + decayF { env = 1.0 - (1.0 - config.sustain) * ((t - attackF) / decayF) }
                else { env = config.sustain }
                
                let framesRemaining = Double(maxOutputFrames - outputOffset)
                if framesRemaining < releaseF { env *= (framesRemaining / releaseF) }

                var sourcePos = startFrameOffset + (Double(outputOffset) * pitchRatio)
                if mode == .classic {
                    sourcePos = startFrameOffset + (Double(outputOffset) * pitchRatio).truncatingRemainder(dividingBy: effectiveSampleFrames)
                } else if sourcePos >= endFrameOffset { break }

                // AD-Stream for offline render (simplest version for now)
                let srcIdx = Int(sourcePos)
                let frac = Float(sourcePos - Double(srcIdx))
                
                // Filter coefficients
                let filterEnabled = config.filterEnabled
                let cutoff = max(20.0, min(config.filterCutoff, outputSampleRate * 0.49))
                let resonance = max(0.0, min(config.filterResonance, 0.99))
                let g = Float(tan(Double.pi * cutoff / outputSampleRate))
                let k = Float(2.0 * (1.0 - resonance))
                let a1_f = 1.0 / (1.0 + g * (g + k)), a2_f = g * a1_f, a3_f = g * a2_f
                
                for ch in 0..<Int(sampleFormat.channelCount) {
                    guard let dstData = outputBuffer.floatChannelData?[ch] else { continue }

                    // We use head buffer if in range, otherwise we'd need to load from disk.
                    var s0: Float = 0, s1: Float = 0
                    if sourcePos < Double(head.frameLength - 1) {
                        s0 = head.floatChannelData?[ch][srcIdx] ?? 0
                        s1 = head.floatChannelData?[ch][srcIdx + 1] ?? 0
                    } else if let url = sampleURL {
                        // Offline render tile load
                        if let tile = TileEngine.shared.loadTile(url: url, startFrame: Int64(sourcePos), count: 2) {
                            s0 = tile.floatChannelData?[ch][0] ?? 0
                            s1 = tile.floatChannelData?[ch][1] ?? 0
                        }
                    }

                    let interpolated = s0 * (1.0 - frac) + s1 * frac
                    let rawSample = interpolated * velocity * config.gain * Float(env)
                    
                    var finalSample = rawSample
                    if filterEnabled {
                        if ch == 0 {
                            let v3 = rawSample - ic2eq_L
                            let v1 = a1_f * ic1eq_L + a2_f * v3, v2 = ic2eq_L + a2_f * ic1eq_L + a3_f * v3
                            ic1eq_L = 2.0 * v1 - ic1eq_L; ic2eq_L = 2.0 * v2 - ic2eq_L
                            finalSample = v2
                        } else {
                            let v3 = rawSample - ic2eq_R
                            let v1 = a1_f * ic1eq_R + a2_f * v3, v2 = ic2eq_R + a2_f * ic1eq_R + a3_f * v3
                            ic1eq_R = 2.0 * v1 - ic1eq_R; ic2eq_R = 2.0 * v2 - ic2eq_R
                            finalSample = v2
                        }
                    }
                    dstData[outputFrame] += finalSample
                }
            }
        }
        return outputBuffer
    }
}
