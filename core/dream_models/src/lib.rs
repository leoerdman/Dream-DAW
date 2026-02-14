// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Core Data Models (The Skeleton)
// ═══════════════════════════════════════════════════════════════════════════
//
// This crate contains ZERO logic — only data structures and type definitions.
// It is the Single Source of Truth (SSOT) for the entire system:
//
//   1. Rust crates import these types for business logic.
//   2. `ts-rs` auto-generates TypeScript interfaces at compile time.
//   3. The frontend reads these generated `.ts` files — zero manual sync.
//
// The `#[ts(export)]` macro ensures that every struct change in Rust
// is immediately reflected in TypeScript. Type drift is impossible.
//
// ═══════════════════════════════════════════════════════════════════════════

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub mod midi;
pub mod mutators;
pub mod preset;
pub mod project;
pub mod pulse_map;
pub mod spatial_grid;
pub mod time;

// ── Playback State ──────────────────────────────────────────────────────

/// The current state of the audio engine's transport.
///
/// This is the canonical representation shared between:
/// - Rust audio engine (writes most fields)
/// - Tauri IPC bridge (serializes to frontend)
/// - React UI (reads via auto-generated TypeScript bindings)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PlaybackState {
    /// Whether the audio engine is currently playing.
    pub is_playing: bool,

    /// Current tempo in beats per minute.
    /// Range: 20.0 – 999.0 BPM. Stored as f64 for sub-BPM precision
    /// (critical for tempo automation curves).
    pub bpm: f64,

    /// Test tone frequency in Hz (Phase 1 only — replaced by graph routing later).
    pub test_tone_freq: f32,

    /// Audio sample rate (Hz).
    pub sample_rate: f64,

    /// Whether loop mode is enabled.
    pub loop_enabled: bool,

    /// Loop start position in sample frames.
    pub loop_start: i64,

    /// Loop end position in sample frames.
    pub loop_end: i64,
}

impl Default for PlaybackState {
    fn default() -> Self {
        Self {
            is_playing: false,
            bpm: 120.0,
            test_tone_freq: 440.0,
            sample_rate: 44100.0,
            loop_enabled: false,
            // Default loop region: bars 9–17 (beats 32–64 at 120 BPM / 44100 SR).
            // At 120 BPM, 1 beat = 0.5 seconds = 22050 frames.
            loop_start: 32 * 22050, // beat 32 = bar 9 = frame 705600
            loop_end: 64 * 22050,   // beat 64 = bar 17 = frame 1411200
        }
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::Project;
    use std::path::PathBuf;

    #[test]
    fn playback_state_serializes_to_json() {
        let state = PlaybackState::default();
        let json = serde_json::to_string(&state).expect("serialization failed");
        assert!(json.contains("\"is_playing\":false"));
        assert!(json.contains("\"bpm\":120.0"));
        assert!(json.contains("\"test_tone_freq\":440.0"));
        assert!(json.contains("\"sample_rate\":44100.0"));
    }

    #[test]
    fn playback_state_roundtrips() {
        let state = PlaybackState {
            is_playing: true,
            bpm: 140.5,
            test_tone_freq: 880.0,
            sample_rate: 48000.0,
            loop_enabled: true,
            loop_start: 705600,
            loop_end: 1411200,
        };
        let json = serde_json::to_string(&state).expect("serialize");
        let deserialized: PlaybackState = serde_json::from_str(&json).expect("deserialize");
        assert!(deserialized.is_playing);
        assert!((deserialized.bpm - 140.5).abs() < f64::EPSILON);
        assert!((deserialized.test_tone_freq - 880.0).abs() < f32::EPSILON);
        assert!(deserialized.loop_enabled);
        assert_eq!(deserialized.loop_start, 705600);
    }

    /// Export the complete model graph to `core/dream_models/bindings`.
    ///
    /// `scripts/sync_bindings.sh` copies this directory to frontend type folders,
    /// so this must stay deterministic and up-to-date.
    #[test]
    fn export_typescript_bindings() {
        let out_dir: PathBuf = [env!("CARGO_MANIFEST_DIR"), "bindings"].iter().collect();
        std::fs::create_dir_all(&out_dir).expect("create bindings dir");
        let config = ts_rs::Config::new().with_out_dir(out_dir);
        PlaybackState::export_all(&config).expect("ts-rs export failed for PlaybackState");
        Project::export_all(&config).expect("ts-rs export failed for Project model graph");
    }
}
