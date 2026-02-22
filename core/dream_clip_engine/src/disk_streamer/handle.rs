use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::thread;

use crate::disk_streamer::io_thread::disk_io_thread;
use crate::disk_streamer::types::{LOOK_AHEAD_CHUNKS, StreamChunk, StreamingWindow};

/// Handle for the DiskIO background thread.
///
/// Manages the lifecycle of a background disk reading thread for a
/// single audio source. The thread pre-reads audio ahead of the
/// playhead and fills the `StreamingWindow` via lock-free ring buffer.
pub struct DiskStreamerHandle {
    /// Shared playhead position — written by the audio callback,
    /// read by the DiskIO thread to determine what to read next.
    pub playhead: Arc<AtomicI64>,

    /// Kill signal — set to `true` to stop the DiskIO thread.
    kill: Arc<AtomicBool>,

    /// Thread join handle.
    thread: Option<thread::JoinHandle<()>>,

    /// Consumer side of the chunk ring buffer.
    /// The audio callback drains this into the `StreamingWindow`.
    consumer: rtrb::Consumer<StreamChunk>,

    /// Source file path.
    pub source_path: String,

    /// Total frames in the source.
    pub total_frames: i64,

    /// Number of channels.
    pub num_channels: usize,

    /// Sample rate.
    pub sample_rate: u32,
}

impl DiskStreamerHandle {
    /// Spawns a new disk streaming thread for the given audio file.
    pub fn spawn(
        path: impl AsRef<Path>,
        sample_rate: u32,
        total_frames: i64,
        num_channels: usize,
    ) -> Result<Self, String> {
        let path = path.as_ref().to_path_buf();
        let source_path = path.to_string_lossy().to_string();

        let ring_size = LOOK_AHEAD_CHUNKS * 2;
        let (producer, consumer) = rtrb::RingBuffer::new(ring_size);

        let playhead = Arc::new(AtomicI64::new(0));
        let kill = Arc::new(AtomicBool::new(false));

        let playhead_clone = Arc::clone(&playhead);
        let kill_clone = Arc::clone(&kill);
        let path_for_thread = path.clone();
        let num_ch = num_channels;

        let thread = thread::Builder::new()
            .name(format!("disk-io:{}", source_path))
            .spawn(move || {
                disk_io_thread(
                    path_for_thread,
                    producer,
                    playhead_clone,
                    kill_clone,
                    sample_rate,
                    total_frames,
                    num_ch,
                );
            })
            .map_err(|e| format!("Failed to spawn DiskIO thread: {e}"))?;

        log::info!(
            "DiskStreamer: spawned for '{}' ({} frames, {}ch, {}Hz)",
            source_path,
            total_frames,
            num_channels,
            sample_rate
        );

        Ok(Self {
            playhead,
            kill,
            thread: Some(thread),
            consumer,
            source_path,
            total_frames,
            num_channels,
            sample_rate,
        })
    }

    /// Drains available chunks from the ring buffer into the streaming window.
    #[inline]
    pub fn drain_into(&mut self, window: &mut StreamingWindow) {
        while let Ok(chunk) = self.consumer.pop() {
            window.push_chunk(chunk);
        }
    }

    /// Updates the playhead position (called from the audio callback).
    #[inline]
    pub fn set_playhead(&self, position: i64) {
        self.playhead.store(position, Ordering::Release);
    }
}

impl Drop for DiskStreamerHandle {
    fn drop(&mut self) {
        self.kill.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let (tx, rx) = std::sync::mpsc::channel();
            let join_thread = std::thread::spawn(move || {
                let _ = thread.join();
                let _ = tx.send(());
            });
            match rx.recv_timeout(std::time::Duration::from_secs(2)) {
                Ok(()) => {}
                Err(_) => {
                    log::warn!(
                        "DiskStreamer: thread join timed out for '{}', detaching",
                        self.source_path
                    );
                    drop(join_thread);
                }
            }
        }
        log::info!("DiskStreamer: stopped for '{}'", self.source_path);
    }
}
