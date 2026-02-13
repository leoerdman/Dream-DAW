// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Automation Modes
// ═══════════════════════════════════════════════════════════════════════════
//
// Defines how automation is read/written during playback.
//
// Industry-standard DAW automation modes:
//   Read — follows curve, ignores user input
//   Write — records user input, overwrites curve entirely
//   Touch — records user input while touching, reverts to curve on release
//   Latch — records user input until stop, continues at last value
//
// ═══════════════════════════════════════════════════════════════════════════

use serde::{Serialize, Deserialize};

/// Automation read/write mode.
///
/// Determines how a parameter interacts with its automation curve
/// during playback.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AutomationMode {
    /// Automation is not active. Parameter is manually controlled.
    Off,

    /// Read mode: parameter follows the curve. User input is ignored.
    Read,

    /// Write mode: records user input continuously, overwriting the curve.
    Write,

    /// Touch mode: follows curve normally. When the user touches the fader,
    /// records their input. When released, smoothly returns to the curve.
    Touch,

    /// Latch mode: follows curve normally. When the user touches the fader,
    /// starts recording. Continues recording at the last value until stopped.
    Latch,
}

impl Default for AutomationMode {
    fn default() -> Self {
        Self::Read
    }
}

impl AutomationMode {
    /// Returns whether this mode reads automation data.
    #[inline]
    pub fn reads_automation(&self) -> bool {
        matches!(self, Self::Read | Self::Touch | Self::Latch)
    }

    /// Returns whether this mode can write automation data.
    #[inline]
    pub fn writes_automation(&self) -> bool {
        matches!(self, Self::Write | Self::Touch | Self::Latch)
    }

    /// Returns whether this mode is actively recording (fader touched).
    pub fn is_recording(&self, fader_touched: bool) -> bool {
        match self {
            Self::Write => true, // Always recording
            Self::Touch | Self::Latch => fader_touched,
            _ => false,
        }
    }

    /// Returns all available modes (for UI dropdowns).
    pub fn all() -> &'static [AutomationMode] {
        &[
            Self::Off,
            Self::Read,
            Self::Write,
            Self::Touch,
            Self::Latch,
        ]
    }
}

impl std::fmt::Display for AutomationMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Off => write!(f, "Off"),
            Self::Read => write!(f, "Read"),
            Self::Write => write!(f, "Write"),
            Self::Touch => write!(f, "Touch"),
            Self::Latch => write!(f, "Latch"),
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_read() {
        assert_eq!(AutomationMode::default(), AutomationMode::Read);
    }

    #[test]
    fn read_does_not_write() {
        assert!(AutomationMode::Read.reads_automation());
        assert!(!AutomationMode::Read.writes_automation());
    }

    #[test]
    fn write_always_records() {
        assert!(AutomationMode::Write.is_recording(false));
        assert!(AutomationMode::Write.is_recording(true));
    }

    #[test]
    fn touch_records_only_when_touched() {
        assert!(!AutomationMode::Touch.is_recording(false));
        assert!(AutomationMode::Touch.is_recording(true));
    }

    #[test]
    fn latch_records_only_when_touched() {
        assert!(!AutomationMode::Latch.is_recording(false));
        assert!(AutomationMode::Latch.is_recording(true));
    }

    #[test]
    fn off_does_nothing() {
        assert!(!AutomationMode::Off.reads_automation());
        assert!(!AutomationMode::Off.writes_automation());
        assert!(!AutomationMode::Off.is_recording(true));
    }

    #[test]
    fn all_modes() {
        assert_eq!(AutomationMode::all().len(), 5);
    }

    #[test]
    fn display() {
        assert_eq!(format!("{}", AutomationMode::Read), "Read");
        assert_eq!(format!("{}", AutomationMode::Touch), "Touch");
    }
}
