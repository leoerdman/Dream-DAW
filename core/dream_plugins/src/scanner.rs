// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Plugin Scanner
// ═══════════════════════════════════════════════════════════════════════════
//
// Discovers installed plugins by scanning standard filesystem locations.
//
// Scanning is async-friendly (returns descriptors, does NOT load binaries).
// Binary validation happens in a separate step after scan.
//
// ═══════════════════════════════════════════════════════════════════════════

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use log::info;

use crate::descriptor::PluginDescriptor;
use crate::format::{PluginCategory, PluginFormat};

/// Discovers plugins installed on the system.
///
/// Scans standard platform directories for plugin bundles:
/// - macOS VST2: `/Library/Audio/Plug-Ins/VST/`, `~/Library/Audio/Plug-Ins/VST/`
/// - macOS VST3: `/Library/Audio/Plug-Ins/VST3/`, `~/Library/Audio/Plug-Ins/VST3/`
/// - macOS CLAP: `/Library/Audio/Plug-Ins/CLAP/`, `~/Library/Audio/Plug-Ins/CLAP/`
/// - macOS AU:   `/Library/Audio/Plug-Ins/Components/`, `~/Library/Audio/Plug-Ins/Components/`
///
/// Linux and Windows paths will be added in future sprints.
pub struct PluginScanner {
    /// Additional custom search paths (set by user preferences).
    custom_paths: Vec<PathBuf>,
}

impl PluginScanner {
    /// Creates a new scanner with no custom paths.
    pub fn new() -> Self {
        Self {
            custom_paths: Vec::new(),
        }
    }

    /// Adds a custom search path for plugins.
    pub fn add_custom_path(&mut self, path: impl Into<PathBuf>) {
        self.custom_paths.push(path.into());
    }

    /// Returns all standard search directories for the given format on macOS.
    fn standard_paths(format: PluginFormat) -> Vec<PathBuf> {
        let mut paths = Vec::new();
        let subdir = match format {
            PluginFormat::VST2 => "VST",
            PluginFormat::VST3 => "VST3",
            PluginFormat::CLAP => "CLAP",
            PluginFormat::AudioUnit => "Components",
        };

        // System-wide
        paths.push(PathBuf::from(format!("/Library/Audio/Plug-Ins/{subdir}")));

        // User-local
        if let Some(home) = dirs_home() {
            paths.push(home.join(format!("Library/Audio/Plug-Ins/{subdir}")));
        }

        paths
    }

    /// Collects all search paths for a given format (standard + custom).
    fn search_paths(&self, format: PluginFormat) -> Vec<PathBuf> {
        let mut paths = Self::standard_paths(format);
        for custom in &self.custom_paths {
            paths.push(custom.clone());
        }
        paths
    }

    /// Scans for all plugins of a specific format.
    pub fn scan_format(&self, format: PluginFormat) -> Vec<PluginDescriptor> {
        let mut results = Vec::new();
        let extension = format.extension();

        for dir in self.search_paths(format) {
            if !dir.exists() {
                continue;
            }

            info!("Scanning {}: {}", format, dir.display());

            let paths = Self::collect_plugin_paths(&dir, extension, 4);
            if paths.is_empty() {
                continue;
            }
            for path in paths {
                if let Some(desc) = Self::descriptor_from_path(&path, format) {
                    results.push(desc);
                }
            }
        }

        info!("Found {} {} plugin(s)", results.len(), format);
        results
    }

    /// Scans ALL supported formats and returns a combined list.
    pub fn scan_all(&self) -> Vec<PluginDescriptor> {
        let mut all = Vec::new();
        all.extend(self.scan_format(PluginFormat::VST2));
        all.extend(self.scan_format(PluginFormat::VST3));
        all.extend(self.scan_format(PluginFormat::CLAP));
        all.extend(self.scan_format(PluginFormat::AudioUnit));

        // Sort by name for deterministic output
        all.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        all
    }

    /// Checks if a path matches the expected plugin extension/bundle type.
    fn matches_format(path: &Path, extension: &str) -> bool {
        path.extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case(extension))
    }

    /// Creates a descriptor from a plugin bundle path.
    ///
    /// This is a lightweight operation — it extracts the name from the
    /// filename without loading the plugin binary.
    fn descriptor_from_path(path: &Path, format: PluginFormat) -> Option<PluginDescriptor> {
        let name = path.file_stem()?.to_str()?.to_string();

        // Heuristic category detection from name/path
        let category = Self::guess_category(&name, path);

        // Vendor extraction: best-effort from parent folder or name
        let vendor = Self::guess_vendor(path, &name);

        Some(PluginDescriptor::new(
            name,
            vendor,
            format,
            category,
            path.to_path_buf(),
        ))
    }

    /// Best-effort vendor extraction.
    ///
    /// Many plugins install under a vendor subfolder:
    /// `/Library/Audio/Plug-Ins/VST3/FabFilter/Pro-Q 3.vst3`
    fn guess_vendor(path: &Path, plugin_name: &str) -> String {
        // Check if there's a vendor directory between the standard path and the plugin
        if let Some(parent) = path.parent() {
            let parent_name = parent.file_name().and_then(|n| n.to_str()).unwrap_or("");

            // If parent is not a standard directory, it's likely the vendor
            let standard_dirs = ["VST", "VST3", "CLAP", "Components", "Plug-Ins"];
            if !standard_dirs.contains(&parent_name) && !parent_name.is_empty() {
                return parent_name.to_string();
            }
        }

        // Fallback: use plugin name as vendor (common for small developers)
        plugin_name.to_string()
    }

    /// Heuristic category detection from plugin name.
    fn guess_category(name: &str, _path: &Path) -> PluginCategory {
        let lower = name.to_lowercase();

        // Instrument keywords
        let instrument_keywords = [
            "synth",
            "sampler",
            "piano",
            "keys",
            "bass",
            "drum",
            "serum",
            "massive",
            "vital",
            "kontakt",
            "omnisphere",
            "instrument",
            "organ",
            "string",
        ];

        // Effect keywords
        let effect_keywords = [
            "eq",
            "comp",
            "reverb",
            "delay",
            "chorus",
            "flanger",
            "phaser",
            "distortion",
            "limiter",
            "gate",
            "filter",
            "saturator",
            "exciter",
            "de-ess",
            "multiband",
            "ott",
        ];

        // Analyzer keywords
        let analyzer_keywords = [
            "meter", "analyzer", "spectrum", "scope", "monitor", "loudness", "vumeter",
        ];

        for kw in &instrument_keywords {
            if lower.contains(kw) {
                return PluginCategory::Instrument;
            }
        }
        for kw in &effect_keywords {
            if lower.contains(kw) {
                return PluginCategory::Effect;
            }
        }
        for kw in &analyzer_keywords {
            if lower.contains(kw) {
                return PluginCategory::Analyzer;
            }
        }

        PluginCategory::Other
    }

    /// Recursively collects plugin bundle/file paths with a matching extension.
    ///
    /// This is needed because many vendors install plugins in nested subfolders,
    /// e.g. `/Library/Audio/Plug-Ins/VST3/Vendor/Product.vst3`.
    fn collect_plugin_paths(root: &Path, extension: &str, max_depth: usize) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        let mut stack = vec![(root.to_path_buf(), 0usize)];

        while let Some((dir, depth)) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };

            for entry in entries.flatten() {
                let path = entry.path();
                if Self::matches_format(&path, extension) {
                    let key = path.to_string_lossy().to_string();
                    if seen.insert(key) {
                        out.push(path);
                    }
                    continue;
                }

                if depth < max_depth && path.is_dir() {
                    stack.push((path, depth + 1));
                }
            }
        }

        out.sort();
        out
    }
}

impl Default for PluginScanner {
    fn default() -> Self {
        Self::new()
    }
}

// ── Platform Helpers ───────────────────────────────────────────────────

/// Returns the user's home directory.
fn dirs_home() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(PathBuf::from)
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_paths_exist_for_all_formats() {
        let vst2 = PluginScanner::standard_paths(PluginFormat::VST2);
        assert!(vst2.iter().any(|p| p.to_str().unwrap().contains("/VST")));

        let vst3 = PluginScanner::standard_paths(PluginFormat::VST3);
        assert!(vst3.iter().any(|p| p.to_str().unwrap().contains("VST3")));

        let clap = PluginScanner::standard_paths(PluginFormat::CLAP);
        assert!(clap.iter().any(|p| p.to_str().unwrap().contains("CLAP")));

        let au = PluginScanner::standard_paths(PluginFormat::AudioUnit);
        assert!(
            au.iter()
                .any(|p| p.to_str().unwrap().contains("Components"))
        );
    }

    #[test]
    fn matches_format_works() {
        assert!(PluginScanner::matches_format(
            Path::new("/foo/bar.vst3"),
            "vst3"
        ));
        assert!(!PluginScanner::matches_format(
            Path::new("/foo/bar.clap"),
            "vst3"
        ));
        assert!(PluginScanner::matches_format(
            Path::new("/foo/bar.VST3"),
            "vst3"
        ));
    }

    #[test]
    fn descriptor_from_path_extracts_name() {
        let desc = PluginScanner::descriptor_from_path(
            Path::new("/Library/Audio/Plug-Ins/VST3/Serum.vst3"),
            PluginFormat::VST3,
        )
        .unwrap();

        assert_eq!(desc.name, "Serum");
        assert_eq!(desc.format, PluginFormat::VST3);
    }

    #[test]
    fn vendor_extraction_from_subfolder() {
        let vendor = PluginScanner::guess_vendor(
            Path::new("/Library/Audio/Plug-Ins/VST3/FabFilter/Pro-Q 3.vst3"),
            "Pro-Q 3",
        );
        assert_eq!(vendor, "FabFilter");
    }

    #[test]
    fn vendor_fallback_to_plugin_name() {
        let vendor = PluginScanner::guess_vendor(
            Path::new("/Library/Audio/Plug-Ins/VST3/Serum.vst3"),
            "Serum",
        );
        assert_eq!(vendor, "Serum");
    }

    #[test]
    fn category_detection_instruments() {
        assert_eq!(
            PluginScanner::guess_category("Serum Synth", Path::new("")),
            PluginCategory::Instrument
        );
        assert_eq!(
            PluginScanner::guess_category("Kontakt", Path::new("")),
            PluginCategory::Instrument
        );
    }

    #[test]
    fn category_detection_effects() {
        assert_eq!(
            PluginScanner::guess_category("Pro-Q EQ", Path::new("")),
            PluginCategory::Effect
        );
        assert_eq!(
            PluginScanner::guess_category("Valhalla Reverb", Path::new("")),
            PluginCategory::Effect
        );
    }

    #[test]
    fn category_detection_analyzers() {
        assert_eq!(
            PluginScanner::guess_category("SPAN Analyzer", Path::new("")),
            PluginCategory::Analyzer
        );
    }

    #[test]
    fn category_detection_unknown() {
        assert_eq!(
            PluginScanner::guess_category("MyPlugin", Path::new("")),
            PluginCategory::Other
        );
    }

    #[test]
    fn custom_path_is_included() {
        let mut scanner = PluginScanner::new();
        scanner.add_custom_path("/my/custom/plugins");

        let paths = scanner.search_paths(PluginFormat::VST3);
        assert!(
            paths
                .iter()
                .any(|p| p == &PathBuf::from("/my/custom/plugins"))
        );
    }

    #[test]
    fn scan_all_returns_sorted() {
        // scan_all on a machine may return an empty list if no plugins installed
        // but it should not panic
        let scanner = PluginScanner::new();
        let results = scanner.scan_all();
        // Verify sorted by name (case-insensitive)
        for window in results.windows(2) {
            assert!(window[0].name.to_lowercase() <= window[1].name.to_lowercase());
        }
    }
}
