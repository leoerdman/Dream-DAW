// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Disk Streaming Engine (OOM Prevention)
// ═══════════════════════════════════════════════════════════════════════════

mod handle;
mod io_thread;
mod types;

pub use handle::DiskStreamerHandle;
pub use types::{
    CHUNK_FRAMES, LOOK_AHEAD_CHUNKS, RAM_THRESHOLD_BYTES, StreamChunk, StreamingWindow,
    should_stream,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streaming_window_push_and_read() {
        let mut window = StreamingWindow::new("test.wav", 100000, 2, 48000);

        let chunk = StreamChunk {
            left: vec![0.5; CHUNK_FRAMES],
            right: vec![-0.3; CHUNK_FRAMES],
            start_frame: 0,
            num_frames: CHUNK_FRAMES,
        };
        window.push_chunk(chunk);

        let mut out_l = vec![0.0; 256];
        let mut out_r = vec![0.0; 256];
        let hit = window.read_into(0, 256, &mut out_l, &mut out_r, 0, 1.0);

        assert!(hit);
        assert!(out_l[128].abs() > 0.3);
        assert!(out_r[128].abs() > 0.2);
    }

    #[test]
    fn streaming_window_sorted_insert() {
        let mut window = StreamingWindow::new("test.wav", 100000, 2, 48000);

        window.push_chunk(StreamChunk {
            left: vec![0.2; 100],
            right: vec![0.2; 100],
            start_frame: 200,
            num_frames: 100,
        });
        window.push_chunk(StreamChunk {
            left: vec![0.5; 100],
            right: vec![0.5; 100],
            start_frame: 0,
            num_frames: 100,
        });
        window.push_chunk(StreamChunk {
            left: vec![0.3; 100],
            right: vec![0.3; 100],
            start_frame: 100,
            num_frames: 100,
        });

        let range = window.buffered_range().unwrap();
        assert_eq!(range.0, 0);
        assert_eq!(range.1, 300);
    }

    #[test]
    fn streaming_window_eviction() {
        let mut window = StreamingWindow::new("test.wav", 1000000, 2, 48000);

        for i in 0..LOOK_AHEAD_CHUNKS * 3 {
            window.push_chunk(StreamChunk {
                left: vec![0.1; CHUNK_FRAMES],
                right: vec![0.1; CHUNK_FRAMES],
                start_frame: (i * CHUNK_FRAMES) as i64,
                num_frames: CHUNK_FRAMES,
            });
        }

        let big_playhead = (LOOK_AHEAD_CHUNKS * 2 * CHUNK_FRAMES) as i64;
        window.evict_behind(big_playhead);

        let range = window.buffered_range().unwrap();
        assert!(range.0 > 0);
    }

    #[test]
    fn should_stream_small_file() {
        assert!(!should_stream("/nonexistent/file.wav"));
    }

    #[test]
    fn empty_window_returns_false() {
        let window = StreamingWindow::new("test.wav", 100000, 2, 48000);
        let mut out_l = vec![0.0; 256];
        let mut out_r = vec![0.0; 256];
        let hit = window.read_into(0, 256, &mut out_l, &mut out_r, 0, 1.0);
        assert!(!hit);
    }
}
