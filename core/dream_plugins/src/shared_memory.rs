#![cfg_attr(test, allow(clippy::expect_used))]
// ═══════════════════════════════════════════════════════════════════════════
// Shared Audio Buffer — Cross-Process Zero-Copy Audio Transport
// ═══════════════════════════════════════════════════════════════════════════
//
// Memory layout (64-byte header + channel data):
//
// ┌───────────────────────────────────────────────────────────────────┐
// │  Offset   │  Size │  Field            │  Access Pattern          │
// ├───────────┼───────┼───────────────────┼──────────────────────────┤
// │  0..4     │  4B   │  magic (DRMD)     │  Write-once at creation  │
// │  4..8     │  4B   │  requested_frames │  Host writes, daemon reads│
// │  8..12    │  4B   │  request_seq      │  ATOMIC: Host→Daemon     │
// │  12..16   │  4B   │  processed_seq    │  ATOMIC: Daemon→Host     │
// │  16..20   │  4B   │  midi_event_count │  Host writes per block   │
// │  20..52   │  32B  │  midi_events[4]   │  Host writes per block   │
// │  52..64   │  12B  │  reserved/padding │  —                       │
// ├───────────┼───────┼───────────────────┼──────────────────────────┤
// │  64..     │  var  │  input channels   │  Host writes per block   │
// │  ...      │  var  │  output channels  │  Daemon writes per block │
// └───────────┴───────┴───────────────────┴──────────────────────────┘
//
// Synchronization protocol (seq-based, lock-free):
//   1. Host writes input samples → sets requested_frames → stores request_seq (Release)
//   2. Daemon spins on request_seq (Acquire) → processes → stores processed_seq (Release)
//   3. Host reads processed_seq (Acquire) → reads output samples
//
// SAFETY INVARIANTS:
//   - request_seq and processed_seq use AtomicU32 casts over mmap for tear-free cross-process access.
//   - Audio channel data is NOT atomically protected; correctness relies on the seq handshake:
//     the daemon only reads inputs AFTER observing a new request_seq, and the host only reads
//     outputs AFTER observing a matching processed_seq. This is the standard producer-consumer
//     pattern with a sequence number fence.
//   - The mmap file is exclusively created by the host; no third party truncates it.

use std::fs::OpenOptions;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use memmap2::MmapMut;

// ── Header field offsets ────────────────────────────────────────────────
pub const HEADER_MAGIC_OFFSET: usize = 0;
pub const HEADER_REQUESTED_FRAMES_OFFSET: usize = 4;
pub const HEADER_REQUEST_SEQ_OFFSET: usize = 8;
pub const HEADER_PROCESSED_SEQ_OFFSET: usize = 12;
pub const HEADER_MIDI_COUNT_OFFSET: usize = 16;
pub const HEADER_MIDI_DATA_OFFSET: usize = 20;
pub const HEADER_TOTAL_BYTES: usize = 64;

/// Maximum number of MIDI events that fit in the shared header.
/// Each event = 8 bytes: (i32 sample_offset, u8 channel, [u8; 3] data).
pub const MAX_INLINE_MIDI_EVENTS: usize = 4;
pub const MIDI_EVENT_STRIDE: usize = 8;

pub const SHARED_AUDIO_MAGIC: u32 = 0x4452_4D44; // "DRMD"

/// Compact MIDI event for shared-memory transport (8 bytes, no heap).
#[derive(Debug, Clone, Copy, Default, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C)]
pub struct InlineMidiEvent {
    pub sample_offset: i32,
    pub channel: u8,
    pub data: [u8; 3],
}

// ── Layout ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SharedAudioBufferLayout {
    pub num_inputs: u16,
    pub num_outputs: u16,
    pub max_frames: u32,
}

impl SharedAudioBufferLayout {
    pub fn channel_stride_bytes(&self) -> usize {
        self.max_frames as usize * std::mem::size_of::<f32>()
    }

    pub fn header_bytes(&self) -> usize {
        HEADER_TOTAL_BYTES
    }

    pub fn total_bytes(&self) -> usize {
        self.header_bytes()
            + (self.num_inputs as usize + self.num_outputs as usize) * self.channel_stride_bytes()
    }

    pub fn output_offset(&self, output_index: usize) -> usize {
        self.header_bytes()
            + (self.num_inputs as usize + output_index) * self.channel_stride_bytes()
    }
}

// ── Region ──────────────────────────────────────────────────────────────

pub struct SharedAudioBufferRegion {
    pub path: PathBuf,
    pub layout: SharedAudioBufferLayout,
    mmap: MmapMut,
    pub is_owner: bool,
}

impl SharedAudioBufferRegion {
    /// Creates a new shared region file and maps it into memory.
    pub fn create(path: PathBuf, layout: SharedAudioBufferLayout) -> Result<Self, String> {
        let total_bytes = layout.total_bytes();
        if total_bytes == 0 {
            return Err("invalid shared audio region size".to_string());
        }

        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|e| format!("open shared region '{}': {e}", path.display()))?;
        file.seek(SeekFrom::Start(total_bytes as u64 - 1))
            .and_then(|_| file.write_all(&[0]))
            .map_err(|e| format!("resize shared region '{}': {e}", path.display()))?;

        // SAFETY: MmapMut::map_mut is unsafe because the file could be truncated externally.
        // We exclusively own this tempfile. Cross-process aliasing is synchronized via the
        // atomic seq-counter handshake (see module-level docs).
        let mmap = unsafe { MmapMut::map_mut(&file) }
            .map_err(|e| format!("mmap shared region '{}': {e}", path.display()))?;

        let mut region = Self {
            path,
            layout,
            mmap,
            is_owner: true,
        };
        region.write_u32_raw(HEADER_MAGIC_OFFSET, SHARED_AUDIO_MAGIC);
        region.write_u32_raw(HEADER_REQUESTED_FRAMES_OFFSET, 0);
        region.write_u32_raw(HEADER_MIDI_COUNT_OFFSET, 0);
        // Initialize atomic counters via store_release to ensure visibility.
        region.set_request_seq(0);
        region.set_processed_seq(0);
        Ok(region)
    }

    /// Opens an existing shared region file.
    pub fn open_existing(path: PathBuf, layout: SharedAudioBufferLayout) -> Result<Self, String> {
        if !path.exists() {
            return Err(format!("shared region not found: {}", path.display()));
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|e| format!("open shared region '{}': {e}", path.display()))?;
        // SAFETY: Same invariant — file is exclusively managed by Dream DAW processes.
        let mmap = unsafe { MmapMut::map_mut(&file) }
            .map_err(|e| format!("mmap shared region '{}': {e}", path.display()))?;
        Ok(Self {
            path,
            layout,
            mmap,
            is_owner: false,
        })
    }

    // ── Audio Channel I/O ───────────────────────────────────────────────

    pub fn write_output_channel(
        &mut self,
        output_index: usize,
        samples: &[f32],
    ) -> Result<(), &'static str> {
        if output_index >= self.layout.num_outputs as usize {
            return Err("output channel out of range");
        }
        if samples.len() > self.layout.max_frames as usize {
            return Err("too many frames for shared buffer");
        }
        let base = self.layout.output_offset(output_index);
        let bytes: &[u8] = bytemuck::cast_slice(samples);
        let end = base + bytes.len();
        if end > self.mmap.len() {
            return Err("shared region overflow");
        }
        self.mmap[base..end].copy_from_slice(bytes);
        Ok(())
    }

    pub fn write_input_channel(
        &mut self,
        input_index: usize,
        samples: &[f32],
    ) -> Result<(), &'static str> {
        if input_index >= self.layout.num_inputs as usize {
            return Err("input channel out of range");
        }
        if samples.len() > self.layout.max_frames as usize {
            return Err("too many frames for shared buffer");
        }
        let base = self.layout.header_bytes() + input_index * self.layout.channel_stride_bytes();
        let bytes: &[u8] = bytemuck::cast_slice(samples);
        let end = base + bytes.len();
        if end > self.mmap.len() {
            return Err("shared region overflow");
        }
        self.mmap[base..end].copy_from_slice(bytes);
        Ok(())
    }

    pub fn read_output_channel(
        &self,
        output_index: usize,
        num_frames: usize,
        out: &mut [f32],
    ) -> Result<(), &'static str> {
        if output_index >= self.layout.num_outputs as usize {
            return Err("output channel out of range");
        }
        if num_frames > self.layout.max_frames as usize || num_frames > out.len() {
            return Err("requested frames out of bounds");
        }
        let base = self.layout.output_offset(output_index);
        let bytes_len = num_frames * std::mem::size_of::<f32>();
        let end = base + bytes_len;
        if end > self.mmap.len() {
            return Err("shared region overflow");
        }
        let src = &self.mmap[base..end];
        let src_f32: &[f32] = bytemuck::cast_slice(src);
        out[..num_frames].copy_from_slice(src_f32);
        Ok(())
    }

    /// Reads an input channel from the shared region. Used by the daemon
    /// to read host-written input samples for plugin processing.
    pub fn read_input_channel(
        &self,
        input_index: usize,
        num_frames: usize,
        out: &mut [f32],
    ) -> Result<(), &'static str> {
        if input_index >= self.layout.num_inputs as usize {
            return Err("input channel out of range");
        }
        if num_frames > self.layout.max_frames as usize || num_frames > out.len() {
            return Err("requested frames out of bounds");
        }
        let base = self.layout.header_bytes() + input_index * self.layout.channel_stride_bytes();
        let bytes_len = num_frames * std::mem::size_of::<f32>();
        let end = base + bytes_len;
        if end > self.mmap.len() {
            return Err("shared region overflow");
        }
        let src = &self.mmap[base..end];
        let src_f32: &[f32] = bytemuck::cast_slice(src);
        out[..num_frames].copy_from_slice(src_f32);
        Ok(())
    }

    // ── Inline MIDI Events (zero-allocation RT-safe) ────────────────────

    /// Writes MIDI events into the shared header. Truncates at MAX_INLINE_MIDI_EVENTS.
    /// Returns the number of events actually written.
    pub fn write_midi_events(&mut self, events: &[InlineMidiEvent]) -> usize {
        let count = events.len().min(MAX_INLINE_MIDI_EVENTS);
        self.write_u32_raw(
            HEADER_MIDI_COUNT_OFFSET,
            u32::try_from(count).unwrap_or(u32::MAX),
        );
        let bytes: &[u8] = bytemuck::cast_slice(&events[..count]);
        let end = HEADER_MIDI_DATA_OFFSET + bytes.len();
        if end <= self.mmap.len() {
            self.mmap[HEADER_MIDI_DATA_OFFSET..end].copy_from_slice(bytes);
        }
        count
    }

    /// Reads MIDI events from the shared header. Zero-allocation.
    pub fn read_midi_events(&self) -> &[InlineMidiEvent] {
        let count = self.read_u32_raw(HEADER_MIDI_COUNT_OFFSET) as usize;
        let count = count.min(MAX_INLINE_MIDI_EVENTS);
        if count == 0 {
            return &[];
        }
        let bytes_len = count * MIDI_EVENT_STRIDE;
        let end = HEADER_MIDI_DATA_OFFSET + bytes_len;
        if end > self.mmap.len() {
            return &[];
        }
        bytemuck::cast_slice(&self.mmap[HEADER_MIDI_DATA_OFFSET..end])
    }

    /// Clears the MIDI event count (call after daemon has consumed events).
    pub fn clear_midi_events(&mut self) {
        self.write_u32_raw(HEADER_MIDI_COUNT_OFFSET, 0);
    }

    // ── Atomic Sequence Counters (cross-process safe) ───────────────────
    //
    // These use AtomicU32 pointer casts over the mmap region. This is safe because:
    // 1. The mmap is page-aligned (OS guarantee), so any 4-byte-aligned offset is naturally aligned.
    // 2. AtomicU32 has the same size/alignment as u32 on all platforms we target (x86_64, aarch64).
    // 3. Atomics over mmap are well-defined on macOS/Linux for cross-process synchronization.

    /// Atomically stores the request sequence number with Release ordering.
    /// Called by the HOST after writing input samples.
    pub fn set_request_seq(&mut self, seq: u32) {
        // SAFETY: HEADER_REQUEST_SEQ_OFFSET (8) is 4-byte aligned within the mmap.
        // AtomicU32 and u32 have identical layout. The mmap pointer is valid and page-aligned.
        unsafe {
            let ptr = self.mmap.as_mut_ptr().add(HEADER_REQUEST_SEQ_OFFSET) as *const AtomicU32;
            (*ptr).store(seq, Ordering::Release);
        }
    }

    /// Atomically loads the request sequence number with Acquire ordering.
    /// Called by the DAEMON to detect new work.
    pub fn request_seq(&self) -> u32 {
        if HEADER_REQUEST_SEQ_OFFSET + 4 > self.mmap.len() {
            return 0;
        }
        // SAFETY: Same alignment proof as set_request_seq.
        unsafe {
            let ptr = self.mmap.as_ptr().add(HEADER_REQUEST_SEQ_OFFSET) as *const AtomicU32;
            (*ptr).load(Ordering::Acquire)
        }
    }

    /// Atomically stores the processed sequence number with Release ordering.
    /// Called by the DAEMON after writing output samples.
    pub fn set_processed_seq(&mut self, seq: u32) {
        // SAFETY: HEADER_PROCESSED_SEQ_OFFSET (12) is 4-byte aligned within the mmap.
        unsafe {
            let ptr = self.mmap.as_mut_ptr().add(HEADER_PROCESSED_SEQ_OFFSET) as *const AtomicU32;
            (*ptr).store(seq, Ordering::Release);
        }
    }

    /// Atomically loads the processed sequence number with Acquire ordering.
    /// Called by the HOST to detect completed work.
    pub fn processed_seq(&self) -> u32 {
        if HEADER_PROCESSED_SEQ_OFFSET + 4 > self.mmap.len() {
            return 0;
        }
        // SAFETY: Same alignment proof as set_processed_seq.
        unsafe {
            let ptr = self.mmap.as_ptr().add(HEADER_PROCESSED_SEQ_OFFSET) as *const AtomicU32;
            (*ptr).load(Ordering::Acquire)
        }
    }

    // ── Non-Atomic Header Fields ────────────────────────────────────────

    pub fn set_magic(&mut self, magic: u32) {
        self.write_u32_raw(HEADER_MAGIC_OFFSET, magic);
    }

    pub fn magic(&self) -> u32 {
        self.read_u32_raw(HEADER_MAGIC_OFFSET)
    }

    pub fn set_requested_frames(&mut self, frames: u32) {
        self.write_u32_raw(HEADER_REQUESTED_FRAMES_OFFSET, frames);
    }

    pub fn requested_frames(&self) -> u32 {
        self.read_u32_raw(HEADER_REQUESTED_FRAMES_OFFSET)
    }

    pub fn region_pulse_byte(&self) -> u8 {
        self.mmap.first().copied().unwrap_or(0)
    }

    pub fn flush(&mut self) -> Result<(), String> {
        self.mmap
            .flush()
            .map_err(|e| format!("flush shared mmap: {e}"))
    }

    pub fn path_ref(&self) -> &Path {
        &self.path
    }

    // ── Internal Helpers ────────────────────────────────────────────────

    fn write_u32_raw(&mut self, offset: usize, value: u32) {
        let bytes = value.to_le_bytes();
        if offset + 4 <= self.mmap.len() {
            self.mmap[offset..offset + 4].copy_from_slice(&bytes);
        }
    }

    fn read_u32_raw(&self, offset: usize) -> u32 {
        if offset + 4 > self.mmap.len() {
            return 0;
        }
        let mut arr = [0u8; 4];
        arr.copy_from_slice(&self.mmap[offset..offset + 4]);
        u32::from_le_bytes(arr)
    }
}

impl Drop for SharedAudioBufferRegion {
    fn drop(&mut self) {
        if self.is_owner {
            // Unlink the shared memory file to prevent `/tmp` leaks.
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_region_create_and_write() {
        let path = std::env::temp_dir().join(format!(
            "dream_daw_test_shared_region_{}.bin",
            uuid::Uuid::new_v4()
        ));
        let layout = SharedAudioBufferLayout {
            num_inputs: 2,
            num_outputs: 2,
            max_frames: 256,
        };
        let mut region = SharedAudioBufferRegion::create(path.clone(), layout.clone())
            .expect("test invariant: unwrap removed for clippy policy");
        region
            .write_output_channel(0, &[0.1, 0.2, 0.3, 0.4])
            .expect("test invariant: unwrap removed for clippy policy");
        region
            .flush()
            .expect("test invariant: unwrap removed for clippy policy");
        // Prevent Drop from deleting the file before open_existing below.
        region.is_owner = false;
        drop(region);

        let reopened = SharedAudioBufferRegion::open_existing(path.clone(), layout)
            .expect("test invariant: unwrap removed for clippy policy");
        assert!(reopened.mmap.len() >= 64);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn atomic_seq_roundtrip() {
        let path = std::env::temp_dir().join(format!(
            "dream_daw_test_atomic_seq_{}.bin",
            uuid::Uuid::new_v4()
        ));
        let layout = SharedAudioBufferLayout {
            num_inputs: 2,
            num_outputs: 2,
            max_frames: 256,
        };
        let mut region = SharedAudioBufferRegion::create(path.clone(), layout)
            .expect("test invariant: unwrap removed for clippy policy");

        // Initial state
        assert_eq!(region.request_seq(), 0);
        assert_eq!(region.processed_seq(), 0);

        // Simulate host writing seq
        region.set_request_seq(42);
        assert_eq!(region.request_seq(), 42);

        // Simulate daemon writing processed seq
        region.set_processed_seq(42);
        assert_eq!(region.processed_seq(), 42);

        // Wrapping behavior
        region.set_request_seq(u32::MAX);
        assert_eq!(region.request_seq(), u32::MAX);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn inline_midi_roundtrip() {
        let path =
            std::env::temp_dir().join(format!("dream_daw_test_midi_{}.bin", uuid::Uuid::new_v4()));
        let layout = SharedAudioBufferLayout {
            num_inputs: 2,
            num_outputs: 2,
            max_frames: 256,
        };
        let mut region = SharedAudioBufferRegion::create(path.clone(), layout)
            .expect("test invariant: unwrap removed for clippy policy");

        let events = [
            InlineMidiEvent {
                sample_offset: 0,
                channel: 0,
                data: [0x90, 60, 100], // Note On C4
            },
            InlineMidiEvent {
                sample_offset: 128,
                channel: 0,
                data: [0x80, 60, 0], // Note Off C4
            },
        ];

        let written = region.write_midi_events(&events);
        assert_eq!(written, 2);

        let read = region.read_midi_events();
        assert_eq!(read.len(), 2);
        assert_eq!(read[0].data, [0x90, 60, 100]);
        assert_eq!(read[1].sample_offset, 128);

        region.clear_midi_events();
        assert_eq!(region.read_midi_events().len(), 0);

        let _ = std::fs::remove_file(path);
    }
}
