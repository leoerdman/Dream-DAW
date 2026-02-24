// ═══════════════════════════════════════════════════════════════════════
// Application Settings & Recent Projects
//
// Extracted from lib.rs — pure serialization/deserialization logic.
// Zero Tauri dependency.
// ═══════════════════════════════════════════════════════════════════════

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

// ── Application Settings State ────────────────────────────────────────

/// Persisted application settings.
///
/// Mirrors the Swift `AppSettings` — stored as `settings.json` in the
/// user folder's `User Info/` directory (matching Swift convention).
/// Path: `{user_folder_path}/User Info/settings.json`
///
/// Uses camelCase serialization to maintain compatibility with the
/// existing Swift-generated settings.json files.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSettings {
    #[serde(default = "default_language")]
    pub(crate) language: String,
    #[serde(default = "default_startup_behavior")]
    pub(crate) startup_behavior: String,
    #[serde(default = "default_theme")]
    pub(crate) theme: String,
    #[serde(default = "default_dark_theme_shade")]
    pub(crate) dark_theme_shade: u8,
    #[serde(default = "default_dark_theme_tint_percent")]
    pub(crate) dark_theme_tint_percent: u8,
    #[serde(default = "default_forest_theme_canopy_percent")]
    pub(crate) forest_theme_canopy_percent: u8,
    #[serde(default = "default_forest_theme_fog_percent")]
    pub(crate) forest_theme_fog_percent: u8,
    #[serde(default = "default_light_theme_texture_percent")]
    pub(crate) light_theme_texture_percent: u8,
    #[serde(default = "default_theme_detail_percent")]
    pub(crate) theme_detail_percent: u8,
    #[serde(default = "default_theme_panels_detail_percent")]
    pub(crate) theme_panels_detail_percent: u8,
    #[serde(default = "default_theme_timeline_detail_percent")]
    pub(crate) theme_timeline_detail_percent: u8,
    #[serde(default = "default_theme_motion_enabled")]
    pub(crate) theme_motion_enabled: bool,
    #[serde(default = "default_theme_motion_percent")]
    pub(crate) theme_motion_percent: u8,
    #[serde(default = "default_true")]
    pub(crate) theme_overlay_enabled: bool,
    #[serde(default = "default_true")]
    pub(crate) theme_panels_ornaments_enabled: bool,
    #[serde(default = "default_true")]
    pub(crate) theme_timeline_ornaments_enabled: bool,
    #[serde(default = "default_theme_atmosphere_profile")]
    pub(crate) theme_atmosphere_profile: String,
    #[serde(default = "default_favorite_theme_preset")]
    pub(crate) favorite_theme_preset: String,
    #[serde(default = "default_waveform_style")]
    pub(crate) waveform_style: String,
    #[serde(default = "default_driver_type")]
    pub(crate) driver_type: String,
    #[serde(default = "default_output_device", alias = "audioOutputDeviceUID")]
    pub(crate) output_device: String,
    #[serde(default = "default_output_device")]
    pub(crate) fallback_output_device: String,
    #[serde(default = "default_input_device", alias = "audioInputDeviceUID")]
    pub(crate) input_device: String,
    #[serde(default = "default_sample_rate", alias = "audioSampleRate")]
    pub(crate) sample_rate: u32,
    #[serde(default = "default_buffer_size", alias = "audioBufferSize")]
    pub(crate) buffer_size: u32,
    #[serde(default)]
    pub(crate) driver_error_compensation: f64,
    #[serde(default)]
    pub(crate) test_tone_enabled: bool,
    #[serde(default = "default_test_tone_volume")]
    pub(crate) test_tone_volume: f64,
    #[serde(default = "default_test_tone_frequency")]
    pub(crate) test_tone_frequency: f64,
    #[serde(default, alias = "cpuUsageSimulator")]
    pub(crate) cpu_usage_simulator: bool,
    #[serde(default = "default_true", alias = "srPitchConversionHighQuality")]
    pub(crate) sr_pitch_conversion: bool,
    #[serde(default = "default_user_folder", alias = "userFolderPath")]
    pub(crate) user_folder_path: String,
    /// User-added folders shown in the browser PLACES section.
    #[serde(default, alias = "browserFolders")]
    pub(crate) browser_folders: Vec<String>,
    #[serde(default = "default_samples_path", alias = "samplesPath")]
    pub(crate) samples_path: String,
    #[serde(default = "default_vst2_path", alias = "vst2Path")]
    pub(crate) vst2_path: String,
    #[serde(default = "default_vst3_path", alias = "vst3Path")]
    pub(crate) vst3_path: String,
    #[serde(default, alias = "openRouterApiKey")]
    pub(crate) open_router_api_key: String,
    #[serde(default = "default_open_router_model", alias = "openRouterModel")]
    pub(crate) open_router_model: String,
    /// Browser file list columns visibility (persisted UI prefs).
    #[serde(default = "default_true", alias = "browserShowSizeColumn")]
    pub(crate) browser_show_size_column: bool,
    #[serde(default, alias = "browserShowTypeColumn")]
    pub(crate) browser_show_type_column: bool,
    /// Browser left category pane width in pixels.
    #[serde(
        default = "default_browser_left_pane_width",
        alias = "browserLeftPaneWidth"
    )]
    pub(crate) browser_left_pane_width: u32,
    /// Follow playhead state in transport bar.
    #[serde(default = "default_true", alias = "transportFollowPlayhead")]
    pub(crate) transport_follow_playhead: bool,
    /// Global automation visibility toggle.
    #[serde(default, alias = "transportAutomationVisible")]
    pub(crate) transport_automation_visible: bool,
    /// Piano pencil mode toggle.
    #[serde(default = "default_true", alias = "transportPianoPencilMode")]
    pub(crate) transport_piano_pencil_mode: bool,
    /// Arrangement grid UI division label (OFF, ADAPTIVE, 1/1..1/32).
    #[serde(
        default = "default_arrangement_grid_division",
        alias = "arrangementGridDivision"
    )]
    pub(crate) arrangement_grid_division: String,
    /// Arrangement grid triplet toggle.
    #[serde(default, alias = "arrangementGridTriplet")]
    pub(crate) arrangement_grid_triplet: bool,
    /// Arrangement snap enabled toggle.
    #[serde(default = "default_true", alias = "arrangementGridSnapEnabled")]
    pub(crate) arrangement_grid_snap_enabled: bool,
}

pub(crate) fn default_language() -> String {
    "English".into()
}
pub(crate) fn default_startup_behavior() -> String {
    "new".into()
}
pub(crate) fn default_theme() -> String {
    "dark".into()
}
pub(crate) fn default_dark_theme_shade() -> u8 {
    0
}
pub(crate) fn default_dark_theme_tint_percent() -> u8 {
    0
}
pub(crate) fn default_forest_theme_canopy_percent() -> u8 {
    100
}
pub(crate) fn default_forest_theme_fog_percent() -> u8 {
    100
}
pub(crate) fn default_light_theme_texture_percent() -> u8 {
    72
}
pub(crate) fn default_theme_detail_percent() -> u8 {
    100
}
pub(crate) fn default_theme_panels_detail_percent() -> u8 {
    100
}
pub(crate) fn default_theme_timeline_detail_percent() -> u8 {
    100
}
pub(crate) fn default_theme_motion_enabled() -> bool {
    true
}
pub(crate) fn default_theme_motion_percent() -> u8 {
    100
}
pub(crate) fn default_theme_atmosphere_profile() -> String {
    "Balanced".into()
}
pub(crate) fn default_favorite_theme_preset() -> String {
    "Dark Clean".into()
}
pub(crate) fn default_waveform_style() -> String {
    "colored".into()
}
pub(crate) fn default_driver_type() -> String {
    "CoreAudio".into()
}
pub(crate) fn default_output_device() -> String {
    "Default Output".into()
}
pub(crate) fn default_input_device() -> String {
    "Default Input".into()
}
pub(crate) fn default_sample_rate() -> u32 {
    44100
}
pub(crate) fn default_buffer_size() -> u32 {
    512
}
pub(crate) fn default_test_tone_volume() -> f64 {
    -20.0
}
pub(crate) fn default_test_tone_frequency() -> f64 {
    440.0
}
pub(crate) fn default_true() -> bool {
    true
}
pub(crate) fn default_user_folder() -> String {
    let home = dirs::home_dir().unwrap_or_default();
    home.join("Music").join("Dream DAW").display().to_string()
}
pub(crate) fn default_samples_path() -> String {
    let home = dirs::home_dir().unwrap_or_default();
    home.join("Music")
        .join("Dream DAW")
        .join("Samples")
        .display()
        .to_string()
}
pub(crate) fn default_vst2_path() -> String {
    "/Library/Audio/Plug-Ins/VST".into()
}
pub(crate) fn default_vst3_path() -> String {
    "/Library/Audio/Plug-Ins/VST3".into()
}
pub(crate) fn default_open_router_model() -> String {
    "anthropic/claude-sonnet-4-5".into()
}
pub(crate) fn default_browser_left_pane_width() -> u32 {
    92
}
pub(crate) fn default_arrangement_grid_division() -> String {
    "ADAPTIVE".into()
}

impl Default for AppSettings {
    fn default() -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        let music_dir = home.join("Music").join("Dream DAW");
        Self {
            language: "English".into(),
            startup_behavior: "new".into(),
            theme: default_theme(),
            dark_theme_shade: default_dark_theme_shade(),
            dark_theme_tint_percent: default_dark_theme_tint_percent(),
            forest_theme_canopy_percent: default_forest_theme_canopy_percent(),
            forest_theme_fog_percent: default_forest_theme_fog_percent(),
            light_theme_texture_percent: default_light_theme_texture_percent(),
            theme_detail_percent: default_theme_detail_percent(),
            theme_panels_detail_percent: default_theme_panels_detail_percent(),
            theme_timeline_detail_percent: default_theme_timeline_detail_percent(),
            theme_motion_enabled: default_theme_motion_enabled(),
            theme_motion_percent: default_theme_motion_percent(),
            theme_overlay_enabled: true,
            theme_panels_ornaments_enabled: true,
            theme_timeline_ornaments_enabled: true,
            theme_atmosphere_profile: default_theme_atmosphere_profile(),
            favorite_theme_preset: default_favorite_theme_preset(),
            waveform_style: "colored".into(),
            driver_type: "CoreAudio".into(),
            output_device: "Default Output".into(),
            fallback_output_device: "Default Output".into(),
            input_device: "Default Input".into(),
            sample_rate: default_sample_rate(),
            buffer_size: default_buffer_size(),
            driver_error_compensation: 0.0,
            test_tone_enabled: false,
            test_tone_volume: -20.0,
            test_tone_frequency: 440.0,
            cpu_usage_simulator: false,
            sr_pitch_conversion: true,
            user_folder_path: music_dir.display().to_string(),
            samples_path: music_dir.join("Samples").display().to_string(),
            vst2_path: "/Library/Audio/Plug-Ins/VST".into(),
            vst3_path: "/Library/Audio/Plug-Ins/VST3".into(),
            browser_folders: Vec::new(),
            open_router_api_key: String::new(),
            open_router_model: default_open_router_model(),
            browser_show_size_column: true,
            browser_show_type_column: false,
            browser_left_pane_width: default_browser_left_pane_width(),
            transport_follow_playhead: true,
            transport_automation_visible: false,
            transport_piano_pencil_mode: true,
            arrangement_grid_division: default_arrangement_grid_division(),
            arrangement_grid_triplet: false,
            arrangement_grid_snap_enabled: true,
        }
    }
}

impl AppSettings {
    /// Returns the path to the User Info directory for the current user folder.
    pub(crate) fn user_info_dir(&self) -> PathBuf {
        PathBuf::from(&self.user_folder_path).join("User Info")
    }

    /// Returns the path to the settings.json file in the User Info directory.
    pub(crate) fn settings_file_path(&self) -> PathBuf {
        self.user_info_dir().join("settings.json")
    }
}

/// Thread-safe settings state.
pub(crate) struct SettingsState {
    pub(crate) settings: Mutex<AppSettings>,
}

impl SettingsState {
    /// Load settings from disk using the Swift-compatible pattern:
    /// 1. Try `{user_folder_path}/User Info/settings.json` (primary)
    /// 2. Try `{app_data_dir}/settings.json` (legacy/fallback)
    /// 3. Fall back to defaults
    pub(crate) fn load_from_disk(app_data_dir: &std::path::Path) -> Self {
        // First build defaults to get the default user_folder_path
        let defaults = AppSettings::default();
        let user_info_path = defaults.settings_file_path();

        // Primary: load from user folder's User Info directory
        if user_info_path.exists()
            && let Ok(json) = std::fs::read_to_string(&user_info_path)
            && let Ok(settings) = serde_json::from_str::<AppSettings>(&json)
        {
            log::info!("Settings loaded from: {}", user_info_path.display());
            return Self {
                settings: Mutex::new(settings),
            };
        }

        // Fallback: load from app_data_dir (legacy Tauri location)
        let legacy_path = app_data_dir.join("settings.json");
        if legacy_path.exists()
            && let Ok(json) = std::fs::read_to_string(&legacy_path)
            && let Ok(settings) = serde_json::from_str::<AppSettings>(&json)
        {
            log::info!(
                "Settings loaded from legacy path: {}",
                legacy_path.display()
            );
            // Migrate: save to user folder and clean up
            let state = Self {
                settings: Mutex::new(settings),
            };
            if let Err(e) = state.save_to_user_folder() {
                log::warn!("Failed to migrate settings: {}", e);
            }
            return state;
        }

        log::info!("No settings found, using defaults");
        Self {
            settings: Mutex::new(defaults),
        }
    }

    /// Save settings to `{user_folder_path}/User Info/settings.json`.
    /// Creates the directory structure if it doesn't exist.
    pub(crate) fn save_to_user_folder(&self) -> Result<(), String> {
        let settings = self.settings.lock().map_err(|e| e.to_string())?;
        let user_info_dir = settings.user_info_dir();
        let settings_path = settings.settings_file_path();

        std::fs::create_dir_all(&user_info_dir)
            .map_err(|e| format!("Failed to create User Info dir: {}", e))?;

        let json = serde_json::to_string_pretty(&*settings)
            .map_err(|e| format!("Failed to serialize settings: {}", e))?;
        std::fs::write(&settings_path, &json)
            .map_err(|e| format!("Failed to write settings: {}", e))?;

        log::info!("Settings saved to: {}", settings_path.display());
        Ok(())
    }

    /// When the user_folder_path changes, migrate settings.json to the new location.
    pub(crate) fn migrate_to_new_folder(
        &self,
        old_path: &str,
        new_path: &str,
    ) -> Result<(), String> {
        let old_settings_file = PathBuf::from(old_path)
            .join("User Info")
            .join("settings.json");
        let new_user_info_dir = PathBuf::from(new_path).join("User Info");
        let new_settings_file = new_user_info_dir.join("settings.json");

        // Create new User Info directory
        std::fs::create_dir_all(&new_user_info_dir)
            .map_err(|e| format!("Failed to create new User Info dir: {}", e))?;

        // Copy old settings if they exist
        if old_settings_file.exists() && !new_settings_file.exists() {
            std::fs::copy(&old_settings_file, &new_settings_file)
                .map_err(|e| format!("Failed to copy settings: {}", e))?;
            log::info!(
                "Settings migrated from {} to {}",
                old_settings_file.display(),
                new_settings_file.display()
            );
        }

        // Now save current state to the new location
        self.save_to_user_folder()?;
        Ok(())
    }
}

// ── Recent Projects Tracker ───────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RecentProject {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) last_opened: String, // ISO 8601
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct RecentProjects {
    pub(crate) projects: Vec<RecentProject>,
}

impl RecentProjects {
    pub(crate) fn load(app_data_dir: &std::path::Path) -> Self {
        let path = app_data_dir.join("recent_projects.json");
        if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
                Err(_) => Self::default(),
            }
        } else {
            Self::default()
        }
    }

    pub(crate) fn save(&self, app_data_dir: &std::path::Path) -> Result<(), String> {
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
        std::fs::write(app_data_dir.join("recent_projects.json"), json)
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub(crate) fn add(&mut self, name: String, path: String) {
        // Remove existing entry for same path
        self.projects.retain(|p| p.path != path);
        // Add to front
        self.projects.insert(
            0,
            RecentProject {
                name,
                path,
                last_opened: chrono_now(),
            },
        );
        // Keep max 20 recent projects
        self.projects.truncate(20);
    }
}

/// Returns current UTC time as ISO 8601 / RFC 3339 string.
///
/// Format: `2026-02-18T14:30:00Z` — human-readable, lexicographically
/// sortable, and universally parseable.
pub(crate) fn chrono_now() -> String {
    use std::time::SystemTime;
    let since_epoch = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = since_epoch.as_secs();
    // Manual UTC decomposition — no external dependency required.
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;
    // Civil date from days since epoch (1970-01-01).
    let (year, month, day) = civil_from_days(days as i64);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

/// Converts days since 1970-01-01 to (year, month, day).
/// Algorithm from Howard Hinnant's `chrono`-compatible date library.
pub(crate) fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
