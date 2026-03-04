// ═══════════════════════════════════════════════════════════════════════
// Dream DAW — Ableton ALS File Path Resolution (Enterprise Edition)
// ═══════════════════════════════════════════════════════════════════════
//
// Resolves sample file references from ALS XML nodes to local paths.
//
// Enterprise search strategy (ordered by cost):
//   1. Absolute path (verbatim from ALS <Path Value="..."/>)
//   2. Relative path joined with ALS parent directory
//   3. RelativePathElement chain reconstruction
//   4. SearchHint PathHint reconstruction
//   5. Hot directories near the ALS file (Samples/*, Ableton Project Info)
//   6. Ableton user library & factory content (macOS standard paths)
//   7. Deep recursive filename search (project tree, depth-limited)
//
// All resolved directories are cached in a PathResolverCache to avoid
// rescanning the same folders for every clip in a large project.
//
// ═══════════════════════════════════════════════════════════════════════

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use dream_models::project::Project;

use super::xml_helpers::*;

// ── Path Resolver Cache ───────────────────────────────────────────────

/// Cache for directory listings to avoid redundant filesystem scans.
/// A typical Ableton project with 200 clips may reference the same
/// Samples/ directory 200 times — caching prevents 200 `read_dir` calls.
pub struct PathResolverCache {
    /// filename (lowercased) → Vec<full paths> for quick lookup
    filename_to_paths: HashMap<String, Vec<PathBuf>>,
    /// Directories already scanned (avoid rescanning)
    scanned_dirs: HashSet<PathBuf>,
}

impl PathResolverCache {
    pub fn new() -> Self {
        Self {
            filename_to_paths: HashMap::new(),
            scanned_dirs: HashSet::new(),
        }
    }

    /// Index all files in `dir` recursively up to `max_depth`.
    pub fn scan_directory(&mut self, dir: &Path, max_depth: usize) {
        if self.scanned_dirs.contains(dir) {
            return;
        }
        self.scanned_dirs.insert(dir.to_path_buf());
        self.scan_recursive(dir, 0, max_depth);
    }

    fn scan_recursive(&mut self, dir: &Path, depth: usize, max_depth: usize) {
        if depth > max_depth {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                self.scan_recursive(&path, depth + 1, max_depth);
            } else if path.is_file()
                && let Some(name) = path.file_name().and_then(|s| s.to_str())
            {
                let key = name.to_ascii_lowercase();
                self.filename_to_paths.entry(key).or_default().push(path);
            }
        }
    }

    /// Look up a filename in cached directory listings.
    pub fn find_by_filename(&self, filename: &str) -> Option<&PathBuf> {
        let key = filename.to_ascii_lowercase();
        self.filename_to_paths
            .get(&key)
            .and_then(|paths| paths.first())
    }

    /// Look up a filename with preference for paths containing a hint fragment.
    pub fn find_by_filename_with_hint(&self, filename: &str, path_hint: &str) -> Option<&PathBuf> {
        let key = filename.to_ascii_lowercase();
        let hint_lower = path_hint.to_ascii_lowercase();
        self.filename_to_paths.get(&key).and_then(|paths| {
            // Prefer path that contains the hint fragment
            paths
                .iter()
                .find(|p| {
                    p.to_string_lossy()
                        .to_ascii_lowercase()
                        .contains(&hint_lower)
                })
                .or_else(|| paths.first())
        })
    }
}

impl Default for PathResolverCache {
    fn default() -> Self {
        Self::new()
    }
}

type SamplerZoneEntry = (String, Option<u8>, Option<u8>, Option<u8>);

// ── Ableton FileRef Parsing ───────────────────────────────────────────

/// Parsed fields from an Ableton <FileRef> XML node.
struct AbletonFileRef {
    /// <Path Value="..."/>
    abs_path: Option<String>,
    /// <RelativePath Value="..."/>
    relative_path: Option<String>,
    /// Reconstructed from <RelativePathElement Dir="..."/> chain
    relative_path_elements: Option<String>,
    /// <SearchHint> data
    search_hint_path: Option<String>,
    search_hint_file_size: Option<i64>,
    /// <Name Value="..."/>
    file_name: Option<String>,
}

/// Deep-parse an Ableton <FileRef> node extracting ALL path information.
fn parse_ableton_file_ref(file_ref: roxmltree::Node<'_, '_>) -> AbletonFileRef {
    let abs_path = descendant_value(file_ref, "Path");
    let relative_path = descendant_value(file_ref, "RelativePath");
    let file_name = descendant_value(file_ref, "Name");

    // ── RelativePathElement chain ──
    // Ableton encodes relative paths as:
    //   <RelativePathElement Dir=""/>       (project root marker)
    //   <RelativePathElement Dir="Samples"/>
    //   <RelativePathElement Dir="Imported"/>
    // We reconstruct: "Samples/Imported"
    let relative_path_elements = {
        let elements: Vec<String> = file_ref
            .descendants()
            .filter(|n| n.is_element() && n.has_tag_name("RelativePathElement"))
            .filter_map(|n| n.attribute("Dir").map(|s| s.to_string()))
            .filter(|s| !s.is_empty())
            .collect();
        if elements.is_empty() {
            None
        } else {
            Some(elements.join("/"))
        }
    };

    // ── SearchHint ──
    // <SearchHint>
    //   <PathHint Value="/Users/.../Samples/kick.wav"/>
    //   <FileSize Value="123456"/>
    //   <Crc Value="54321"/>
    // </SearchHint>
    let search_hint = file_ref
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("SearchHint"));
    let search_hint_path = search_hint.and_then(|sh| first_child_value(sh, "PathHint"));
    let search_hint_file_size = search_hint
        .and_then(|sh| first_child_value(sh, "FileSize"))
        .and_then(|v| v.parse::<i64>().ok());

    AbletonFileRef {
        abs_path,
        relative_path,
        relative_path_elements,
        search_hint_path,
        search_hint_file_size,
        file_name,
    }
}

// ── Path Resolution ────────────────────────────────────────────────────

/// Resolves an ALS sample file reference to a local filesystem path.
///
/// Enterprise resolution strategy (7 tiers):
///   1. Absolute path verbatim
///   2. Variant matching (dash/space normalization)
///   3. Relative path joined with ALS parent
///   4. RelativePathElement chain reconstruction
///   5. SearchHint PathHint
///   6. Hot directories near the ALS file
///   7. Recursive filename search via cache
pub fn resolve_als_file_path(
    als_path: &Path,
    absolute_path: Option<&str>,
    relative_path: Option<&str>,
) -> Option<String> {
    resolve_als_file_path_cached(als_path, absolute_path, relative_path, None)
}

/// Generates normalized path candidates for a raw path string.
/// Handles backslash→slash, percent-decoding, and file:// URI normalization.
fn normalized_candidates(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let mut out = Vec::<String>::new();
    let mut push_unique = |s: String| {
        if !s.is_empty() && !out.iter().any(|v| v == &s) {
            out.push(s);
        }
    };

    push_unique(trimmed.to_string());
    push_unique(trimmed.replace('\\', "/"));
    push_unique(percent_decode_lossy(trimmed));
    if let Some(uri_path) = normalize_file_uri(trimmed) {
        push_unique(uri_path);
    }
    out
}

/// Tries normalized path + dash/space/dot variants to find an existing file.
/// Handles Ableton Pack directory naming differences (e.g. "0. Packs" vs "0 - Packs").
fn try_existing_variants(raw: &str) -> Option<String> {
    for normalized in normalized_candidates(raw) {
        let candidates = [
            normalized.clone(),
            // Dash/space normalization
            normalized.replace(" - ", "-"),
            normalized.replace(" -", "-"),
            normalized.replace("- ", "-"),
            normalized.replace("160 - 200 BPM", "160-200 BPM"),
            // Dot/dash folder rename patterns (Ableton Pack directories)
            // ALS may store "0. Packs" but folder is "0 - Packs" or vice versa
            normalized.replace(". ", " - "),
            normalized.replace(" - ", ". "),
        ];
        if let Some(found) = candidates
            .into_iter()
            .find(|candidate| std::path::Path::new(candidate).exists())
        {
            return Some(found);
        }
    }
    None
}

/// Same as `resolve_als_file_path` but with optional cache for batch resolution.
pub fn resolve_als_file_path_cached(
    als_path: &Path,
    absolute_path: Option<&str>,
    relative_path: Option<&str>,
    cache: Option<&PathResolverCache>,
) -> Option<String> {
    // ── Tier 1: Absolute path ──
    if let Some(abs) = absolute_path
        && !abs.trim().is_empty()
        && let Some(found) = try_existing_variants(abs)
    {
        return Some(found);
    }

    // ── Tier 1.5: Ableton app path rewriting ──
    // When a project references e.g. /Applications/Ableton Live 12 Beta.app/Contents/...
    // but the user has the release version, rewrite to try all known app bundles.
    if let Some(abs) = absolute_path
        && abs.contains("/Applications/Ableton Live ")
        && abs.contains(".app/Contents/")
    {
        // Extract the suffix after ".app/" (e.g. "Contents/App-Resources/Builtin/Devices/...")
        if let Some(app_suffix_pos) = abs.find(".app/") {
            let suffix = &abs[app_suffix_pos + 5..]; // skip ".app/"
            // Try to extract the version number
            let after_live = &abs[abs.find("Ableton Live ").unwrap() + 13..app_suffix_pos];
            // Parse out the major version number (e.g. "12 Beta" → 12, "12" → 12)
            let major_ver = after_live.split_whitespace().next()
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(12);

            let variants = [
                format!("/Applications/Ableton Live {}.app/{}", major_ver, suffix),
                format!("/Applications/Ableton Live {} Suite.app/{}", major_ver, suffix),
                format!("/Applications/Ableton Live {} Beta.app/{}", major_ver, suffix),
                format!("/Applications/Ableton Live {} Suite Beta.app/{}", major_ver, suffix),
            ];
            for variant in &variants {
                if let Some(found) = try_existing_variants(variant) {
                    return Some(found);
                }
            }
        }
    }

    // ── Tier 2: Relative path joined with ALS parent ──
    if let Some(rel) = relative_path
        && !rel.trim().is_empty()
    {
        for rel_raw in normalized_candidates(rel) {
            let rel_path = PathBuf::from(&rel_raw);
            if rel_path.is_absolute() {
                if let Some(found) = try_existing_variants(&rel_path.to_string_lossy()) {
                    return Some(found);
                }
            } else {
                let parent = als_path.parent().unwrap_or_else(|| Path::new("."));
                let joined = parent.join(&rel_path).to_string_lossy().to_string();
                if let Some(found) = try_existing_variants(&joined) {
                    return Some(found);
                }
            }
        }
    }

    // ── Tier 3: Search near project (recursive) ──
    let file_name = absolute_path
        .or(relative_path)
        .and_then(|raw| {
            Path::new(raw.trim())
                .file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_default();

    if !file_name.is_empty() {
        if let Some(found) = search_near_project_recursive(als_path, &file_name) {
            return Some(found);
        }

        // ── Tier 4: Ableton standard library locations (macOS) ──
        if let Some(found) = search_ableton_library(&file_name) {
            return Some(found);
        }

        // ── Tier 5: Cache-based search ──
        if let Some(cache) = cache {
            let hint = absolute_path.unwrap_or("");
            if let Some(found) = cache.find_by_filename_with_hint(&file_name, hint) {
                return Some(found.to_string_lossy().to_string());
            }
        }
    }

    // ── Tier 6: Return raw path as-is (let the engine report missing file) ──
    if let Some(abs) = absolute_path
        && !abs.trim().is_empty()
    {
        let candidates = normalized_candidates(abs);
        if let Some(normalized) = candidates
            .iter()
            .find(|c| !c.to_ascii_lowercase().starts_with("file://"))
            .cloned()
            .or_else(|| candidates.first().cloned())
        {
            return Some(normalized);
        }
        return Some(abs.trim().to_string());
    }
    if let Some(rel) = relative_path
        && !rel.trim().is_empty()
    {
        let parent = als_path.parent().unwrap_or_else(|| Path::new("."));
        for rel_raw in normalized_candidates(rel) {
            let joined = parent.join(PathBuf::from(rel_raw));
            if joined.exists() {
                return Some(joined.to_string_lossy().to_string());
            }
        }
        return Some(parent.join(rel.trim()).to_string_lossy().to_string());
    }
    None
}

/// Comprehensive search near the ALS project directory.
/// Searches all Samples/ subdirectories AND the project root recursively
/// up to 4 levels deep.
fn search_near_project_recursive(als_path: &Path, file_name: &str) -> Option<String> {
    let root = als_path.parent()?;

    // Hot directories — these are the most likely locations
    let hot_dirs = [
        root.join("Samples").join("Imported"),
        root.join("Samples").join("Processed"),
        root.join("Samples").join("Recorded"),
        root.join("Samples").join("Consolidated"),
        root.join("Samples").join("Rendered"),
        root.join("Samples").join("Crops"),
        root.join("Samples").join("Bounced"),
        root.join("Samples"),
        root.join("Audio"),
        root.join("Recordings"),
        root.to_path_buf(),
    ];

    for dir in hot_dirs {
        if !dir.exists() {
            continue;
        }
        if let Some(found) = search_directory_recursive(&dir, file_name, 0, 4) {
            return Some(found);
        }
    }

    // Also search parent directory (common for multi-project setups)
    if let Some(grandparent) = root.parent() {
        // Search grandparent's Samples/ dir
        let shared_samples = grandparent.join("Samples");
        if shared_samples.exists()
            && let Some(found) = search_directory_recursive(&shared_samples, file_name, 0, 3)
        {
            return Some(found);
        }
        // Search grandparent itself (sibling projects may share samples)
        if let Some(found) = search_directory_recursive(grandparent, file_name, 0, 2) {
            return Some(found);
        }
        // Search great-grandparent for BPM-folder structures
        // (e.g. "ABLETON/160-200 BPM/48. Drift Away" shares with "ABLETON/120-160 BPM/*")
        if let Some(great_grandparent) = grandparent.parent() {
            if let Some(found) = search_directory_recursive(great_grandparent, file_name, 0, 3) {
                return Some(found);
            }
        }
    }

    None
}

/// Recursive directory search for a specific filename.
fn search_directory_recursive(
    dir: &Path,
    target_filename: &str,
    depth: usize,
    max_depth: usize,
) -> Option<String> {
    if depth > max_depth {
        return None;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return None;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Some(name) = path.file_name().and_then(|s| s.to_str())
                && name.eq_ignore_ascii_case(target_filename)
            {
                return Some(path.to_string_lossy().to_string());
            }
        } else if path.is_dir()
            && let Some(found) =
                search_directory_recursive(&path, target_filename, depth + 1, max_depth)
        {
            return Some(found);
        }
    }
    None
}

/// Search macOS Ableton Live standard library locations.
fn search_ableton_library(file_name: &str) -> Option<String> {
    let home: PathBuf = dirs::home_dir()?;

    // Ableton User Library paths (macOS)
    let mut library_dirs: Vec<PathBuf> = vec![
        // User Library
        home.join("Music/Ableton/User Library/Samples"),
        home.join("Music/Ableton/User Library"),
        // Factory Packs
        home.join("Music/Ableton/Factory Packs"),
        // Application Support (preferences, templates, presets)
        home.join("Library/Application Support/Ableton"),
        // Common third-party sample locations
        home.join("Music/Samples"),
        home.join("Music/Audio"),
        home.join("Documents/Samples"),
        home.join("Documents/Audio"),
        // Splice samples
        home.join("Splice/Samples"),
        home.join("Library/Audio/Sounds"),
    ];

    // ── Ableton Live versioned Packs & Core Library ──
    // Factory samples live in /Applications/Ableton Live <ver>/Contents/App-Resources/
    // and in ~/Music/Ableton/Live <ver>/Packs/ or ~/Library/Application Support/Ableton/Live <ver>/
    for ver in 9..=13 {
        let suite = format!("Ableton Live {} Suite.app", ver);
        let standard = format!("Ableton Live {}.app", ver);
        let beta = format!("Ableton Live {} Beta.app", ver);
        let suite_beta = format!("Ableton Live {} Suite Beta.app", ver);
        // Application bundle resources (Release, Suite, Beta, Suite Beta)
        for app_name in [&suite, &standard, &beta, &suite_beta] {
            library_dirs.push(PathBuf::from(format!(
                "/Applications/{}/Contents/App-Resources/Core Library",
                app_name
            )));
            library_dirs.push(PathBuf::from(format!(
                "/Applications/{}/Contents/App-Resources",
                app_name
            )));
        }
        // User-installed Packs
        library_dirs.push(home.join(format!("Music/Ableton/Live {}/User Library/Samples", ver)));
        library_dirs.push(home.join(format!("Music/Ableton/Live {}/User Library", ver)));
        library_dirs.push(home.join(format!("Library/Application Support/Ableton/Live {}", ver)));
    }

    // ── Dynamic scan for minor version directories (Live 12.3, Live 12.3.5, etc.) ──
    // Ableton stores support files under ~/Library/Application Support/Ableton/Live X.Y.Z/
    let ableton_support = home.join("Library/Application Support/Ableton");
    if ableton_support.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&ableton_support) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if name_str.starts_with("Live ") && entry.path().is_dir() {
                    library_dirs.push(entry.path());
                }
            }
        }
    }

    // ── Ableton Packs download cache ──
    // Packs downloaded via Pack Manager land in ~/Library/Application Support/Ableton/
    library_dirs.push(home.join("Library/Application Support/Ableton/Live Database"));
    library_dirs.push(home.join("Library/Application Support/Ableton/Packs"));

    // ── User ABLETON folder ──
    // Some users store projects in ~/ABLETON - Main Folder/ or ~/ABLETON/
    library_dirs.push(home.join("ABLETON - Main Folder"));
    library_dirs.push(home.join("ABLETON"));

    for dir in &library_dirs {
        if !dir.exists() {
            continue;
        }
        // Use depth=5 for library dirs (they can be deeply nested)
        if let Some(found) = search_directory_recursive(dir, file_name, 0, 5) {
            return Some(found);
        }
    }

    None
}

// ── Audio Clip Source Path Extraction ───────────────────────────────────

/// Extracts the source audio file path from an audio clip XML node.
/// Enterprise edition: parses full FileRef including SearchHint,
/// RelativePathElement chain, and deep fallback search.
pub fn extract_audio_clip_source_path(
    clip_node: roxmltree::Node<'_, '_>,
    als_path: &Path,
) -> String {
    extract_audio_clip_source_path_cached(clip_node, als_path, None)
}

/// Same as `extract_audio_clip_source_path` but with optional cache.
pub fn extract_audio_clip_source_path_cached(
    clip_node: roxmltree::Node<'_, '_>,
    als_path: &Path,
    cache: Option<&PathResolverCache>,
) -> String {
    // Strategy 1: <SampleRef><FileRef>...</FileRef></SampleRef>
    let sample_ref = clip_node
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("SampleRef"));

    if let Some(sample_ref) = sample_ref
        && let Some(file_ref) = sample_ref
            .children()
            .find(|n| n.is_element() && n.has_tag_name("FileRef"))
        && let Some(resolved) = resolve_file_ref_enterprise(file_ref, als_path, cache)
    {
        return resolved;
    }

    // Strategy 2: <FileRef> directly under the clip
    if let Some(file_ref) = clip_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("FileRef"))
        && let Some(resolved) = resolve_file_ref_enterprise(file_ref, als_path, cache)
    {
        return resolved;
    }

    // Strategy 3: <Name Value="..."/> fallback
    first_child_value(clip_node, "Name").unwrap_or_else(|| "unknown_sample".to_string())
}

/// Enterprise FileRef resolution — uses all available path information.
fn resolve_file_ref_enterprise(
    file_ref: roxmltree::Node<'_, '_>,
    als_path: &Path,
    cache: Option<&PathResolverCache>,
) -> Option<String> {
    let parsed = parse_ableton_file_ref(file_ref);

    // Try: absolute path (with dash/space/dot variant matching)
    if let Some(abs) = &parsed.abs_path
        && !abs.trim().is_empty()
    {
        if let Some(found) = try_existing_variants(abs.trim()) {
            log::debug!("[ALS Resolver] Found via absolute path: {}", found);
            return Some(found);
        }
    }

    // Try: relative path (with variant matching)
    if let Some(rel) = &parsed.relative_path
        && !rel.trim().is_empty()
    {
        let parent = als_path.parent().unwrap_or_else(|| Path::new("."));
        let joined = parent.join(rel.trim()).to_string_lossy().to_string();
        if let Some(found) = try_existing_variants(&joined) {
            log::debug!(
                "[ALS Resolver] Found via relative path: {}",
                found
            );
            return Some(found);
        }
    }

    // Try: RelativePathElement chain
    if let Some(rel_elements) = &parsed.relative_path_elements {
        let parent = als_path.parent().unwrap_or_else(|| Path::new("."));
        // RelativePathElement gives us the directory chain.
        // We need to append the filename.
        let file_name = parsed
            .file_name
            .as_deref()
            .or(parsed
                .abs_path
                .as_deref()
                .and_then(|p| Path::new(p).file_name().and_then(|s| s.to_str())))
            .unwrap_or_default();
        if !file_name.is_empty() {
            let joined = parent.join(rel_elements).join(file_name).to_string_lossy().to_string();
            if let Some(found) = try_existing_variants(&joined) {
                log::debug!(
                    "[ALS Resolver] Found via RelativePathElement chain: {}",
                    found
                );
                return Some(found);
            }
        }
    }

    // Try: SearchHint PathHint (with variant matching)
    if let Some(hint) = &parsed.search_hint_path
        && !hint.trim().is_empty()
    {
        if let Some(found) = try_existing_variants(hint.trim()) {
            let found_path = Path::new(&found);
            // Validate file size if available
            let size_ok = parsed
                .search_hint_file_size
                .map(|expected| {
                    std::fs::metadata(found_path)
                        .map(|m| m.len() as i64 == expected)
                        .unwrap_or(false)
                })
                .unwrap_or(true);
            if size_ok {
                log::debug!("[ALS Resolver] Found via SearchHint: {}", found);
                return Some(found);
            }
        }
    }

    // Try: Deep search with all available filename info
    let file_name = parsed
        .file_name
        .as_deref()
        .or(parsed
            .abs_path
            .as_deref()
            .and_then(|p| Path::new(p).file_name().and_then(|s| s.to_str())))
        .or(parsed
            .relative_path
            .as_deref()
            .and_then(|p| Path::new(p).file_name().and_then(|s| s.to_str())))
        .or(parsed
            .search_hint_path
            .as_deref()
            .and_then(|p| Path::new(p).file_name().and_then(|s| s.to_str())));

    if let Some(fname) = file_name
        && !fname.is_empty()
    {
        // Search near project
        if let Some(found) = search_near_project_recursive(als_path, fname) {
            log::info!("[ALS Resolver] Found via deep project search: {}", found);
            return Some(found);
        }

        // Search Ableton library
        if let Some(found) = search_ableton_library(fname) {
            log::info!("[ALS Resolver] Found via Ableton library search: {}", found);
            return Some(found);
        }

        // Cache-based search
        if let Some(cache) = cache {
            let hint = parsed.search_hint_path.as_deref().unwrap_or("");
            if let Some(found) = cache.find_by_filename_with_hint(fname, hint) {
                log::info!("[ALS Resolver] Found via cache: {}", found.display());
                return Some(found.to_string_lossy().to_string());
            }
        }
    }

    // Fallback: use the basic resolver for backwards compatibility
    let abs = parsed.abs_path.as_deref();
    let rel = parsed.relative_path.as_deref();
    resolve_als_file_path_cached(als_path, abs, rel, cache)
}

/// Extracts a sample path from a Simpler device XML node.
/// Enterprise: searches Player → MultiSampleMap → ALL SampleParts.
pub fn extract_simpler_sample_path(
    device: roxmltree::Node<'_, '_>,
    als_path: &Path,
) -> Option<String> {
    extract_simpler_sample_path_cached(device, als_path, None)
}

/// Same as `extract_simpler_sample_path` but with optional cache.
pub fn extract_simpler_sample_path_cached(
    device: roxmltree::Node<'_, '_>,
    als_path: &Path,
    cache: Option<&PathResolverCache>,
) -> Option<String> {
    // Look for Player → MultiSampleMap → SamplePart → SampleRef → FileRef
    let player = device
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("Player"))?;
    let multi_sample = player
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("MultiSampleMap"))?;

    // Try ALL SampleParts (not just the first one)
    for sample_part in multi_sample
        .descendants()
        .filter(|n| n.is_element() && n.has_tag_name("SamplePart"))
    {
        // Try SampleRef → FileRef
        if let Some(sample_ref) = sample_part
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("SampleRef"))
            && let Some(file_ref) = sample_ref
                .children()
                .find(|n| n.is_element() && n.has_tag_name("FileRef"))
            && let Some(resolved) = resolve_file_ref_enterprise(file_ref, als_path, cache)
        {
            return Some(resolved);
        }

        // Direct FileRef under SamplePart
        if let Some(file_ref) = sample_part
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("FileRef"))
            && let Some(resolved) = resolve_file_ref_enterprise(file_ref, als_path, cache)
        {
            return Some(resolved);
        }
    }

    // Fallback: try any FileRef in the entire device tree
    for file_ref in device
        .descendants()
        .filter(|n| n.is_element() && n.has_tag_name("FileRef"))
    {
        let abs_path = first_child_value(file_ref, "Path");
        let rel_path = first_child_value(file_ref, "RelativePath");
        if let Some(resolved) =
            resolve_als_file_path_cached(als_path, abs_path.as_deref(), rel_path.as_deref(), cache)
        {
            return Some(resolved);
        }
    }

    None
}

/// Extract ALL sample paths from a Sampler device (multi-zone instrument).
/// Returns a Vec of (sample_path, root_note, key_range_low, key_range_high).
pub fn extract_sampler_all_zones(
    device: roxmltree::Node<'_, '_>,
    als_path: &Path,
    cache: Option<&PathResolverCache>,
) -> Vec<SamplerZoneEntry> {
    let mut zones: Vec<SamplerZoneEntry> = Vec::new();

    for sample_part in device
        .descendants()
        .filter(|n| n.is_element() && n.has_tag_name("SamplePart"))
    {
        let root_note = first_child_value(sample_part, "RootKey")
            .or_else(|| first_child_value(sample_part, "KeyRoot"))
            .and_then(|v| v.parse::<u8>().ok());
        let key_low = first_child_value(sample_part, "KeyRange_CrossfadeMin")
            .or_else(|| first_child_value(sample_part, "KeyRangeClipMin"))
            .and_then(|v| v.parse::<u8>().ok());
        let key_high = first_child_value(sample_part, "KeyRange_CrossfadeMax")
            .or_else(|| first_child_value(sample_part, "KeyRangeClipMax"))
            .and_then(|v| v.parse::<u8>().ok());

        // Try SampleRef → FileRef
        let file_ref = sample_part
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("SampleRef"))
            .and_then(|sr| {
                sr.children()
                    .find(|n| n.is_element() && n.has_tag_name("FileRef"))
            })
            .or_else(|| {
                sample_part
                    .descendants()
                    .find(|n| n.is_element() && n.has_tag_name("FileRef"))
            });

        if let Some(fr) = file_ref
            && let Some(resolved) = resolve_file_ref_enterprise(fr, als_path, cache)
        {
            zones.push((resolved, root_note, key_low, key_high));
        }
    }

    zones
}

fn percent_decode_lossy(raw: &str) -> String {
    let mut out = Vec::<u8>::with_capacity(raw.len());
    let bytes = raw.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h1 = bytes[i + 1] as char;
            let h2 = bytes[i + 2] as char;
            if h1.is_ascii_hexdigit() && h2.is_ascii_hexdigit() {
                let hex = &raw[i + 1..i + 3];
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn normalize_file_uri(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if !trimmed.to_ascii_lowercase().starts_with("file://") {
        return None;
    }
    let no_scheme = &trimmed[7..];
    let decoded = percent_decode_lossy(no_scheme);
    let normalized = decoded.replace('\\', "/");

    if let Some(rest) = normalized.strip_prefix('/') {
        // file:///Users/... or file:///C:/... ; strip leading slash for drive paths.
        let bytes = rest.as_bytes();
        if bytes.len() >= 2 && bytes[1] == b':' && (bytes[0] as char).is_ascii_alphabetic() {
            return Some(rest.to_string());
        }
        // file://localhost/...
        if rest.to_ascii_lowercase().starts_with("localhost/") {
            let local = &rest["localhost/".len()..];
            return Some(format!("/{local}"));
        }
        return Some(normalized);
    }

    // file://localhost/path or file://C:/path.
    if normalized.to_ascii_lowercase().starts_with("localhost/") {
        let local = &normalized["localhost/".len()..];
        return Some(format!("/{local}"));
    }
    Some(normalized)
}

// ── Fade Frame Parsing ─────────────────────────────────────────────────

/// Parsed fade info including length and curve shape.
pub struct FadeInfo {
    pub fade_in_frames: i64,
    pub fade_out_frames: i64,
    pub fade_in_curve_skew: f64,
    pub fade_in_curve_slope: f64,
    pub fade_out_curve_skew: f64,
    pub fade_out_curve_slope: f64,
}

/// Parses fade-in and fade-out info from an audio clip XML node.
/// Returns frame durations AND curve shape parameters for high-fidelity import.
pub fn parse_fade_info_from_audio_clip(
    clip_node: roxmltree::Node<'_, '_>,
    bpm: f64,
    sample_rate: f64,
) -> FadeInfo {
    let fades = clip_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("Fades"));
    let Some(fades) = fades else {
        return FadeInfo {
            fade_in_frames: 0,
            fade_out_frames: 0,
            fade_in_curve_skew: 0.0,
            fade_in_curve_slope: 0.0,
            fade_out_curve_skew: 0.0,
            fade_out_curve_slope: 0.0,
        };
    };
    let fade_in_beats = first_child_f64(fades, "FadeInLength").unwrap_or(0.0);
    let fade_out_beats = first_child_f64(fades, "FadeOutLength").unwrap_or(0.0);
    FadeInfo {
        fade_in_frames: beats_to_frames(fade_in_beats, bpm, sample_rate),
        fade_out_frames: beats_to_frames(fade_out_beats, bpm, sample_rate),
        fade_in_curve_skew: first_child_f64(fades, "FadeInCurveSkew")
            .unwrap_or(0.0)
            .clamp(-1.0, 1.0),
        fade_in_curve_slope: first_child_f64(fades, "FadeInCurveSlope")
            .unwrap_or(0.0)
            .clamp(-1.0, 1.0),
        fade_out_curve_skew: first_child_f64(fades, "FadeOutCurveSkew")
            .unwrap_or(0.0)
            .clamp(-1.0, 1.0),
        fade_out_curve_slope: first_child_f64(fades, "FadeOutCurveSlope")
            .unwrap_or(0.0)
            .clamp(-1.0, 1.0),
    }
}

/// Legacy wrapper: Parses fade-in and fade-out frame durations from an audio clip XML node.
pub fn parse_fade_frames_from_audio_clip(
    clip_node: roxmltree::Node<'_, '_>,
    bpm: f64,
    sample_rate: f64,
) -> (i64, i64) {
    let info = parse_fade_info_from_audio_clip(clip_node, bpm, sample_rate);
    (info.fade_in_frames, info.fade_out_frames)
}

/// Copies clip source files to `<project>/Samples/Imported` and rewrites
/// project clip paths to the consolidated location.
///
/// Non-fatal by design: failures are logged and skipped.
pub fn consolidate_project_samples_for_als_import(project: &mut Project, als_path: &Path) -> usize {
    let Some(project_dir) = als_path.parent() else {
        return 0;
    };

    let imported_dir = project_dir.join("Samples").join("Imported");
    if let Err(e) = std::fs::create_dir_all(&imported_dir) {
        log::warn!("Could not create Samples/Imported directory for ALS import: {e}");
        return 0;
    }

    let mut rewrites = Vec::new();
    for track in &project.tracks {
        for clip in &track.clips {
            let src = Path::new(&clip.file_path);
            if !src.exists() || clip.file_path.trim().is_empty() {
                continue;
            }
            let Some(file_name) = src.file_name() else {
                continue;
            };
            let dest = imported_dir.join(file_name);
            if !dest.exists()
                && let Err(e) = std::fs::copy(src, &dest)
            {
                log::warn!(
                    "Sample consolidation: failed to copy '{}': {e}",
                    src.display()
                );
                continue;
            }
            rewrites.push((
                track.id,
                clip.file_path.clone(),
                dest.to_string_lossy().to_string(),
            ));
        }
    }

    let mut rewritten = 0usize;
    for (track_id, old_path, new_path) in rewrites {
        if let Some(track) = project.find_track_mut(track_id) {
            for clip in &mut track.clips {
                if clip.file_path == old_path {
                    clip.file_path = new_path.clone();
                    rewritten += 1;
                }
            }
        }
    }

    log::info!(
        "ALS import: samples consolidated to '{}' ({} clip path rewrites)",
        imported_dir.display(),
        rewritten
    );
    rewritten
}

#[cfg(test)]
mod tests {
    use super::resolve_als_file_path;
    use std::path::Path;

    #[test]
    fn resolve_supports_windows_style_relative_paths() {
        let base = std::env::temp_dir().join(format!("dream_als_rel_{}", uuid::Uuid::new_v4()));
        let samples_dir = base.join("Samples").join("Imported");
        std::fs::create_dir_all(&samples_dir).expect("create sample dir");
        let expected = samples_dir.join("snare.wav");
        std::fs::write(&expected, b"RIFF").expect("write sample");
        let als_path = base.join("Project.als");

        let resolved = resolve_als_file_path(&als_path, None, Some("Samples\\Imported\\snare.wav"))
            .expect("resolved path");

        assert_eq!(Path::new(&resolved), expected.as_path());
    }

    #[test]
    fn resolve_supports_file_uri_with_percent_encoding() {
        let base = std::env::temp_dir().join(format!("dream_als_uri_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).expect("create base dir");
        let expected = base.join("Kick 01.wav");
        std::fs::write(&expected, b"RIFF").expect("write sample");

        let encoded = expected.to_string_lossy().replace(' ', "%20");
        let uri = format!("file://localhost{encoded}");
        let als_path = base.join("Project.als");

        let resolved =
            resolve_als_file_path(&als_path, Some(&uri), None).expect("resolved uri path");

        assert_eq!(Path::new(&resolved), expected.as_path());
    }

    #[test]
    fn resolve_supports_utf8_percent_encoded_paths() {
        let base = std::env::temp_dir().join(format!("dream_als_utf8_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).expect("create base dir");
        let expected = base.join("Кик.wav");
        std::fs::write(&expected, b"RIFF").expect("write sample");
        let encoded = expected
            .to_string_lossy()
            .replace("К", "%D0%9A")
            .replace("и", "%D0%B8");
        let uri = format!("file://localhost{encoded}");
        let als_path = base.join("Project.als");

        let resolved =
            resolve_als_file_path(&als_path, Some(&uri), None).expect("resolved utf8 uri path");

        assert_eq!(Path::new(&resolved), expected.as_path());
    }

    #[test]
    fn resolve_supports_windows_file_uri_drive_prefix() {
        let als_path = Path::new("/tmp/Project.als");
        let uri = "file:///C:/Users/User/Samples/Kick%2001.wav";
        let resolved =
            resolve_als_file_path(als_path, Some(uri), None).expect("resolved windows uri");
        assert_eq!(resolved, "C:/Users/User/Samples/Kick 01.wav");
    }
}
