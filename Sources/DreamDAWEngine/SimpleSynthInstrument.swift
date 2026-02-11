import AVFoundation
import Foundation
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
    private var voices: [Int: Double] = [:]
    private let voiceLock = NSLock()

    /// Master amplitude (0.0 ... 1.0).
    public var amplitude: Float = 0.3

    /// ADSR envelope (simplified — instant attack, sustain, instant release).
    private var activeNotes: Set<Int> = []

    // MARK: - Initialization

    public init(sampleRate: Double = 44100.0) {
        self.sampleRate = sampleRate
    }

    // MARK: - Note Control

    /// Start playing a note.
    public func noteOn(pitch: Int, velocity: Int = 100) {
        voiceLock.lock()
        defer { voiceLock.unlock() }

        activeNotes.insert(pitch)
        if voices[pitch] == nil {
            voices[pitch] = 0.0
        }
    }

    /// Stop playing a note.
    public func noteOff(pitch: Int) {
        voiceLock.lock()
        defer { voiceLock.unlock() }

        activeNotes.remove(pitch)
        voices.removeValue(forKey: pitch)
    }

    /// Stop all notes immediately.
    public func allNotesOff() {
        voiceLock.lock()
        defer { voiceLock.unlock() }

        activeNotes.removeAll()
        voices.removeAll()
    }

    // MARK: - Audio Source Node

    /// Create an AVAudioSourceNode that generates audio from active notes.
    /// Connect this node to the mixer chain for real-time synthesis.
    public func createSourceNode() -> AVAudioSourceNode {
        let sr = sampleRate

        let sourceNode = AVAudioSourceNode(format: AVAudioFormat(
            standardFormatWithSampleRate: sr,
            channels: 2
        )!) { [weak self] _, _, frameCount, audioBufferList -> OSStatus in
            guard let self = self else { return noErr }

            let ablPointer = UnsafeMutableAudioBufferListPointer(audioBufferList)
            let amplitude = self.amplitude

            self.voiceLock.lock()
            let currentVoices = self.voices
            let currentActive = self.activeNotes
            self.voiceLock.unlock()

            // Fill buffers
            for frame in 0..<Int(frameCount) {
                var sample: Float = 0.0

                for pitch in currentActive {
                    guard let phase = currentVoices[pitch] else { continue }
                    let frequency = Self.midiNoteToFrequency(pitch)
                    let increment = frequency / sr
                    let currentPhase = phase + Double(frame) * increment

                    sample += sinf(Float(currentPhase * 2.0 * .pi)) * amplitude
                }

                // Clamp to prevent clipping
                sample = max(-1.0, min(1.0, sample))

                // Write to all channels
                for buffer in ablPointer {
                    let ptr = buffer.mData!.assumingMemoryBound(to: Float.self)
                    ptr[frame] = sample
                }
            }

            // Update phase accumulators
            self.voiceLock.lock()
            for pitch in currentActive {
                guard let phase = self.voices[pitch] else { continue }
                let frequency = Self.midiNoteToFrequency(pitch)
                let increment = frequency / sr
                self.voices[pitch] = phase + Double(frameCount) * increment

                // Keep phase in reasonable range to avoid floating-point issues
                if self.voices[pitch]! > 1_000_000 {
                    self.voices[pitch]! = self.voices[pitch]!.truncatingRemainder(dividingBy: 1.0)
                }
            }
            self.voiceLock.unlock()

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
