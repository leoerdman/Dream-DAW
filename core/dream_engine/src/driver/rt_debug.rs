use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

/// Lock-free runtime stats written by audio callback for diagnostics.
///
/// AUD-054: All fields use `Relaxed` ordering intentionally. These stats are
/// for diagnostics only — stale reads across fields in a snapshot are acceptable.
/// Using `Acquire/Release` would add unnecessary memory fences on every callback.
pub struct SharedRtDebugStats {
    enabled: AtomicBool,
    callback_count: AtomicU64,
    command_count_total: AtomicU64,
    command_count_last: AtomicU64,
    command_count_max: AtomicU64,
    callback_duration_us_last: AtomicU64,
    callback_duration_us_max: AtomicU64,
    callback_frames_last: AtomicU64,
    plugin_host_lock_miss_total: AtomicU64,
    queue_full_reject_total: AtomicU64,
    deferred_topology_len_last: AtomicU64,
    topology_overflow_total: AtomicU64,
    /// Audio thread utilization percentage (0–100). Stored as f32 bits in AtomicU32.
    /// This is THE critical metric for DAW users — shows how close the session is
    /// to dropout. Computed as (callback_duration / buffer_budget) × 100.
    dsp_load_percent: AtomicU32,
    /// Smoothed DSP load for UI display (EMA with α ≈ 0.1).
    dsp_load_smoothed: AtomicU32,
}

impl SharedRtDebugStats {
    pub fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            callback_count: AtomicU64::new(0),
            command_count_total: AtomicU64::new(0),
            command_count_last: AtomicU64::new(0),
            command_count_max: AtomicU64::new(0),
            callback_duration_us_last: AtomicU64::new(0),
            callback_duration_us_max: AtomicU64::new(0),
            callback_frames_last: AtomicU64::new(0),
            plugin_host_lock_miss_total: AtomicU64::new(0),
            queue_full_reject_total: AtomicU64::new(0),
            deferred_topology_len_last: AtomicU64::new(0),
            topology_overflow_total: AtomicU64::new(0),
            dsp_load_percent: AtomicU32::new(0),
            dsp_load_smoothed: AtomicU32::new(0),
        }
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn record_queue_full_reject(&self) {
        if !self.is_enabled() {
            return;
        }
        self.queue_full_reject_total.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn record_callback(
        &self,
        frames: usize,
        commands_processed: usize,
        callback_us: u64,
        deferred_topology_len: usize,
    ) {
        if !self.is_enabled() {
            return;
        }
        self.callback_count.fetch_add(1, Ordering::Relaxed);
        self.command_count_total
            .fetch_add(commands_processed as u64, Ordering::Relaxed);
        self.command_count_last
            .store(commands_processed as u64, Ordering::Relaxed);
        self.command_count_max
            .fetch_max(commands_processed as u64, Ordering::Relaxed);
        self.callback_duration_us_last
            .store(callback_us, Ordering::Relaxed);
        self.callback_duration_us_max
            .fetch_max(callback_us, Ordering::Relaxed);
        self.callback_frames_last
            .store(frames as u64, Ordering::Relaxed);
        self.deferred_topology_len_last
            .store(deferred_topology_len as u64, Ordering::Relaxed);
    }

    /// RT-SAFE topology overflow counter. Replaces log::warn! which
    /// would acquire a global Mutex inside the audio callback.
    pub(crate) fn record_topology_overflow(&self) {
        self.topology_overflow_total.fetch_add(1, Ordering::Relaxed);
    }

    /// Records the DSP load percentage from the audio callback.
    /// Called unconditionally every callback — the ~20ns `Instant::now()` overhead
    /// is negligible vs. the typical 200–2000µs render budget.
    #[allow(dead_code)]
    pub(crate) fn record_dsp_load(&self, load_percent: f32) {
        let clamped = load_percent.clamp(0.0, 100.0);
        self.dsp_load_percent
            .store(clamped.to_bits(), Ordering::Relaxed);
        // Exponential moving average (α ≈ 0.1) for smooth UI display.
        let prev = f32::from_bits(self.dsp_load_smoothed.load(Ordering::Relaxed));
        let smoothed = prev + 0.1 * (clamped - prev);
        self.dsp_load_smoothed
            .store(smoothed.to_bits(), Ordering::Relaxed);
    }

    /// Returns the smoothed DSP load percentage (0–100) for UI display.
    pub fn dsp_load_percent(&self) -> f32 {
        f32::from_bits(self.dsp_load_smoothed.load(Ordering::Relaxed))
    }

    /// Returns the instantaneous (unsmoothed) DSP load percentage.
    pub fn dsp_load_instant(&self) -> f32 {
        f32::from_bits(self.dsp_load_percent.load(Ordering::Relaxed))
    }

    pub fn snapshot(&self) -> RtDebugSnapshot {
        RtDebugSnapshot {
            enabled: self.is_enabled(),
            callback_count: self.callback_count.load(Ordering::Relaxed),
            command_count_total: self.command_count_total.load(Ordering::Relaxed),
            command_count_last: self.command_count_last.load(Ordering::Relaxed),
            command_count_max: self.command_count_max.load(Ordering::Relaxed),
            callback_duration_us_last: self.callback_duration_us_last.load(Ordering::Relaxed),
            callback_duration_us_max: self.callback_duration_us_max.load(Ordering::Relaxed),
            callback_frames_last: self.callback_frames_last.load(Ordering::Relaxed),
            plugin_host_lock_miss_total: self.plugin_host_lock_miss_total.load(Ordering::Relaxed),
            queue_full_reject_total: self.queue_full_reject_total.load(Ordering::Relaxed),
            deferred_topology_len_last: self.deferred_topology_len_last.load(Ordering::Relaxed),
            topology_overflow_total: self.topology_overflow_total.load(Ordering::Relaxed),
            dsp_load_percent: self.dsp_load_percent(),
            dsp_load_instant: self.dsp_load_instant(),
        }
    }
}

impl Default for SharedRtDebugStats {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct RtDebugSnapshot {
    pub enabled: bool,
    pub callback_count: u64,
    pub command_count_total: u64,
    pub command_count_last: u64,
    pub command_count_max: u64,
    pub callback_duration_us_last: u64,
    pub callback_duration_us_max: u64,
    pub callback_frames_last: u64,
    pub plugin_host_lock_miss_total: u64,
    pub queue_full_reject_total: u64,
    pub deferred_topology_len_last: u64,
    pub topology_overflow_total: u64,
    /// Smoothed DSP load percentage (0–100) for UI display.
    pub dsp_load_percent: f32,
    /// Raw instantaneous DSP load (0–100) — last callback only.
    pub dsp_load_instant: f32,
}
