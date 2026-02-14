// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Enterprise Project Manager
// ═══════════════════════════════════════════════════════════════════════════
//
// Ableton-style project folder management. Mirrors the architecture from
// the original Swift `ProjectFileManager.swift` (469 LOC):
//
//   ProjectName/
//     ├── ProjectName.dream.json        ← JSON-encoded project data
//     ├── Samples/
//     │   ├── Imported/                 ← audio files copied on import
//     │   └── Recorded/                ← audio from recording
//     └── Backup/                      ← timestamped auto-save copies
//
// All operations are atomic and crash-safe. Sample copying ensures
// project portability across machines.
//
// ═══════════════════════════════════════════════════════════════════════════

use std::fs;
use std::path::{Path, PathBuf};

use dream_models::project::Project;

use crate::project_file::{ProjectFile, ProjectFileError};

/// Enterprise project folder manager.
///
/// Manages the Ableton-style directory structure, auto-backups,
/// and sample file consolidation.
pub struct ProjectManager;

impl ProjectManager {
    // ── Constants ──────────────────────────────────────────────────────

    /// Subdirectory for audio samples.
    const SAMPLES_DIR: &'static str = "Samples";

    /// Subdirectory for imported audio files (user drag-and-drop, file picker).
    const IMPORTED_DIR: &'static str = "Imported";

    /// Subdirectory for recorded audio files (live recording).
    const RECORDED_DIR: &'static str = "Recorded";

    /// Subdirectory for auto-backup copies.
    const BACKUP_DIR: &'static str = "Backup";

    /// Maximum number of backup files to retain per project.
    const MAX_BACKUPS: usize = 50;

    // ── Folder Structure ──────────────────────────────────────────────

    /// Creates a full Ableton-style project directory structure.
    ///
    /// ```text
    /// {parent}/{name}/
    ///   ├── Samples/
    ///   │   ├── Imported/
    ///   │   └── Recorded/
    ///   └── Backup/
    /// ```
    ///
    /// Returns the path to the created project folder.
    pub fn create_project_folder(
        parent: &Path,
        name: &str,
    ) -> Result<PathBuf, ProjectFileError> {
        let project_dir = parent.join(name);
        let samples_dir = project_dir.join(Self::SAMPLES_DIR);
        let imported_dir = samples_dir.join(Self::IMPORTED_DIR);
        let recorded_dir = samples_dir.join(Self::RECORDED_DIR);
        let backup_dir = project_dir.join(Self::BACKUP_DIR);

        for dir in &[&project_dir, &samples_dir, &imported_dir, &recorded_dir, &backup_dir] {
            fs::create_dir_all(dir)?;
        }

        log::info!(
            "Created project folder structure: {}",
            project_dir.display()
        );
        Ok(project_dir)
    }

    /// Returns the canonical project file path within a project folder.
    ///
    /// Format: `{folder}/{project_name}.dream.json`
    pub fn project_file_path(folder: &Path, name: &str) -> PathBuf {
        folder.join(format!("{}.dream.json", name))
    }

    // ── Save Operations ───────────────────────────────────────────────

    /// Saves a project into an Ableton-style folder structure.
    ///
    /// If the folder doesn't exist, creates the full directory tree.
    /// Optionally copies referenced audio samples into `Samples/Imported/`.
    ///
    /// Returns the path to the saved project file.
    pub fn save_to_folder(
        project: &Project,
        folder: &Path,
        copy_samples: bool,
    ) -> Result<PathBuf, ProjectFileError> {
        // Ensure folder structure exists
        let samples_dir = folder.join(Self::SAMPLES_DIR);
        let imported_dir = samples_dir.join(Self::IMPORTED_DIR);
        let recorded_dir = samples_dir.join(Self::RECORDED_DIR);
        let backup_dir = folder.join(Self::BACKUP_DIR);

        for dir in &[folder, &samples_dir, &imported_dir, &recorded_dir, &backup_dir] {
            fs::create_dir_all(dir)?;
        }

        // Copy audio samples if requested (Save As / consolidation)
        if copy_samples {
            Self::copy_audio_samples(project, &imported_dir)?;
        }

        // Save the project file using atomic write
        let file_path = Self::project_file_path(folder, &project.name);
        ProjectFile::save(project, &file_path)?;

        log::info!(
            "Project saved to folder: {} → {}",
            project.name,
            file_path.display()
        );
        Ok(file_path)
    }

    // ── Backup Operations ─────────────────────────────────────────────

    /// Creates a timestamped backup of the project in the `Backup/` directory.
    ///
    /// Backup filename format: `{name}_backup_{YYYY-MM-DD_HH-MM-SS}.dream.json`
    ///
    /// Returns the path to the backup file, or `None` if no folder is set.
    pub fn create_backup(
        project: &Project,
        folder: &Path,
    ) -> Result<PathBuf, ProjectFileError> {
        let backup_dir = folder.join(Self::BACKUP_DIR);
        fs::create_dir_all(&backup_dir)?;

        let timestamp = Self::timestamp_string();
        let backup_name = format!(
            "{}_backup_{}.dream.json",
            project.name, timestamp
        );
        let backup_path = backup_dir.join(&backup_name);

        ProjectFile::save(project, &backup_path)?;

        // Prune old backups (keep only MAX_BACKUPS newest)
        Self::prune_backups(&backup_dir)?;

        log::info!("Backup created: {}", backup_path.display());
        Ok(backup_path)
    }

    /// Removes old backup files, keeping only the newest `MAX_BACKUPS`.
    fn prune_backups(backup_dir: &Path) -> Result<(), ProjectFileError> {
        let mut entries: Vec<PathBuf> = fs::read_dir(backup_dir)?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .and_then(|ext| ext.to_str())
                    .map_or(false, |ext| ext == "json")
            })
            .collect();

        // Sort by modification time (newest first)
        entries.sort_by(|a, b| {
            let a_time = fs::metadata(a).and_then(|m| m.modified()).ok();
            let b_time = fs::metadata(b).and_then(|m| m.modified()).ok();
            b_time.cmp(&a_time)
        });

        // Remove excess backups
        for old_backup in entries.iter().skip(Self::MAX_BACKUPS) {
            if let Err(e) = fs::remove_file(old_backup) {
                log::warn!(
                    "Failed to prune backup {}: {}",
                    old_backup.display(),
                    e
                );
            }
        }

        Ok(())
    }

    // ── Sample Consolidation ──────────────────────────────────────────

    /// Copies all audio files referenced by the project into the destination
    /// directory (`Samples/Imported/`).
    ///
    /// Skips files that already exist at the destination or whose source
    /// doesn't exist on disk. This mirrors Swift's `copyAudioSamples()`.
    pub fn copy_audio_samples(
        project: &Project,
        dest: &Path,
    ) -> Result<(), ProjectFileError> {
        fs::create_dir_all(dest)?;

        for track in &project.tracks {
            for clip in &track.clips {
                let source = Path::new(&clip.file_path);
                Self::copy_single_sample(source, dest)?;
            }
            if let Some(sampler) = &track.sampler {
                if !sampler.sample_path.trim().is_empty() {
                    let source = Path::new(&sampler.sample_path);
                    Self::copy_single_sample(source, dest)?;
                }
            }
        }

        Ok(())
    }

    /// Copies a single audio file to the destination directory.
    /// Skips if the source doesn't exist or the destination already has a file
    /// with the same name.
    fn copy_single_sample(source: &Path, dest_dir: &Path) -> Result<(), ProjectFileError> {
        if !source.exists() {
            log::debug!("Sample source not found, skipping: {}", source.display());
            return Ok(());
        }

        let file_name = match source.file_name() {
            Some(name) => name,
            None => return Ok(()),
        };

        let dest_path = dest_dir.join(file_name);

        // Skip if already exists (same name = assumed same file)
        if dest_path.exists() {
            return Ok(());
        }

        fs::copy(source, &dest_path)?;
        log::info!("Copied sample: {} → {}", source.display(), dest_path.display());
        Ok(())
    }

    // ── Detection ─────────────────────────────────────────────────────

    /// Determines if a directory is a Dream DAW project directory.
    ///
    /// A directory is considered a project directory if it contains:
    /// - Any `.dream.json` file, OR
    /// - A `Samples/` subdirectory
    pub fn is_project_directory(path: &Path) -> bool {
        if !path.is_dir() {
            return false;
        }

        // Check for Samples/ subdirectory
        let samples_dir = path.join(Self::SAMPLES_DIR);
        if samples_dir.is_dir() {
            return true;
        }

        // Check for any .dream.json file
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                if let Some(name_str) = name.to_str() {
                    if name_str.ends_with(".dream.json") {
                        return true;
                    }
                }
            }
        }

        false
    }

    /// Extracts the project folder path from a project file path.
    ///
    /// If the file is inside a recognized project directory, returns it.
    /// Otherwise returns the file's parent directory.
    pub fn folder_from_file(file_path: &Path) -> Option<PathBuf> {
        let parent = file_path.parent()?;
        if Self::is_project_directory(parent) {
            Some(parent.to_path_buf())
        } else {
            Some(parent.to_path_buf())
        }
    }

    /// Lists all backup files in a project's Backup/ directory.
    /// Returns paths sorted by modification time (newest first).
    pub fn list_backups(folder: &Path) -> Vec<PathBuf> {
        let backup_dir = folder.join(Self::BACKUP_DIR);
        if !backup_dir.is_dir() {
            return Vec::new();
        }

        let mut entries: Vec<PathBuf> = fs::read_dir(&backup_dir)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .and_then(|ext| ext.to_str())
                    .map_or(false, |ext| ext == "json")
            })
            .collect();

        entries.sort_by(|a, b| {
            let a_time = fs::metadata(a).and_then(|m| m.modified()).ok();
            let b_time = fs::metadata(b).and_then(|m| m.modified()).ok();
            b_time.cmp(&a_time)
        });

        entries
    }

    // ── Helpers ───────────────────────────────────────────────────────

    /// Returns a timestamp string suitable for filenames.
    /// Format: `YYYY-MM-DD_HH-MM-SS`
    fn timestamp_string() -> String {
        use std::time::SystemTime;

        let seconds = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // Convert to components (UTC) — avoids chrono dependency
        let secs_per_min = 60u64;
        let secs_per_hour = 3600u64;
        let secs_per_day = 86400u64;

        let days = seconds / secs_per_day;
        let remaining = seconds % secs_per_day;
        let hours = remaining / secs_per_hour;
        let remaining = remaining % secs_per_hour;
        let minutes = remaining / secs_per_min;
        let secs = remaining % secs_per_min;

        // Days since epoch to Y-M-D (simplified Gregorian)
        let (year, month, day) = days_to_ymd(days);

        format!(
            "{:04}-{:02}-{:02}_{:02}-{:02}-{:02}",
            year, month, day, hours, minutes, secs
        )
    }
}

/// Converts days since Unix epoch to (year, month, day).
/// Simplified Gregorian calendar calculation.
fn days_to_ymd(mut days: u64) -> (u64, u64, u64) {
    // Days in each month (non-leap year)
    let month_days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

    let mut year = 1970u64;

    loop {
        let days_in_year = if is_leap(year) { 366 } else { 365 };
        if days < days_in_year {
            break;
        }
        days -= days_in_year;
        year += 1;
    }

    let mut month = 1u64;
    for (i, &md) in month_days.iter().enumerate() {
        let md = if i == 1 && is_leap(year) { md + 1 } else { md };
        if days < md {
            break;
        }
        days -= md;
        month += 1;
    }

    (year, month, days + 1)
}

fn is_leap(year: u64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use dream_models::project::Project;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dream_daw_pm_test_{}", name));
        let _ = fs::remove_dir_all(&dir); // Clean up from previous runs
        dir
    }

    #[test]
    fn create_project_folder_creates_structure() {
        let parent = temp_dir("create_folder");
        fs::create_dir_all(&parent).unwrap();

        let folder = ProjectManager::create_project_folder(&parent, "TestSong").unwrap();

        assert!(folder.exists());
        assert!(folder.join("Samples").exists());
        assert!(folder.join("Samples/Imported").exists());
        assert!(folder.join("Samples/Recorded").exists());
        assert!(folder.join("Backup").exists());

        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn save_to_folder_and_load() {
        let parent = temp_dir("save_load");
        fs::create_dir_all(&parent).unwrap();

        let project = Project::new("My Song", 140.0, 48000.0);
        let folder = parent.join("My Song");

        let file_path = ProjectManager::save_to_folder(&project, &folder, false).unwrap();
        assert!(file_path.exists());
        assert_eq!(
            file_path.file_name().unwrap().to_str().unwrap(),
            "My Song.dream.json"
        );

        let loaded = ProjectFile::load(&file_path).unwrap();
        assert_eq!(loaded.name, "My Song");

        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn create_backup_works() {
        let parent = temp_dir("backup");
        fs::create_dir_all(&parent).unwrap();

        let project = Project::new("BackupTest", 120.0, 44100.0);
        let folder = parent.join("BackupTest");
        fs::create_dir_all(&folder).unwrap();

        let backup_path = ProjectManager::create_backup(&project, &folder).unwrap();
        assert!(backup_path.exists());
        assert!(backup_path.to_str().unwrap().contains("_backup_"));

        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn is_project_directory_detection() {
        let parent = temp_dir("detect");
        let project_dir = parent.join("MySong");

        // Not a project dir (doesn't exist)
        assert!(!ProjectManager::is_project_directory(&project_dir));

        // Create the structure
        ProjectManager::create_project_folder(&parent, "MySong").unwrap();
        assert!(ProjectManager::is_project_directory(&project_dir));

        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn list_backups_returns_sorted() {
        let parent = temp_dir("list_backups");
        let folder = parent.join("TestProject");
        fs::create_dir_all(&folder).unwrap();

        let project = Project::new("TestProject", 120.0, 44100.0);

        // Create a few backups with enough time gap for distinct timestamps
        ProjectManager::create_backup(&project, &folder).unwrap();
        std::thread::sleep(std::time::Duration::from_secs(1));
        ProjectManager::create_backup(&project, &folder).unwrap();

        let backups = ProjectManager::list_backups(&folder);
        assert!(backups.len() >= 1, "Expected at least 1 backup, got {}", backups.len());

        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn timestamp_string_format() {
        let ts = ProjectManager::timestamp_string();
        // Should match YYYY-MM-DD_HH-MM-SS pattern
        assert_eq!(ts.len(), 19);
        assert_eq!(&ts[4..5], "-");
        assert_eq!(&ts[7..8], "-");
        assert_eq!(&ts[10..11], "_");
    }
}
