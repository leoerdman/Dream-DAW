// ═══════════════════════════════════════════════════════════════════════
// Dream DAW — Ableton ALS File Path Resolution
// ═══════════════════════════════════════════════════════════════════════
//
// Resolves sample file references from ALS XML nodes to local paths.
// Handles absolute paths, relative paths, and searches near the project.
//
// ═══════════════════════════════════════════════════════════════════════

use std::path::{Path, PathBuf};

use dream_models::project::Project;

use super::xml_helpers::*;

// ── Path Resolution ────────────────────────────────────────────────────

/// Resolves an ALS sample file reference to a local filesystem path.
///
/// Tries absolute path first, then relative path joined with the ALS
/// parent directory. Falls back to fuzzy filename search near the project.
pub fn resolve_als_file_path(
    als_path: &Path,
    absolute_path: Option<&str>,
    relative_path: Option<&str>,
) -> Option<String> {
    fn try_existing_variants(raw: &str) -> Option<String> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }

        let candidates = [
            trimmed.to_string(),
            trimmed.replace(" - ", "-"),
            trimmed.replace(" -", "-"),
            trimmed.replace("- ", "-"),
            trimmed.replace("160 - 200 BPM", "160-200 BPM"),
        ];
        for candidate in candidates {
            if std::path::Path::new(&candidate).exists() {
                return Some(candidate);
            }
        }
        None
    }

    fn search_near_project(als_path: &Path, raw: &str) -> Option<String> {
        let file_name = std::path::Path::new(raw)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        if file_name.is_empty() {
            return None;
        }
        let root = als_path.parent()?;
        let hot_dirs = [
            root.join("Samples").join("Imported"),
            root.join("Samples").join("Processed"),
            root.join("Samples").join("Recorded"),
            root.join("Samples"),
        ];
        for dir in hot_dirs {
            if !dir.exists() {
                continue;
            }
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file()
                        && path
                            .file_name()
                            .and_then(|s| s.to_str())
                            .map(|n| n.eq_ignore_ascii_case(&file_name))
                            .unwrap_or(false)
                    {
                        return Some(path.to_string_lossy().to_string());
                    }
                }
            }
        }
        None
    }

    if let Some(abs) = absolute_path
        && !abs.trim().is_empty()
    {
        if let Some(found) = try_existing_variants(abs) {
            return Some(found);
        }
        if let Some(found) = search_near_project(als_path, abs) {
            return Some(found);
        }
        return Some(abs.trim().to_string());
    }
    if let Some(rel) = relative_path
        && !rel.trim().is_empty()
    {
        let rel_path = PathBuf::from(rel);
        if rel_path.is_absolute() {
            if let Some(found) = try_existing_variants(&rel_path.to_string_lossy()) {
                return Some(found);
            }
            return Some(rel_path.to_string_lossy().to_string());
        }
        let parent = als_path.parent().unwrap_or_else(|| Path::new("."));
        let joined = parent.join(rel_path).to_string_lossy().to_string();
        if let Some(found) = try_existing_variants(&joined) {
            return Some(found);
        }
        if let Some(found) = search_near_project(als_path, &joined) {
            return Some(found);
        }
        return Some(joined);
    }
    None
}

// ── Audio Clip Source Path Extraction ───────────────────────────────────

/// Extracts the source audio file path from an audio clip XML node.
pub fn extract_audio_clip_source_path(
    clip_node: roxmltree::Node<'_, '_>,
    als_path: &Path,
) -> String {
    // Strategy 1: <SampleRef><FileRef><Path Value="..." /></FileRef></SampleRef>
    let sample_ref = clip_node
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("SampleRef"));

    if let Some(sample_ref) = sample_ref {
        if let Some(file_ref) = sample_ref
            .children()
            .find(|n| n.is_element() && n.has_tag_name("FileRef"))
        {
            let abs_path = first_child_value(file_ref, "Path");
            let rel_path = first_child_value(file_ref, "RelativePath")
                .or_else(|| first_child_value(file_ref, "RelativePathElement"));
            if let Some(resolved) = resolve_als_file_path(
                als_path,
                abs_path.as_deref(),
                rel_path.as_deref(),
            ) {
                return resolved;
            }
        }
    }

    // Strategy 2: <FileRef> directly under the clip
    if let Some(file_ref) = clip_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("FileRef"))
    {
        let abs_path = first_child_value(file_ref, "Path");
        let rel_path = first_child_value(file_ref, "RelativePath");
        if let Some(resolved) = resolve_als_file_path(
            als_path,
            abs_path.as_deref(),
            rel_path.as_deref(),
        ) {
            return resolved;
        }
    }

    // Strategy 3: <Name Value="..." /> fallback
    first_child_value(clip_node, "Name")
        .unwrap_or_else(|| "unknown_sample".to_string())
}

/// Extracts a sample path from a Simpler device XML node.
pub fn extract_simpler_sample_path(
    device: roxmltree::Node<'_, '_>,
    als_path: &Path,
) -> Option<String> {
    let player = device
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("Player"))?;
    let multi_sample = player
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("MultiSampleMap"))?;
    let sample_part = multi_sample
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("SamplePart"))?;
    let file_ref = sample_part
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("FileRef"))?;
    let abs_path = first_child_value(file_ref, "Path");
    let rel_path = first_child_value(file_ref, "RelativePath");
    resolve_als_file_path(als_path, abs_path.as_deref(), rel_path.as_deref())
}

// ── Fade Frame Parsing ─────────────────────────────────────────────────

/// Parses fade-in and fade-out frame durations from an audio clip XML node.
pub fn parse_fade_frames_from_audio_clip(
    clip_node: roxmltree::Node<'_, '_>,
    bpm: f64,
    sample_rate: f64,
) -> (i64, i64) {
    let fades = clip_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("Fades"));
    let Some(fades) = fades else {
        return (0, 0);
    };
    let fade_in_beats = first_child_f64(fades, "FadeInLength").unwrap_or(0.0);
    let fade_out_beats = first_child_f64(fades, "FadeOutLength").unwrap_or(0.0);
    (
        beats_to_frames(fade_in_beats, bpm, sample_rate),
        beats_to_frames(fade_out_beats, bpm, sample_rate),
    )
}

/// Copies clip source files to `<project>/Samples/Imported` and rewrites
/// project clip paths to the consolidated location.
///
/// Non-fatal by design: failures are logged and skipped.
pub fn consolidate_project_samples_for_als_import(
    project: &mut Project,
    als_path: &Path,
) -> usize {
    let Some(project_dir) = als_path.parent() else {
        return 0;
    };

    let imported_dir = project_dir.join("Samples").join("Imported");
    if let Err(e) = std::fs::create_dir_all(&imported_dir) {
        log::warn!(
            "Could not create Samples/Imported directory for ALS import: {e}"
        );
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
            if !dest.exists() && let Err(e) = std::fs::copy(src, &dest) {
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
