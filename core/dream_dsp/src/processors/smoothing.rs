// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Real-Time Parameter Smoothing
// ═══════════════════════════════════════════════════════════════════════════

use crate::processors::sanitize_sample_rate;

#[derive(Debug, Clone, Copy)]
pub struct SmoothedValue {
    current: f32,
    target: f32,
    coeff: f32,
    time_ms: f32,
}

impl SmoothedValue {
    pub fn new(sample_rate: f32, time_ms: f32, initial: f32) -> Self {
        let mut s = Self {
            current: initial,
            target: initial,
            coeff: 0.0,
            time_ms: time_ms.max(0.0),
        };
        s.set_sample_rate(sample_rate);
        s
    }

    #[inline]
    pub fn set_sample_rate(&mut self, sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if self.time_ms <= 0.0 {
            self.coeff = 0.0;
        } else {
            self.coeff = (-1.0 / (self.time_ms * 0.001 * sr)).exp();
        }
    }

    #[inline]
    pub fn set_time_ms(&mut self, sample_rate: f32, time_ms: f32) {
        self.time_ms = time_ms.max(0.0);
        self.set_sample_rate(sample_rate);
    }

    /// Sets the target value for smoothing.
    /// BUG-M05 FIX: Rejects NaN/Inf to prevent permanent output poisoning.
    #[inline]
    pub fn set_target(&mut self, target: f32) {
        if target.is_finite() {
            self.target = target;
        }
    }

    #[inline]
    pub fn set_instant(&mut self, value: f32) {
        self.current = value;
        self.target = value;
    }

    #[inline(always)]
    pub fn get_current(&self) -> f32 {
        self.current
    }

    #[inline(always)]
    pub fn get_target(&self) -> f32 {
        self.target
    }

    /// Fast-forwards the smoother by `samples` ticks mathematically in O(1).
    #[inline]
    pub fn skip(&mut self, samples: usize) {
        if samples == 0 {
            return;
        }
        if (self.current - self.target).abs() < 1.0e-6 {
            self.current = self.target;
            return;
        }
        let c_n = self.coeff.powi(samples as i32);
        self.current = self.target + (self.current - self.target) * c_n;
        
        if self.current.abs() < 1.0e-20 && self.target.abs() < 1.0e-20 {
            self.current = 0.0;
        }
    }

    /// Advances the smoother by one sample and returns the current value.
    /// BUG-H17 FIX: Convergence threshold 1e-12 → 1e-6 to avoid thousands
    /// of wasted multiply-adds that produce no audible change.
    #[inline(always)]
    pub fn next_value(&mut self) -> f32 {
        self.current = self.coeff * self.current + (1.0 - self.coeff) * self.target;
        if (self.current - self.target).abs() < 1.0e-6 {
            self.current = self.target;
        }
        // Denormal flush — prevents CPU stall when smoother value is near zero.
        if self.current.abs() < 1.0e-20 && self.target.abs() < 1.0e-20 {
            self.current = 0.0;
        }
        self.current
    }
}
