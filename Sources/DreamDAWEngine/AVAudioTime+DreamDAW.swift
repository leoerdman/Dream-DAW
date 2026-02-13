import AVFoundation

extension AVAudioTime {
    /// Returns a new AVAudioTime offset by the given number of seconds.
    /// Correctly correlates sampleTime and hostTime for synchronized node starts.
    public func atSeconds(_ seconds: Double) -> AVAudioTime {
        let frameOffset = AVAudioFramePosition(round(seconds * self.sampleRate))
        let newSampleTime = self.sampleTime + frameOffset
        
        // PHASE 11 (Timing sync): Correctly offset hostTime using mach_absolute_time frequency.
        // hostTime is in ticks, not seconds. We must convert seconds to ticks.
        var timebase = mach_timebase_info_data_t()
        mach_timebase_info(&timebase)
        
        let ticks = UInt64(seconds * 1_000_000_000.0 * Double(timebase.denom) / Double(timebase.numer))
        let newHostTime = self.hostTime + ticks
        
        return AVAudioTime(hostTime: newHostTime, sampleTime: newSampleTime, atRate: self.sampleRate)
    }
}
