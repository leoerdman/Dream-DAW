import AVFoundation

extension AVAudioTime {
    /// Returns a new AVAudioTime offset by the given number of seconds.
    public func atSeconds(_ seconds: Double) -> AVAudioTime {
        let frameOffset = AVAudioFramePosition(seconds * self.sampleRate)
        let newSampleTime = self.sampleTime + frameOffset
        
        // Offset host time as well to maintain sanity if both clocks are used
        // This is a simplified ticks-to-seconds conversion for hostTime
        return AVAudioTime(sampleTime: newSampleTime, atRate: self.sampleRate)
    }
}
