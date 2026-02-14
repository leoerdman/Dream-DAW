// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Automation Curve
// ═══════════════════════════════════════════════════════════════════════════
//
// Breakpoint-based automation curves with multiple interpolation modes.
//
// The curve stores sorted keyframes and evaluates values at any
// sample position using the specified interpolation.
//
// ═══════════════════════════════════════════════════════════════════════════

use serde::{Serialize, Deserialize};

/// Interpolation mode between automation points.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum InterpolationMode {
    /// Step: holds value until next point (MIDI CC style).
    Step,

    /// Linear: straight line between points.
    #[default]
    Linear,

    /// Smooth: cubic Hermite (catmull-rom) interpolation.
    Smooth,

    /// Exponential curve (for volume faders).
    Exponential,
}

/// A single automation breakpoint.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct AutomationPoint {
    /// Position in sample frames.
    pub position: i64,

    /// Value (normalized 0.0–1.0 for most parameters).
    pub value: f64,

    /// Interpolation from this point to the next.
    pub interpolation: InterpolationMode,
}

impl AutomationPoint {
    /// Creates a new automation point.
    pub fn new(position: i64, value: f64) -> Self {
        Self {
            position,
            value: value.clamp(0.0, 1.0),
            interpolation: InterpolationMode::Linear,
        }
    }

    /// Creates a point with specified interpolation.
    pub fn with_interpolation(position: i64, value: f64, interp: InterpolationMode) -> Self {
        Self {
            position,
            value: value.clamp(0.0, 1.0),
            interpolation: interp,
        }
    }
}

/// A complete automation curve made of sorted breakpoints.
///
/// Evaluates parameter values at any position using interpolation.
/// Points are kept sorted by position for efficient lookup.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationCurve {
    /// Sorted breakpoints.
    points: Vec<AutomationPoint>,

    /// Default value when no automation data exists.
    default_value: f64,
}

impl AutomationCurve {
    /// Creates an empty curve with a default value.
    pub fn new(default_value: f64) -> Self {
        Self {
            points: Vec::new(),
            default_value: default_value.clamp(0.0, 1.0),
        }
    }

    /// Adds a point and maintains sort order.
    pub fn add_point(&mut self, point: AutomationPoint) {
        // Binary search for insertion position
        let pos = self
            .points
            .binary_search_by(|p| p.position.cmp(&point.position))
            .unwrap_or_else(|pos| pos);

        // Replace if same position, otherwise insert
        if pos < self.points.len() && self.points[pos].position == point.position {
            self.points[pos] = point;
        } else {
            self.points.insert(pos, point);
        }
    }

    /// Removes the point closest to `position` within `tolerance` frames.
    /// Returns `true` if a point was removed.
    pub fn remove_near(&mut self, position: i64, tolerance: i64) -> bool {
        if let Some(idx) = self.points.iter().position(|p| {
            (p.position - position).abs() <= tolerance
        }) {
            self.points.remove(idx);
            true
        } else {
            false
        }
    }

    /// Evaluates the curve at a given sample position.
    ///
    /// # Real-Time Safety
    /// Real-time safe — binary search + arithmetic only.
    #[inline]
    pub fn evaluate(&self, position: i64) -> f64 {
        if self.points.is_empty() {
            return self.default_value;
        }

        // Before first point
        if position <= self.points.first().unwrap().position {
            return self.points.first().unwrap().value;
        }

        // After last point
        if position >= self.points.last().unwrap().position {
            return self.points.last().unwrap().value;
        }

        // Binary search for the segment
        let idx = match self
            .points
            .binary_search_by(|p| p.position.cmp(&position))
        {
            Ok(idx) => return self.points[idx].value, // Exact match
            Err(idx) => idx - 1, // Between idx-1 and idx
        };

        let p0 = &self.points[idx];
        let p1 = &self.points[idx + 1];

        // Fractional position between the two points
        let segment_len = (p1.position - p0.position) as f64;
        let t = if segment_len > 0.0 {
            (position - p0.position) as f64 / segment_len
        } else {
            0.0
        };

        match p0.interpolation {
            InterpolationMode::Step => p0.value,

            InterpolationMode::Linear => {
                p0.value + (p1.value - p0.value) * t
            }

            InterpolationMode::Smooth => {
                // Cubic Hermite (smoothstep)
                let t2 = t * t;
                let t3 = t2 * t;
                let smooth = 3.0 * t2 - 2.0 * t3;
                p0.value + (p1.value - p0.value) * smooth
            }

            InterpolationMode::Exponential => {
                // Exponential curve (good for faders)
                let exp_t = t * t; // Simple quadratic approximation
                p0.value + (p1.value - p0.value) * exp_t
            }
        }
    }

    /// Returns the number of breakpoints.
    pub fn len(&self) -> usize {
        self.points.len()
    }

    /// Returns whether the curve has no breakpoints.
    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }

    /// Returns all breakpoints (read-only).
    pub fn points(&self) -> &[AutomationPoint] {
        &self.points
    }

    /// Returns the default value.
    pub fn default_value(&self) -> f64 {
        self.default_value
    }

    /// Clears all breakpoints.
    pub fn clear(&mut self) {
        self.points.clear();
    }

    /// Returns the time range of the curve (first point → last point).
    pub fn time_range(&self) -> Option<(i64, i64)> {
        if let (Some(first), Some(last)) = (self.points.first(), self.points.last()) {
            Some((first.position, last.position))
        } else {
            None
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
    fn empty_curve_returns_default() {
        let curve = AutomationCurve::new(0.75);
        assert!((curve.evaluate(0) - 0.75).abs() < 0.001);
        assert!((curve.evaluate(99999) - 0.75).abs() < 0.001);
    }

    #[test]
    fn single_point_returns_its_value() {
        let mut curve = AutomationCurve::new(0.5);
        curve.add_point(AutomationPoint::new(1000, 0.8));

        assert!((curve.evaluate(0) - 0.8).abs() < 0.001); // Before
        assert!((curve.evaluate(1000) - 0.8).abs() < 0.001); // At
        assert!((curve.evaluate(2000) - 0.8).abs() < 0.001); // After
    }

    #[test]
    fn linear_interpolation() {
        let mut curve = AutomationCurve::new(0.0);
        curve.add_point(AutomationPoint::new(0, 0.0));
        curve.add_point(AutomationPoint::new(1000, 1.0));

        // Midpoint should be 0.5
        assert!((curve.evaluate(500) - 0.5).abs() < 0.01);
    }

    #[test]
    fn step_interpolation() {
        let mut curve = AutomationCurve::new(0.0);
        curve.add_point(AutomationPoint::with_interpolation(
            0, 0.0, InterpolationMode::Step,
        ));
        curve.add_point(AutomationPoint::new(1000, 1.0));

        // Step: value stays at 0.0 until the next point
        assert!((curve.evaluate(500) - 0.0).abs() < 0.001);
        assert!((curve.evaluate(999) - 0.0).abs() < 0.001);
    }

    #[test]
    fn smooth_interpolation() {
        let mut curve = AutomationCurve::new(0.0);
        curve.add_point(AutomationPoint::with_interpolation(
            0, 0.0, InterpolationMode::Smooth,
        ));
        curve.add_point(AutomationPoint::new(1000, 1.0));

        let mid = curve.evaluate(500);
        // Smoothstep at 0.5 should be exactly 0.5
        assert!((mid - 0.5).abs() < 0.01);

        // But the approach should be different from linear at other positions
        let quarter = curve.evaluate(250);
        // Smoothstep at 0.25 = 3*(0.0625) - 2*(0.015625) = 0.15625
        assert!((quarter - 0.156).abs() < 0.02);
    }

    #[test]
    fn multiple_segments() {
        let mut curve = AutomationCurve::new(0.0);
        curve.add_point(AutomationPoint::new(0, 0.0));
        curve.add_point(AutomationPoint::new(1000, 1.0));
        curve.add_point(AutomationPoint::new(2000, 0.0));

        assert!((curve.evaluate(500) - 0.5).abs() < 0.01);
        assert!((curve.evaluate(1000) - 1.0).abs() < 0.01);
        assert!((curve.evaluate(1500) - 0.5).abs() < 0.01);
    }

    #[test]
    fn add_point_maintains_order() {
        let mut curve = AutomationCurve::new(0.0);
        curve.add_point(AutomationPoint::new(2000, 1.0));
        curve.add_point(AutomationPoint::new(0, 0.0));
        curve.add_point(AutomationPoint::new(1000, 0.5));

        assert_eq!(curve.points()[0].position, 0);
        assert_eq!(curve.points()[1].position, 1000);
        assert_eq!(curve.points()[2].position, 2000);
    }

    #[test]
    fn add_point_replaces_at_same_position() {
        let mut curve = AutomationCurve::new(0.0);
        curve.add_point(AutomationPoint::new(1000, 0.5));
        curve.add_point(AutomationPoint::new(1000, 0.8));

        assert_eq!(curve.len(), 1);
        assert!((curve.evaluate(1000) - 0.8).abs() < 0.001);
    }

    #[test]
    fn remove_near() {
        let mut curve = AutomationCurve::new(0.0);
        curve.add_point(AutomationPoint::new(1000, 0.5));

        assert!(!curve.remove_near(1050, 10)); // Too far
        assert!(curve.remove_near(1005, 10)); // Within tolerance
        assert!(curve.is_empty());
    }

    #[test]
    fn time_range() {
        let mut curve = AutomationCurve::new(0.0);
        assert!(curve.time_range().is_none());

        curve.add_point(AutomationPoint::new(100, 0.0));
        curve.add_point(AutomationPoint::new(500, 1.0));

        let (start, end) = curve.time_range().unwrap();
        assert_eq!(start, 100);
        assert_eq!(end, 500);
    }

    #[test]
    fn clear_removes_all() {
        let mut curve = AutomationCurve::new(0.0);
        curve.add_point(AutomationPoint::new(0, 0.0));
        curve.add_point(AutomationPoint::new(1000, 1.0));

        curve.clear();
        assert!(curve.is_empty());
    }

    #[test]
    fn values_are_clamped() {
        let point = AutomationPoint::new(0, 5.0);
        assert!((point.value - 1.0).abs() < 0.001);

        let point2 = AutomationPoint::new(0, -3.0);
        assert!((point2.value - 0.0).abs() < 0.001);
    }
}
