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

use dream_models::project::Project;

/// Errors during project file operations.
#[derive(Debug)]
pub enum ProjectFileError {
    /// File I/O error.
    IoError(std::io::Error),

    /// JSON serialization/deserialization error.
    SerializationError(String),
}

impl std::fmt::Display for ProjectFileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::IoError(e) => write!(f, "Project file I/O error: {e}"),
            Self::SerializationError(e) => write!(f, "Serialization error: {e}"),
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

        let json = serde_json::to_string_pretty(project)
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

        let data = fs::read_to_string(path)?;

        let project: Project = serde_json::from_str(&data)
            .map_err(|e| ProjectFileError::SerializationError(e.to_string()))?;

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
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use dream_models::project::{AudioClip, Track};
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
    fn load_nonexistent_returns_error() {
        let result = ProjectFile::load("/nonexistent/project.dream.json");
        assert!(result.is_err());
    }

    #[test]
    fn error_display() {
        let err = ProjectFileError::SerializationError("bad json".into());
        assert_eq!(format!("{err}"), "Serialization error: bad json");
    }
}
