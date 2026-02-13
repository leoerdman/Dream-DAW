import AVFoundation
import Foundation
import Accelerate
import DreamDAWModels
import os.log

// MARK: - SimpleSynthInstrument

/// A simple monophonic sine wave synthesizer that renders MIDI notes to audio.
/// Uses AVAudioSourceNode to generate real-time audio from sine oscillators.
/// Supports polyphony via additive sine wave generation.
public final class SimpleSynthInstrument {

    // MARK: - Properties

    private let sampleRate: Double
    private let logger = Logger(subsystem: "com.dreamdaw", category: "SimpleSynth")

    /// Active voices: pitch → phase accumulator
    /// Active voices: pitch → phase accumulator
    private var voices: [Int: Double] = [:]
    
    /// Lock-Free command queue for real-time thread
    private let commandQueue = SPSCRingBuffer<AudioCommand>(capacity: 64)

    /// Master amplitude (0.0 ... 1.0).
    /// Accessed only via command queue in real-time.
    private var internalAmplitude: Float = 0.3
    private var _lastAmplitude: Float = 0.3
    
    /// PHASE 13.2: Hardware start anchor.
    /// Initialized to .max to ensure gate is strictly CLOSED until the scheduler sets the anchor.
    public var startHostTime: UInt64 = .max

    public var amplitude: Float {
        get { internalAmplitude }
        set { _ = commandQueue.push(.parameterChange(id: "amplitude", value: newValue)) }
    }

    /// ADSR envelope (simplified — instant attack, sustain, instant release).
    private var activeNotes: Set<Int> = []

    // MARK: - Initialization

    public init(sampleRate: Double = 44100.0) {
        self.sampleRate = sampleRate
    }

    // MARK: - Note Control

    /// Start playing a note.
    public func noteOn(pitch: Int, velocity: Int = 100) {
        _ = commandQueue.push(.noteOn(pitch: pitch, velocity: velocity))
    }

    /// Stop playing a note.
    public func noteOff(pitch: Int) {
        _ = commandQueue.push(.noteOff(pitch: pitch))
    }

    /// Stop all notes immediately.
    public func allNotesOff() {
        _ = commandQueue.push(.allNotesOff)
    }

    // MARK: - Audio Source Node

    /// Create an AVAudioSourceNode that generates audio from active notes.
    /// Connect this node to the mixer chain for real-time synthesis.
    public func createSourceNode() -> AVAudioSourceNode {
        let sr = sampleRate

        let sourceNode = AVAudioSourceNode(format: AVAudioFormat(
            standardFormatWithSampleRate: sr,
            channels: 2
        )!) { [weak self] _, timeStamp, frameCount, audioBufferList -> OSStatus in
            guard let self = self else { return noErr }
            
            // PHASE 13.1: Hardware Gating.
            // Stay silent until we reach the hardware anchor.
            if timeStamp.pointee.mHostTime < self.startHostTime {
                let ablPointer = UnsafeMutableAudioBufferListPointer(audioBufferList)
                for ch in 0..<ablPointer.count {
                    memset(ablPointer[ch].mData, 0, Int(frameCount) * MemoryLayout<Float>.size)
                }
                return noErr
            }

            // 1. PROCESS COMMANDS (LOCK-FREE)
            while let command = self.commandQueue.pop() {
                switch command {
                case .noteOn(let pitch, _):
                    self.activeNotes.insert(pitch)
                    if self.voices[pitch] == nil {
                        self.voices[pitch] = 0.0
                    }
                case .noteOff(let pitch):
                    self.activeNotes.remove(pitch)
                    self.voices.removeValue(forKey: pitch)
                case .allNotesOff:
                    self.activeNotes.removeAll()
                    self.voices.removeAll()
                case .parameterChange(let id, let value):
                    if id == "amplitude" {
                        self.internalAmplitude = value
                    }
                case .automationUpdate:
                    break // TODO: Sample-accurate automation
                }
            }

            let ablPointer = UnsafeMutableAudioBufferListPointer(audioBufferList)
            let targetAmplitude = self.internalAmplitude
            let outFrames = Int(frameCount)

            // Smoothing Logic
            let ampStep = (targetAmplitude - self._lastAmplitude) / Float(outFrames)

            // 2. MIX VOICES
            var accum = [Float](repeating: 0, count: outFrames)

            for frame in 0..<outFrames {
                // Interpolate amplitude per sample
                let currentAmp = self._lastAmplitude + ampStep * Float(frame)
                var sample: Float = 0.0

                for pitch in self.activeNotes {
                    guard let phase = self.voices[pitch] else { continue }
                    let frequency = Self.midiNoteToFrequency(pitch)
                    let increment = frequency / sr
                    let currentPhase = phase + Double(frame) * increment

                    sample += sinf(Float(currentPhase * 2.0 * .pi))
                }
                accum[frame] = sample * currentAmp
            }

            // 3. WRITE TO OUTPUT
            for buffer in ablPointer {
                let ptr = buffer.mData!.assumingMemoryBound(to: Float.self)
                // Copy accum to buffer (we already applied amplitude in the loop for sample-accuracy)
                memcpy(ptr, accum, outFrames * MemoryLayout<Float>.size)
            }

            // Sync back state
            self._lastAmplitude = targetAmplitude

            // 4. UPDATE PHASE ACCUMULATORS
            for pitch in self.activeNotes {
                guard let phase = self.voices[pitch] else { continue }
                let frequency = Self.midiNoteToFrequency(pitch)
                let increment = frequency / sr
                self.voices[pitch] = phase + Double(frameCount) * increment

                if self.voices[pitch]! > 1_000_000 {
                    self.voices[pitch]! = self.voices[pitch]!.truncatingRemainder(dividingBy: 1.0)
                }
            }

            return noErr
        }

        return sourceNode
    }

    // MARK: - MIDI-to-Audio Rendering

    /// Render a MIDI clip to an AVAudioPCMBuffer for offline playback.
    /// Converts MIDI notes to sine waves at the correct pitches and timings.
    public func renderClipToBuffer(clip: MidiClip, bpm: Double) -> AVAudioPCMBuffer? {
        let clipDuration = clip.duration.toSeconds(bpm: bpm)
        let totalFrames = AVAudioFrameCount(clipDuration * sampleRate)

        guard totalFrames > 0 else { return nil }

        let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 2)!
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: totalFrames) else {
            return nil
        }
        buffer.frameLength = totalFrames

        guard let leftChannel = buffer.floatChannelData?[0],
              let rightChannel = buffer.floatChannelData?[1] else { return nil }

        // Initialize to silence
        for i in 0..<Int(totalFrames) {
            leftChannel[i] = 0
            rightChannel[i] = 0
        }

        // Render each note
        for note in clip.notes {
            let noteStartSeconds = note.position.toSeconds(bpm: bpm)
            let noteDurationSeconds = note.duration.toSeconds(bpm: bpm)
            let frequency = Self.midiNoteToFrequency(note.pitch)
            let velocity = Float(note.velocity) / 127.0

            let startFrame = Int(noteStartSeconds * sampleRate)
            let endFrame = min(Int((noteStartSeconds + noteDurationSeconds) * sampleRate), Int(totalFrames))

            guard startFrame < Int(totalFrames) && endFrame > startFrame else { continue }

            let amp = amplitude * velocity

            for frame in startFrame..<endFrame {
                let phase = Double(frame - startFrame) / sampleRate * frequency
                let sample = sinf(Float(phase * 2.0 * .pi)) * amp

                leftChannel[frame] += sample
                rightChannel[frame] += sample
            }
        }

        // Final clamp pass
        for i in 0..<Int(totalFrames) {
            leftChannel[i] = max(-1.0, min(1.0, leftChannel[i]))
            rightChannel[i] = max(-1.0, min(1.0, rightChannel[i]))
        }

        logger.info("Rendered MIDI clip '\(clip.name)' to buffer: \(totalFrames) frames")
        return buffer
    }

    // MARK: - Utility

    /// Convert MIDI note number to frequency in Hz (A4 = 440 Hz).
    public static func midiNoteToFrequency(_ note: Int) -> Double {
        440.0 * pow(2.0, Double(note - 69) / 12.0)
    }
}
