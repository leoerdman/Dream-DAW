// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Clip Pool (Pre-loaded Audio Data)
// ═══════════════════════════════════════════════════════════════════════════
//
// Manages pre-loaded audio data in RAM for real-time playback.
//
// The pool is populated by the UI/worker thread (using dream_io::AudioReader)
// and consumed by the audio thread (via ClipReader).
//
// Thread safety is handled via read-only Arc references:
//   - Worker thread: loads audio, creates Arc<ClipAudio>, stores in pool
//   - Audio thread: reads Arc<ClipAudio> (immutable, zero-copy)
//
// ═══════════════════════════════════════════════════════════════════════════

use std::collections::HashMap;
use std::sync::Arc;

/// Pre-loaded audio data for a single clip.
///
/// Stored in the pool as `Arc<ClipAudio>` for zero-copy sharing
/// between the UI thread and audio thread.
#[derive(Debug, Clone)]
pub struct ClipAudio {
    /// Source file path (for cache key).
    pub source_path: String,

    /// De-interleaved channel data.
    pub channels: Vec<Vec<f32>>,

    /// Sample rate of the source audio.
    pub sample_rate: u32,

    /// Total number of frames.
    pub num_frames: usize,
}

impl ClipAudio {
    /// Creates a new ClipAudio from raw channel data.
    pub fn new(source_path: impl Into<String>, channels: Vec<Vec<f32>>, sample_rate: u32) -> Self {
        let num_frames = channels.first().map(|ch| ch.len()).unwrap_or(0);
        Self {
            source_path: source_path.into(),
            channels,
            sample_rate,
            num_frames,
        }
    }

    /// Returns left channel data (or empty if no channels).
    pub fn left(&self) -> &[f32] {
        self.channels.first().map(|ch| ch.as_slice()).unwrap_or(&[])
    }

    /// Returns right channel data (falls back to left for mono).
    pub fn right(&self) -> &[f32] {
        if self.channels.len() > 1 {
            &self.channels[1]
        } else {
            self.left()
        }
    }

    /// Returns the memory usage in bytes.
    pub fn memory_bytes(&self) -> usize {
        self.channels.iter().map(|ch| ch.len() * 4).sum()
    }
}

/// BUG-024 FIX: Default memory limit — 2GB. Configurable per-project.
const DEFAULT_MEMORY_LIMIT_BYTES: usize = 2 * 1024 * 1024 * 1024;

/// Pool of pre-loaded audio data, keyed by source file path.
///
/// The pool uses `Arc<ClipAudio>` for zero-copy sharing:
/// - UI thread: calls `insert()` after loading audio
/// - Audio thread: calls `get()` for real-time playback
#[derive(Clone)]
pub struct ClipPool {
    /// Loaded audio data, keyed by source file path.
    entries: HashMap<String, Arc<ClipAudio>>,
    /// BUG-082 FIX: Running total of memory usage (bytes).
    running_memory_bytes: usize,
    /// BUG-024 FIX: Maximum allowed memory usage before rejecting new clips.
    memory_limit_bytes: usize,
}

impl ClipPool {
    /// Creates an empty pool with default 2GB memory limit.
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
            running_memory_bytes: 0,
            memory_limit_bytes: DEFAULT_MEMORY_LIMIT_BYTES,
        }
    }

    /// Inserts pre-loaded audio data into the pool.
    ///
    /// # BUG-024 FIX
    /// Returns `Err` if the insert would exceed the memory limit.
    pub fn insert(&mut self, audio: ClipAudio) -> Result<(), String> {
        let path = audio.source_path.clone();
        let bytes = audio.memory_bytes();
        let frames = audio.num_frames;

        // Remove old entry first to keep running total accurate
        if let Some(old) = self.entries.remove(&path) {
            self.running_memory_bytes = self.running_memory_bytes.saturating_sub(old.memory_bytes());
        }

        // Check memory limit
        if self.running_memory_bytes + bytes > self.memory_limit_bytes {
            return Err(format!(
                "ClipPool memory limit exceeded: {:.1}MB / {:.1}MB",
                self.running_memory_bytes as f64 / 1_048_576.0,
                self.memory_limit_bytes as f64 / 1_048_576.0,
            ));
        }

        log::info!(
            "ClipPool: loaded '{}' — {} frames, {:.1} MB",
            path,
            frames,
            bytes as f64 / (1024.0 * 1024.0),
        );

        self.running_memory_bytes += bytes;
        self.entries.insert(path, Arc::new(audio));
        Ok(())
    }

    /// Gets a reference to loaded audio data.
    ///
    /// Returns `None` if the source hasn't been loaded yet.
    pub fn get(&self, source_path: &str) -> Option<Arc<ClipAudio>> {
        self.entries.get(source_path).cloned()
    }

    /// Removes loaded audio data from the pool.
    pub fn remove(&mut self, source_path: &str) -> bool {
        if let Some(removed) = self.entries.remove(source_path) {
            self.running_memory_bytes = self.running_memory_bytes.saturating_sub(removed.memory_bytes());
            true
        } else {
            false
        }
    }

    /// Returns the number of loaded clips.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Returns whether the pool is empty.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Returns total memory usage in bytes.
    /// BUG-082 FIX: O(1) via running counter instead of O(n) linear scan.
    pub fn total_memory_bytes(&self) -> usize {
        self.running_memory_bytes
    }

    /// Returns the configured memory limit in bytes.
    pub fn memory_limit_bytes(&self) -> usize {
        self.memory_limit_bytes
    }

    /// Sets a new memory limit.
    pub fn set_memory_limit(&mut self, limit_bytes: usize) {
        self.memory_limit_bytes = limit_bytes;
    }

    /// Clears all loaded audio data.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.running_memory_bytes = 0;
    }

    /// Returns all loaded source paths.
    pub fn loaded_paths(&self) -> Vec<&str> {
        self.entries.keys().map(|k| k.as_str()).collect()
    }

    /// BUG-047 FIX: Evicts pool entries not referenced by any clip in the project.
    ///
    /// Call this after deleting clips/tracks to reclaim memory from orphaned audio data.
    /// Returns the number of entries evicted and bytes freed.
    pub fn evict_unreferenced(&mut self, referenced_paths: &std::collections::HashSet<String>) -> (usize, usize) {
        let before_count = self.entries.len();
        let mut freed_bytes = 0usize;

        self.entries.retain(|path, audio| {
            if referenced_paths.contains(path) {
                true
            } else {
                freed_bytes += audio.memory_bytes();
                log::info!("ClipPool: evicted '{}' — {:.1} MB freed", path, audio.memory_bytes() as f64 / 1_048_576.0);
                false
            }
        });

        self.running_memory_bytes = self.running_memory_bytes.saturating_sub(freed_bytes);
        let evicted = before_count - self.entries.len();
        (evicted, freed_bytes)
    }
}

impl Default for ClipPool {
    fn default() -> Self {
        Self::new()
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    fn make_audio(path: &str, frames: usize) -> ClipAudio {
        ClipAudio::new(
            path,
            vec![vec![0.0; frames], vec![0.0; frames]], // Stereo
            44100,
        )
    }

    #[test]
    fn pool_starts_empty() {
        let pool = ClipPool::new();
        assert!(pool.is_empty());
        assert_eq!(pool.len(), 0);
    }

    #[test]
    fn insert_and_get() {
        let mut pool = ClipPool::new();
        pool.insert(make_audio("test.wav", 44100)).unwrap();

        assert_eq!(pool.len(), 1);
        assert!(pool.get("test.wav").is_some());
        assert!(pool.get("missing.wav").is_none());
    }

    #[test]
    fn remove_entry() {
        let mut pool = ClipPool::new();
        pool.insert(make_audio("test.wav", 44100)).unwrap();

        assert!(pool.remove("test.wav"));
        assert!(pool.is_empty());
        assert!(!pool.remove("test.wav")); // Already removed
    }

    #[test]
    fn memory_tracking() {
        let mut pool = ClipPool::new();
        pool.insert(make_audio("a.wav", 44100)).unwrap();
        pool.insert(make_audio("b.wav", 44100)).unwrap();

        // 2 files × 2 channels × 44100 frames × 4 bytes
        let expected = 2 * 2 * 44100 * 4;
        assert_eq!(pool.total_memory_bytes(), expected);
    }

    #[test]
    fn clear_empties_pool() {
        let mut pool = ClipPool::new();
        pool.insert(make_audio("a.wav", 100)).unwrap();
        pool.insert(make_audio("b.wav", 100)).unwrap();
        pool.clear();

        assert!(pool.is_empty());
    }

    #[test]
    fn clip_audio_left_right() {
        let audio = make_audio("test.wav", 100);
        assert_eq!(audio.left().len(), 100);
        assert_eq!(audio.right().len(), 100);
    }

    #[test]
    fn mono_audio_right_falls_back_to_left() {
        let audio = ClipAudio::new("mono.wav", vec![vec![1.0; 100]], 44100);
        assert_eq!(audio.left().len(), 100);
        assert_eq!(audio.right().len(), 100); // Falls back to left
        assert!((audio.right()[0] - 1.0).abs() < 0.001);
    }

    #[test]
    fn arc_sharing() {
        let mut pool = ClipPool::new();
        pool.insert(make_audio("shared.wav", 100)).unwrap();

        let ref1 = pool.get("shared.wav").unwrap();
        let ref2 = pool.get("shared.wav").unwrap();

        // Both references should point to the same data
        assert!(Arc::ptr_eq(&ref1, &ref2));
    }
}
