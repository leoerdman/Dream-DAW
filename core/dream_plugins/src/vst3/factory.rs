use std::path::{Path, PathBuf};

/// Resolves the native binary path inside a VST3 bundle.
///
/// macOS: `<name>.vst3/Contents/MacOS/<name>`
/// Linux: `<name>.vst3/Contents/x86_64-linux/<name>.so`
/// Windows: `<name>.vst3/Contents/x86_64-win/<name>.vst3`
pub fn resolve_vst3_binary(bundle_path: &Path) -> Option<PathBuf> {
    let stem = bundle_path.file_stem()?.to_str()?;

    #[cfg(target_os = "macos")]
    {
        let binary = bundle_path.join("Contents").join("MacOS").join(stem);
        if binary.exists() {
            return Some(binary);
        }

        let macos_dir = bundle_path.join("Contents").join("MacOS");
        if let Ok(entries) = std::fs::read_dir(&macos_dir) {
            let mut files: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_file())
                .collect();
            files.sort();

            let stem_lower = stem.to_ascii_lowercase();
            if let Some(p) = files.iter().find(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.eq_ignore_ascii_case(stem))
                    .unwrap_or(false)
            }) {
                return Some(p.clone());
            }
            if let Some(p) = files.iter().find(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.to_ascii_lowercase().starts_with(&stem_lower))
                    .unwrap_or(false)
            }) {
                return Some(p.clone());
            }

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Some(p) = files.iter().find(|p| {
                    std::fs::metadata(p)
                        .map(|m| (m.permissions().mode() & 0o111) != 0)
                        .unwrap_or(false)
                }) {
                    return Some(p.clone());
                }
            }

            if let Some(p) = files.first() {
                return Some(p.clone());
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let binary = bundle_path
            .join("Contents")
            .join("x86_64-linux")
            .join(format!("{stem}.so"));
        if binary.exists() {
            return Some(binary);
        }
    }

    #[cfg(target_os = "windows")]
    {
        let binary = bundle_path
            .join("Contents")
            .join("x86_64-win")
            .join(format!("{stem}.vst3"));
        if binary.exists() {
            return Some(binary);
        }
    }

    None
}
