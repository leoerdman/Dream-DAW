// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Project File Serialization
// ═══════════════════════════════════════════════════════════════════════════
//
// Handles saving/loading Dream DAW project files (.dream).
//
// Format: JSON with optional zstd compression.
//   - .dream     → compressed JSON (production)
//   - .dream.json → uncompressed JSON (debug/human-readable)
//
// The Project struct from dream_models is the canonical serialization target.
//
// ═══════════════════════════════════════════════════════════════════════════

use std::fs;
use std::io::Write;
use std::path::Path;

use dream_models::project::{Project, PROJECT_FORMAT_VERSION};
use serde::{Deserialize, Serialize};

/// Errors during project file operations.
#[derive(Debug)]
pub enum ProjectFileError {
    /// File I/O error.
    IoError(std::io::Error),

    /// JSON serialization/deserialization error.
    SerializationError(String),

    /// Project file format version is newer than this build supports.
    UnsupportedFormatVersion {
        found: u32,
        supported: u32,
    },
}

impl std::fmt::Display for ProjectFileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::IoError(e) => write!(f, "Project file I/O error: {e}"),
            Self::SerializationError(e) => write!(f, "Serialization error: {e}"),
            Self::UnsupportedFormatVersion { found, supported } => write!(
                f,
                "Unsupported project format version {found} (this build supports up to {supported})"
            ),
        }
    }
}

impl std::error::Error for ProjectFileError {}

impl From<std::io::Error> for ProjectFileError {
    fn from(e: std::io::Error) -> Self {
        Self::IoError(e)
    }
}

/// Handles saving and loading Dream DAW project files.
pub struct ProjectFile;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectEnvelope {
    format_version: u32,
    project: Project,
}

impl ProjectFile {
    /// Saves a project to a JSON file using atomic write.
    ///
    /// Strategy: write → fsync → backup → rename
    /// This ensures crash-safety: if the process dies at any point,
    /// either the old file or the new file is complete on disk.
    ///
    /// # Arguments
    /// - `project`: The project to save.
    /// - `path`: Destination file path (typically `.dream.json`).
    pub fn save(project: &Project, path: impl AsRef<Path>) -> Result<(), ProjectFileError> {
        let path = path.as_ref();

        let envelope = ProjectEnvelope {
            format_version: PROJECT_FORMAT_VERSION,
            project: project.clone(),
        };

        let json = serde_json::to_string_pretty(&envelope)
            .map_err(|e| ProjectFileError::SerializationError(e.to_string()))?;

        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        // ── Step 1: Write to temp file ──────────────────────────────
        let tmp_path = path.with_extension("tmp");
        {
            let mut file = fs::File::create(&tmp_path)?;
            file.write_all(json.as_bytes())?;
            // ── Step 2: fsync — flush to disk before rename ─────────
            file.sync_all()?;
        }

        // ── Step 3: Backup existing file (non-fatal if fails) ──────
        if path.exists() {
            let bak_path = path.with_extension("bak");
            if let Err(e) = fs::rename(path, &bak_path) {
                log::warn!(
                    "Could not create backup {}: {}",
                    bak_path.display(),
                    e
                );
                // Fall through — still try to save
            }
        }

        // ── Step 4: Atomic rename temp → target ────────────────────
        fs::rename(&tmp_path, path)?;

        log::info!(
            "Project saved (atomic): {} ({} bytes)",
            path.display(),
            json.len()
        );

        Ok(())
    }

    /// Loads a project from a JSON file.
    ///
    /// # Arguments
    /// - `path`: Path to the project file (`.dream.json`).
    pub fn load(path: impl AsRef<Path>) -> Result<Project, ProjectFileError> {
        let path = path.as_ref();
        let bak_path = path.with_extension("bak");

        let project = match fs::read_to_string(path) {
            Ok(data) => match Self::parse_project_document(&data) {
                Ok(project) => project,
                Err(err) => {
                    if bak_path.exists() {
                        log::warn!(
                            "Primary project file failed to parse ({}). Attempting backup: {}",
                            err,
                            bak_path.display()
                        );
                        let backup_data = fs::read_to_string(&bak_path)?;
                        Self::parse_project_document(&backup_data)?
                    } else {
                        return Err(err);
                    }
                }
            },
            Err(primary_read_err) => {
                if bak_path.exists() {
                    log::warn!(
                        "Primary project file could not be read ({}). Attempting backup: {}",
                        primary_read_err,
                        bak_path.display()
                    );
                    let backup_data = fs::read_to_string(&bak_path)?;
                    Self::parse_project_document(&backup_data)?
                } else {
                    return Err(ProjectFileError::IoError(primary_read_err));
                }
            }
        };

        log::info!(
            "Project loaded: {} — '{}' ({} tracks)",
            path.display(),
            project.name,
            project.track_count(),
        );

        Ok(project)
    }

    /// Validates a project file without fully loading it.
    ///
    /// Returns `true` if the file can be parsed as a valid Project.
    pub fn validate(path: impl AsRef<Path>) -> bool {
        Self::load(path).is_ok()
    }

    fn parse_project_document(data: &str) -> Result<Project, ProjectFileError> {
        // V2+ envelope format.
        if let Ok(envelope) = serde_json::from_str::<ProjectEnvelope>(data) {
            if envelope.format_version > PROJECT_FORMAT_VERSION {
                return Err(ProjectFileError::UnsupportedFormatVersion {
                    found: envelope.format_version,
                    supported: PROJECT_FORMAT_VERSION,
                });
            }
            return Ok(Self::migrate_project(envelope.project, envelope.format_version));
        }

        // Legacy V1 raw-Project format compatibility.
        if let Ok(project) = serde_json::from_str::<Project>(data) {
            return Ok(Self::migrate_project(project, 1));
        }

        Err(ProjectFileError::SerializationError(
            "Failed to parse project as envelope or legacy project format".to_string(),
        ))
    }

    fn migrate_project(mut project: Project, from_version: u32) -> Project {
        // Placeholder migration pipeline.
        // Keep deterministic defaults for fields introduced after legacy versions.
        if from_version < 2 {
            // Ensure loop invariants are sane for legacy projects.
            if let (Some(start), Some(end)) = (project.loop_start_frames, project.loop_end_frames)
                && end <= start
            {
                project.loop_start_frames = None;
                project.loop_end_frames = None;
                project.is_looping = false;
            }
        }
        project
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use dream_models::midi::{MidiClip, MidiNote, SamplerConfig};
    use dream_models::project::{AudioClip, AutomationLane, AutomationPoint, PluginSlot, TimeSignature, Track, TrackColor, TrackType};
    use dream_models::time::AbsoluteTime;
    use std::path::PathBuf;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("dream_daw_test_{name}.dream.json"))
    }

    #[test]
    fn save_and_load_roundtrip() {
        let path = temp_path("roundtrip");

        let mut project = Project::new("Test Song", 128.0, 44100.0);
        let mut track = Track::new("Drums");
        track.volume = 0.85;
        track.pan = -0.3;
        track.clips.push(AudioClip::new(
            "Kick",
            "audio/kick.wav",
            AbsoluteTime::ZERO,
            AbsoluteTime::new(22050),
        ));
        project.add_track(track);

        // Save
        ProjectFile::save(&project, &path).unwrap();

        // Load
        let loaded = ProjectFile::load(&path).unwrap();

        assert_eq!(loaded.name, "Test Song");
        assert_eq!(loaded.track_count(), 1);
        assert_eq!(loaded.tracks[0].name, "Drums");
        assert!((loaded.tracks[0].volume - 0.85).abs() < 0.001);
        assert!((loaded.tracks[0].pan - (-0.3)).abs() < 0.001);
        assert_eq!(loaded.tracks[0].clips.len(), 1);
        assert_eq!(loaded.tracks[0].clips[0].name, "Kick");

        // Cleanup
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn validate_good_file() {
        let path = temp_path("validate_good");
        let project = Project::default();
        ProjectFile::save(&project, &path).unwrap();

        assert!(ProjectFile::validate(&path));

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn validate_bad_file() {
        let path = temp_path("validate_bad");
        fs::write(&path, "not valid json").unwrap();

        assert!(!ProjectFile::validate(&path));

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn load_legacy_raw_project_format() {
        let path = temp_path("legacy_raw_format");

        let project = Project::new("Legacy Project", 120.0, 44100.0);
        let legacy_json = serde_json::to_string_pretty(&project).unwrap();
        fs::write(&path, legacy_json).unwrap();

        let loaded = ProjectFile::load(&path).unwrap();
        assert_eq!(loaded.name, "Legacy Project");

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn load_uses_backup_when_primary_is_corrupt() {
        let path = temp_path("load_backup_on_corrupt_primary");
        let bak = path.with_extension("bak");

        fs::write(&path, "{this is corrupt json").unwrap();

        let project = Project::new("Recovered", 124.0, 44100.0);
        let envelope = ProjectEnvelope {
            format_version: PROJECT_FORMAT_VERSION,
            project,
        };
        fs::write(&bak, serde_json::to_string_pretty(&envelope).unwrap()).unwrap();

        let loaded = ProjectFile::load(&path).unwrap();
        assert_eq!(loaded.name, "Recovered");

        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(&bak);
    }

    #[test]
    fn reject_future_project_format() {
        let path = temp_path("reject_future_format");
        let project = Project::new("Future", 128.0, 44100.0);
        let future_envelope = serde_json::json!({
            "format_version": PROJECT_FORMAT_VERSION + 10,
            "project": project
        });
        fs::write(&path, serde_json::to_string_pretty(&future_envelope).unwrap()).unwrap();

        let err = ProjectFile::load(&path).unwrap_err();
        match err {
            ProjectFileError::UnsupportedFormatVersion { found, supported } => {
                assert_eq!(found, PROJECT_FORMAT_VERSION + 10);
                assert_eq!(supported, PROJECT_FORMAT_VERSION);
            }
            other => panic!("Unexpected error variant: {other}"),
        }

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn load_nonexistent_returns_error() {
        let result = ProjectFile::load("/nonexistent/project.dream.json");
        assert!(result.is_err());
    }

    #[test]
    fn error_display() {
        let err = ProjectFileError::SerializationError("bad json".into());
        assert_eq!(format!("{err}"), "Serialization error: bad json");
    }

    #[test]
    fn save_load_preserves_full_project_state() {
        let path = temp_path("full_state_roundtrip");

        let mut project = Project::new("Full State", 172.0, 44100.0);
        project.time_signature = TimeSignature::new(4, 4);
        project.view_zoom_scale = Some(22.0);
        project.view_scroll_position = Some(64.0);
        project.playhead_position_frames = 123_456;
        project.is_looping = true;
        project.loop_start_frames = Some(44_100);
        project.loop_end_frames = Some(88_200);

        let mut midi_track = Track::with_type("MIDI 1", TrackType::Midi, 0);
        midi_track.volume = 0.77;
        midi_track.pan = -0.15;
        midi_track.instrument = Some(PluginSlot::new("Sampler", "internal://instrument/sampler"));
        midi_track.effects.push(PluginSlot::new("Utility", "internal://effect/utility"));
        midi_track.sampler = Some(SamplerConfig {
            sample_path: "Samples/snare.wav".to_string(),
            root_note: 60,
            volume: 0.9,
            attack: 0.01,
            decay: 0.12,
            sustain: 0.85,
            release: 0.09,
            osc2_waveform: 2,
            osc_mix: 0.42,
            detune_cents: 7.0,
            sub_level: 0.18,
            filter_cutoff: 20000.0,
            filter_resonance: 0.0,
            filter_type: 0,
        });
        midi_track.automation_lanes.push(AutomationLane {
            param_id: "volume".to_string(),
            points: vec![
                AutomationPoint { beat: 4.0, value: 0.5, curve_type: "linear".to_string(), tension: None },
                AutomationPoint { beat: 8.0, value: 0.8, curve_type: "bezier".to_string(), tension: Some(0.35) },
            ],
        });

        let mut midi_clip = MidiClip::new(
            "Pattern A",
            AbsoluteTime::new(44_100),
            AbsoluteTime::new(44_100),
        );
        midi_clip.add_note(MidiNote::new(60, 110, 0, 11_025));
        midi_clip.add_note(MidiNote::new(64, 100, 11_025, 11_025));
        midi_track.midi_clips.push(midi_clip);

        let mut audio_track = Track::with_type("Audio 1", TrackType::Audio, 1);
        audio_track.color = TrackColor::Orange;
        audio_track.clips.push(AudioClip::new(
            "Kick",
            "Samples/kick.wav",
            AbsoluteTime::new(88_200),
            AbsoluteTime::new(22_050),
        ));

        project.add_track(midi_track);
        project.add_track(audio_track);

        ProjectFile::save(&project, &path).unwrap();
        let loaded = ProjectFile::load(&path).unwrap();

        assert!((loaded.pulse_map.initial_bpm() - 172.0).abs() < f64::EPSILON);
        assert_eq!(loaded.time_signature, TimeSignature::new(4, 4));
        assert_eq!(loaded.playhead_position_frames, 123_456);
        assert!(loaded.is_looping);
        assert_eq!(loaded.loop_start_frames, Some(44_100));
        assert_eq!(loaded.loop_end_frames, Some(88_200));
        assert_eq!(loaded.view_zoom_scale, Some(22.0));
        assert_eq!(loaded.view_scroll_position, Some(64.0));

        assert_eq!(loaded.tracks.len(), 2);
        assert_eq!(loaded.tracks[0].track_type, TrackType::Midi);
        assert!(loaded.tracks[0].instrument.is_some());
        assert_eq!(loaded.tracks[0].effects.len(), 1);
        assert!(loaded.tracks[0].sampler.is_some());
        assert_eq!(loaded.tracks[0].automation_lanes.len(), 1);
        assert_eq!(loaded.tracks[0].midi_clips.len(), 1);
        assert_eq!(loaded.tracks[0].midi_clips[0].notes.len(), 2);

        assert_eq!(loaded.tracks[1].track_type, TrackType::Audio);
        assert_eq!(loaded.tracks[1].clips.len(), 1);
        assert_eq!(loaded.tracks[1].clips[0].file_path, "Samples/kick.wav");

        let _ = fs::remove_file(&path);
    }
}
