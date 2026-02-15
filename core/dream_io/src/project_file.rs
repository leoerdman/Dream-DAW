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
        // ── Step 1: Parse raw JSON to inspect format_version ─────────
        let raw: serde_json::Value = serde_json::from_str(data)
            .map_err(|e| ProjectFileError::SerializationError(e.to_string()))?;

        // Detect whether this is an envelope or a legacy raw-Project.
        let (mut doc, from_version) = if raw.get("format_version").is_some() {
            let version = raw["format_version"].as_u64().unwrap_or(1) as u32;
            if version > PROJECT_FORMAT_VERSION {
                return Err(ProjectFileError::UnsupportedFormatVersion {
                    found: version,
                    supported: PROJECT_FORMAT_VERSION,
                });
            }
            let project_val = raw.get("project").cloned().ok_or_else(|| {
                ProjectFileError::SerializationError(
                    "Envelope missing 'project' field".to_string(),
                )
            })?;
            (project_val, version)
        } else {
            // Legacy V1: raw Project JSON without envelope.
            (raw, 1)
        };

        // ── Step 2: Apply JSON-level migrations ─────────────────────
        if from_version < 3 {
            Self::migrate_v2_to_v3(&mut doc);
        }

        // ── Step 3: Deserialize the (possibly migrated) JSON ────────
        let mut project: Project = serde_json::from_value(doc)
            .map_err(|e| ProjectFileError::SerializationError(e.to_string()))?;

        // ── Step 4: Post-deserialization migrations ──────────────────
        Self::migrate_project_post(&mut project, from_version);

        Ok(project)
    }

    /// V2→V3 migration (JSON level).
    ///
    /// Old projects store `track.effects` as `[{PluginSlot fields...}]` and
    /// `track.instrument` as `{PluginSlot fields...}`. The new DeviceNode enum
    /// uses `#[serde(tag = "type")]` which expects a `"type"` discriminator.
    ///
    /// This migration injects `"type": "Single"` into every effect/instrument
    /// entry that doesn't already have it, making them deserializable as
    /// `DeviceNode::Single(PluginSlot { ... })`.
    fn migrate_v2_to_v3(project_val: &mut serde_json::Value) {
        let tracks = match project_val.get_mut("tracks").and_then(|t| t.as_array_mut()) {
            Some(t) => t,
            None => return,
        };

        for track in tracks.iter_mut() {
            // ── effects: Vec<DeviceNode> ────────────────────────────
            if let Some(effects) = track.get_mut("effects").and_then(|e| e.as_array_mut()) {
                for fx in effects.iter_mut() {
                    Self::inject_device_node_type(fx);
                }
            }

            // ── instrument: Option<DeviceNode> ──────────────────────
            if let Some(inst) = track.get_mut("instrument") {
                if !inst.is_null() {
                    Self::inject_device_node_type(inst);
                }
            }
        }
    }

    /// Injects `"type": "Single"` into a JSON object if:
    /// 1. It's an object.
    /// 2. It doesn't already have a `"type"` field.
    ///
    /// Objects that already have `"type": "Single"` or `"type": "Rack"` are
    /// left untouched (V3+ format or nested rack structures).
    fn inject_device_node_type(val: &mut serde_json::Value) {
        if let Some(obj) = val.as_object_mut() {
            if !obj.contains_key("type") {
                obj.insert(
                    "type".to_string(),
                    serde_json::Value::String("Single".to_string()),
                );
            }
        }
    }

    /// Post-deserialization migrations (operates on typed Rust structs).
    fn migrate_project_post(project: &mut Project, from_version: u32) {
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
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use dream_models::midi::{MidiClip, MidiNote, SamplerConfig};
    use dream_models::project::{AudioClip, AutomationLane, AutomationPoint, DeviceNode, PluginSlot, TimeSignature, Track, TrackColor, TrackType};
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
        midi_track.instrument = Some(DeviceNode::Single(PluginSlot::new("Sampler", "internal://instrument/sampler")));
        midi_track.effects.push(DeviceNode::Single(PluginSlot::new("Utility", "internal://effect/utility")));
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
            lfo_rate: 1.0,
            lfo_depth: 0.0,
            lfo_target: 0,
            pulse_width: 0.5,
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

    #[test]
    fn migrate_v2_project_wraps_plugin_slots_in_device_node() {
        let path = temp_path("v2_migration_test");

        // ── Step 1: Create a real V3 project with DeviceNode wrappers ──
        let mut project = Project::new("Legacy V2", 120.0, 44100.0);
        let mut midi_track = Track::with_type("MIDI 1", TrackType::Midi, 0);
        midi_track.instrument = Some(DeviceNode::Single(PluginSlot::new(
            "Wave Synth",
            "internal://instrument/wave-synth",
        )));
        midi_track.effects.push(DeviceNode::Single(PluginSlot {
            id: uuid::Uuid::new_v4(),
            name: "EQ".into(),
            plugin_id: "internal://effect/eq".into(),
            is_bypassed: false,
            latency_frames: 32,
            external_format: None,
            external_uid: None,
            external_preset_name: None,
            external_program_number: None,
            external_parameter_count: None,
            external_stored_all_parameters: None,
            external_plugin_version: None,
        }));
        midi_track.effects.push(DeviceNode::Single(PluginSlot {
            id: uuid::Uuid::new_v4(),
            name: "Reverb".into(),
            plugin_id: "internal://effect/reverb".into(),
            is_bypassed: true,
            latency_frames: 64,
            external_format: None,
            external_uid: None,
            external_preset_name: None,
            external_program_number: None,
            external_parameter_count: None,
            external_stored_all_parameters: None,
            external_plugin_version: None,
        }));
        project.add_track(midi_track);

        // ── Step 2: Serialize as V3 envelope, then downgrade to V2 ─────
        let envelope = serde_json::json!({
            "format_version": 2,
            "project": serde_json::to_value(&project).unwrap()
        });
        let mut doc: serde_json::Value = envelope;

        // Strip all "type" fields from within effects and instrument to
        // simulate what a genuine V2 project file would look like.
        if let Some(tracks) = doc["project"]["tracks"].as_array_mut() {
            for track in tracks.iter_mut() {
                if let Some(effects) = track.get_mut("effects").and_then(|e| e.as_array_mut()) {
                    for fx in effects.iter_mut() {
                        if let Some(obj) = fx.as_object_mut() {
                            obj.remove("type");
                        }
                    }
                }
                if let Some(inst) = track.get_mut("instrument") {
                    if let Some(obj) = inst.as_object_mut() {
                        obj.remove("type");
                    }
                }
            }
        }

        fs::write(&path, serde_json::to_string_pretty(&doc).unwrap()).unwrap();

        // ── Step 3: Load through the migration pipeline ────────────────
        let loaded = ProjectFile::load(&path).unwrap();

        assert_eq!(loaded.name, "Legacy V2");
        assert_eq!(loaded.tracks.len(), 1);

        let track = &loaded.tracks[0];

        // Instrument migrated to DeviceNode::Single.
        let inst = track.instrument.as_ref().expect("instrument should exist");
        assert_eq!(inst.name(), "Wave Synth");
        assert_eq!(inst.plugin_id(), "internal://instrument/wave-synth");
        assert!(!inst.is_bypassed());

        // Effects migrated to DeviceNode::Single.
        assert_eq!(track.effects.len(), 2);
        assert_eq!(track.effects[0].name(), "EQ");
        assert_eq!(track.effects[0].plugin_id(), "internal://effect/eq");
        assert!(!track.effects[0].is_bypassed());
        assert_eq!(track.effects[0].latency_frames(), 32);

        assert_eq!(track.effects[1].name(), "Reverb");
        assert!(track.effects[1].is_bypassed());
        assert_eq!(track.effects[1].latency_frames(), 64);

        // Latency: only non-bypassed devices count.
        assert_eq!(track.total_latency_frames(), 32);

        let _ = fs::remove_file(&path);
    }
}
