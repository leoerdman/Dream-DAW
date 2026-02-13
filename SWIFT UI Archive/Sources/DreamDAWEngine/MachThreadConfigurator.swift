import Darwin

// MARK: - SPRINT 5 (Pillar 5): Mach Thread Configurator — Real-Time Kernel Priority
//
// Elevates the audio scheduling thread to Darwin's THREAD_TIME_CONSTRAINT_POLICY,
// guaranteeing exclusive CPU time and preventing macOS from preempting the thread
// for background tasks (Spotlight, Time Machine, etc.).
//
// This is the same technique used by CoreAudio's internal IOProc threads,
// Logic Pro, and Ableton Live's audio engine.

public final class MachThreadConfigurator {
    
    /// Elevates the current thread to hard real-time priority.
    ///
    /// **MUST be called from within the target thread** (e.g., inside the
    /// DispatchQueue block or the audio render callback).
    ///
    /// Requests:
    /// - Period: 5.8ms (matches 256-sample buffer at 44.1kHz)
    /// - Computation: 2.9ms of exclusive, uninterruptible CPU time
    /// - Constraint: Hard deadline = period (no slack)
    /// - Preemptible: false (kernel CANNOT interrupt this thread)
    ///
    /// - Parameter sampleRate: The audio engine's sample rate (default: 44100)
    /// - Parameter bufferSize: The audio engine's buffer size (default: 256)
    @discardableResult
    public static func elevateToRealTime(
        sampleRate: Double = 44100.0,
        bufferSize: UInt32 = 256
    ) -> Bool {
        var timebaseInfo = mach_timebase_info_data_t()
        mach_timebase_info(&timebaseInfo)
        
        // Convert from nanoseconds to Mach absolute time units
        let clock2abs = Double(timebaseInfo.denom) / Double(timebaseInfo.numer)
        
        // Period: time between audio callbacks (bufferSize / sampleRate)
        let periodNs = (Double(bufferSize) / sampleRate) * 1_000_000_000
        let period = UInt32(periodNs * clock2abs)
        
        // Computation: half the period — how much CPU time we need per callback
        let computationNs = periodNs * 0.5
        let computation = UInt32(computationNs * clock2abs)
        
        // Constraint: deadline = period (hard real-time, no slack)
        let constraint = period
        
        var policy = thread_time_constraint_policy(
            period: period,
            computation: computation,
            constraint: constraint,
            preemptible: 0  // HARD RT: kernel MUST NOT preempt this thread
        )
        
        let policySize = mach_msg_type_number_t(
            MemoryLayout<thread_time_constraint_policy>.size / MemoryLayout<integer_t>.size
        )
        
        let result = withUnsafeMutablePointer(to: &policy) { policyPtr in
            policyPtr.withMemoryRebound(to: integer_t.self, capacity: Int(policySize)) { intPtr in
                thread_policy_set(
                    mach_thread_self(),
                    UInt32(THREAD_TIME_CONSTRAINT_POLICY),
                    intPtr,
                    policySize
                )
            }
        }
        
        if result == KERN_SUCCESS {
            // Thread is now in hard real-time mode
            return true
        } else {
            // Fallback: try elevated POSIX priority
            var sched = sched_param()
            sched.sched_priority = 75 // High priority (max is usually 99)
            pthread_setschedparam(pthread_self(), SCHED_FIFO, &sched)
            return false
        }
    }
    
    /// Resets the current thread to default scheduling policy.
    /// Call when the audio thread is shutting down.
    public static func resetToDefault() {
        var policy = thread_standard_policy()
        let policySize = mach_msg_type_number_t(
            MemoryLayout<thread_standard_policy>.size / MemoryLayout<integer_t>.size
        )
        
        withUnsafeMutablePointer(to: &policy) { policyPtr in
            policyPtr.withMemoryRebound(to: integer_t.self, capacity: Int(policySize)) { intPtr in
                thread_policy_set(
                    mach_thread_self(),
                    UInt32(THREAD_STANDARD_POLICY),
                    intPtr,
                    policySize
                )
            }
        }
    }
}
