// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Automation Lane
// ═══════════════════════════════════════════════════════════════════════════
//
// Binds an automation curve to a specific parameter target.
//
// Each lane represents one controllable parameter on a track or plugin:
//   - Track volume, pan
//   - Plugin parameter (by index)
//   - Send level
//
// ═══════════════════════════════════════════════════════════════════════════

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::curve::AutomationCurve;
use super::mode::AutomationMode;

/// What parameter this automation lane controls.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AutomationTarget {
    /// Track volume fader (0.0–1.0).
    TrackVolume,

    /// Track pan knob (-1.0 to 1.0, mapped to 0.0–1.0 in curve).
    TrackPan,

    /// Track mute (0.0 = unmuted, 1.0 = muted).
    TrackMute,

    /// Plugin parameter by index.
    PluginParameter {
        /// UUID of the plugin instance.
        plugin_id: Uuid,

        /// Parameter index within the plugin.
        param_index: u32,

        /// Display name of the parameter.
        param_name: String,
    },

    /// Send level to an auxiliary bus.
    SendLevel {
        /// UUID of the destination bus.
        bus_id: Uuid,
    },
}

/// A single automation lane: curve + target + mode.
///
/// Each track can have multiple lanes, one per automated parameter.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationLane {
    /// Unique identifier for this lane.
    pub id: Uuid,

    /// What this lane controls.
    pub target: AutomationTarget,

    /// The automation curve data.
    pub curve: AutomationCurve,

    /// Current automation mode.
    pub mode: AutomationMode,

    /// Whether this lane is visible in the UI.
    pub visible: bool,

    /// Whether the user is currently touching the fader (for Touch/Latch).
    #[serde(skip)]
    pub fader_touched: bool,

    /// BUG-007 FIX: Whether latch mode is actively latching a value.
    /// Set to `true` when user touches fader in Latch mode, stays `true`
    /// after release until transport stops or mode changes.
    #[serde(skip)]
    pub latch_active: bool,

    /// BUG-007 FIX: The last value set by the user in Latch mode.
    /// Used as the output value when `latch_active` is true and fader is released.
    #[serde(skip)]
    pub latched_value: f64,
}

impl AutomationLane {
    /// Creates a new lane for a given target.
    pub fn new(target: AutomationTarget, default_value: f64) -> Self {
        Self {
            id: Uuid::new_v4(),
            target,
            curve: AutomationCurve::new(default_value),
            mode: AutomationMode::Read,
            visible: true,
            fader_touched: false,
            latch_active: false,
            latched_value: default_value,
        }
    }

    /// BUG-007 FIX: Properly manages fader touch state with latch lifecycle.
    ///
    /// In Latch mode, touching the fader activates latching. Releasing the fader
    /// keeps latch active — the lane continues outputting the last written value
    /// until `reset_latch()` is called (e.g., on transport stop).
    pub fn set_fader_touch(&mut self, touched: bool) {
        self.fader_touched = touched;
        if touched && self.mode == AutomationMode::Latch {
            self.latch_active = true;
        }
    }

    /// BUG-007 FIX: Sets the latched value (called from parameter write path).
    pub fn set_latched_value(&mut self, value: f64) {
        self.latched_value = value.clamp(0.0, 1.0);
    }

    /// BUG-007 FIX: Resets latch state (called on transport stop or mode change).
    pub fn reset_latch(&mut self) {
        self.latch_active = false;
    }

    /// Evaluates the automation value at the given position,
    /// considering the current mode and fader state.
    ///
    /// # Returns
    /// - `Some(value)` if automation is active and provides a value
    /// - `None` if automation is off or the user is manually controlling
    ///
    /// # Real-Time Safety
    /// Real-time safe.
    #[inline]
    pub fn evaluate(&self, position: i64) -> Option<f64> {
        match self.mode {
            AutomationMode::Off => None,

            AutomationMode::Read => Some(self.curve.evaluate(position)),

            AutomationMode::Write => {
                // In write mode, user is always in control
                None
            }

            AutomationMode::Touch => {
                if self.fader_touched {
                    None // User is controlling
                } else {
                    Some(self.curve.evaluate(position))
                }
            }

            // BUG-007 FIX: Latch mode now correctly latches.
            // - While fader is touched: user controls (returns None)
            // - After release with latch active: returns latched value
            // - Before first touch: reads automation curve
            AutomationMode::Latch => {
                if self.fader_touched {
                    None // User is actively controlling
                } else if self.latch_active {
                    Some(self.latched_value) // Latch holds the last written value
                } else {
                    Some(self.curve.evaluate(position)) // Not yet latched
                }
            }
        }
    }

    /// Display name for the lane (for UI).
    pub fn display_name(&self) -> String {
        match &self.target {
            AutomationTarget::TrackVolume => "Volume".to_string(),
            AutomationTarget::TrackPan => "Pan".to_string(),
            AutomationTarget::TrackMute => "Mute".to_string(),
            AutomationTarget::PluginParameter { param_name, .. } => param_name.clone(),
            AutomationTarget::SendLevel { .. } => "Send Level".to_string(),
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::super::curve::AutomationPoint;
    use super::*;

    #[test]
    fn lane_creation() {
        let lane = AutomationLane::new(AutomationTarget::TrackVolume, 1.0);
        assert_eq!(lane.display_name(), "Volume");
        assert_eq!(lane.mode, AutomationMode::Read);
        assert!(lane.visible);
    }

    #[test]
    fn lane_evaluate_read_mode() {
        let mut lane = AutomationLane::new(AutomationTarget::TrackVolume, 0.5);
        lane.curve.add_point(AutomationPoint::new(0, 0.0));
        lane.curve.add_point(AutomationPoint::new(1000, 1.0));

        let val = lane.evaluate(500).unwrap();
        assert!((val - 0.5).abs() < 0.01);
    }

    #[test]
    fn lane_evaluate_off_mode() {
        let mut lane = AutomationLane::new(AutomationTarget::TrackVolume, 0.5);
        lane.mode = AutomationMode::Off;

        assert!(lane.evaluate(500).is_none());
    }

    #[test]
    fn lane_evaluate_touch_untouched() {
        let mut lane = AutomationLane::new(AutomationTarget::TrackPan, 0.5);
        lane.mode = AutomationMode::Touch;
        lane.curve.add_point(AutomationPoint::new(0, 0.0));
        lane.curve.add_point(AutomationPoint::new(1000, 1.0));

        // Not touching fader → reads automation
        let val = lane.evaluate(500).unwrap();
        assert!((val - 0.5).abs() < 0.01);
    }

    #[test]
    fn lane_evaluate_touch_touched() {
        let mut lane = AutomationLane::new(AutomationTarget::TrackPan, 0.5);
        lane.mode = AutomationMode::Touch;
        lane.fader_touched = true;

        // Touching fader → user in control
        assert!(lane.evaluate(500).is_none());
    }

    #[test]
    fn plugin_param_lane() {
        let target = AutomationTarget::PluginParameter {
            plugin_id: Uuid::new_v4(),
            param_index: 3,
            param_name: "Cutoff".to_string(),
        };
        let lane = AutomationLane::new(target, 0.5);
        assert_eq!(lane.display_name(), "Cutoff");
    }
}
