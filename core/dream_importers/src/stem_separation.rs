// ═══════════════════════════════════════════════════════════════════════
// Stem Separation & Bounce Utilities
//
// Pure filesystem/process logic extracted from clip_mutators.rs.
// Zero Tauri dependency.
// ═══════════════════════════════════════════════════════════════════════

use std::collections::HashMap;
use std::path::{Path, PathBuf};

// ── Bounce Output Path ──────────────────────────────────────────────────

/// Creates a unique temporary WAV file path for bounce output.
///
/// Path format: `{temp_dir}/dream_daw_bounces/{prefix}_{timestamp_ms}.wav`
pub fn make_bounce_output_path(prefix: &str) -> Result<String, String> {
    let dir = std::env::temp_dir().join("dream_daw_bounces");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create bounce temp dir: {e}"))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let file_name = format!("{}_{}.wav", prefix, ts);
    Ok(dir.join(file_name).to_string_lossy().to_string())
}

// ── File Fingerprinting ─────────────────────────────────────────────────

/// Computes a 64-bit hash fingerprint of a file's contents.
///
/// Used for stem separation caching: if the same file is processed twice,
/// the previously separated stems are reused from cache.
pub fn compute_file_fingerprint(path: &Path) -> Result<String, String> {
    use std::hash::{Hash, Hasher};
    let file = std::fs::File::open(path)
        .map_err(|e| format!("Failed to open file for fingerprint: {e}"))?;
    let mut reader = std::io::BufReader::new(file);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut buf = [0_u8; 64 * 1024];
    let mut total: u64 = 0;
    loop {
        let n = std::io::Read::read(&mut reader, &mut buf)
            .map_err(|e| format!("Failed reading file for fingerprint: {e}"))?;
        if n == 0 {
            break;
        }
        total = total.saturating_add(n as u64);
        buf[..n].hash(&mut hasher);
    }
    total.hash(&mut hasher);
    Ok(format!("{:016x}", hasher.finish()))
}

// ── Demucs Stem Separation ──────────────────────────────────────────────

/// Runs Demucs 4-stem separation on an audio file.
///
/// Requires `python3 -m demucs.separate` to be available on PATH.
/// Returns a map of stem name → file path for: drums, bass, other, vocals.
pub fn run_demucs_4stems(
    input_path: &Path,
    output_root: &Path,
) -> Result<HashMap<String, String>, String> {
    std::fs::create_dir_all(output_root)
        .map_err(|e| format!("Failed to create stems output dir: {e}"))?;

    let status = std::process::Command::new("python3")
        .arg("-m")
        .arg("demucs.separate")
        .arg("-n")
        .arg("htdemucs")
        .arg("--out")
        .arg(output_root)
        .arg(input_path)
        .status()
        .map_err(|e| {
            format!(
                "Failed to launch Demucs (python3 -m demucs.separate): {e}. Install with: pip3 install demucs"
            )
        })?;

    if !status.success() {
        return Err(
            "Demucs stem separation failed. Make sure Demucs is installed: pip3 install demucs"
                .to_string(),
        );
    }

    fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    collect_files(&path, out);
                } else {
                    out.push(path);
                }
            }
        }
    }

    let mut all_files = Vec::<PathBuf>::new();
    collect_files(output_root, &mut all_files);
    let wanted = ["drums", "bass", "other", "vocals"];
    let mut by_stem: HashMap<String, String> = HashMap::new();
    for file in all_files {
        let Some(stem_name) = file.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if wanted.contains(&stem_name) {
            by_stem.insert(stem_name.to_string(), file.to_string_lossy().to_string());
        }
    }

    for key in wanted {
        if !by_stem.contains_key(key) {
            return Err(format!(
                "Demucs output is incomplete: missing '{}' stem",
                key
            ));
        }
    }

    Ok(by_stem)
}

/// Returns cached stems if available, otherwise runs Demucs and caches the result.
///
/// Cache key is a fingerprint of the source file's contents.
/// Cache location: `{temp_dir}/dream_daw_stem_cache/{fingerprint}/`.
pub fn get_cached_or_build_stems(
    source_mix_path: &Path,
) -> Result<HashMap<String, String>, String> {
    let fingerprint = compute_file_fingerprint(source_mix_path)?;
    let cache_dir = std::env::temp_dir()
        .join("dream_daw_stem_cache")
        .join(fingerprint);
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create stem cache dir: {e}"))?;

    let stems = ["drums", "bass", "other", "vocals"];
    let mut cached: HashMap<String, String> = HashMap::new();
    let mut all_exist = true;
    for stem in stems {
        let p = cache_dir.join(format!("{stem}.wav"));
        if p.exists() {
            cached.insert(stem.to_string(), p.to_string_lossy().to_string());
        } else {
            all_exist = false;
        }
    }
    if all_exist {
        return Ok(cached);
    }

    let run_dir = std::env::temp_dir().join("dream_daw_stems").join(format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis()
    ));
    let produced = run_demucs_4stems(source_mix_path, &run_dir)?;

    let mut out: HashMap<String, String> = HashMap::new();
    for stem in ["drums", "bass", "other", "vocals"] {
        let src = produced
            .get(stem)
            .ok_or_else(|| format!("Missing generated stem: {stem}"))?;
        let dst = cache_dir.join(format!("{stem}.wav"));
        std::fs::copy(src, &dst).map_err(|e| format!("Failed to cache stem '{stem}': {e}"))?;
        out.insert(stem.to_string(), dst.to_string_lossy().to_string());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_make_bounce_output_path() {
        let path = make_bounce_output_path("test_bounce").unwrap();
        assert!(path.contains("dream_daw_bounces"));
        assert!(path.ends_with(".wav"));
        assert!(path.contains("test_bounce"));
    }

    #[test]
    fn test_make_bounce_output_path_unique() {
        let p1 = make_bounce_output_path("bounce_a").unwrap();
        // Ensure minimal time offset for uniqueness
        std::thread::sleep(std::time::Duration::from_millis(2));
        let p2 = make_bounce_output_path("bounce_b").unwrap();
        assert_ne!(p1, p2);
    }
}
