// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Audio File I/O & Project Serialization
// ═══════════════════════════════════════════════════════════════════════════
//
// This crate handles all file I/O for the DAW:
//   - Audio file decoding (WAV, FLAC, OGG, MP3, AIFF via symphonia)
//   - Waveform peak cache generation for the WebGPU renderer
//   - WAV export via hound
//   - Project file serialization (JSON + compressed binary)
//
// All decoding is NON-REAL-TIME — results are passed to the audio
// thread via lock-free queues (see dream_engine).
//
// ═══════════════════════════════════════════════════════════════════════════

pub mod audio_reader;
pub mod mp3_writer;
pub mod peak_cache;
pub mod project_file;
pub mod project_manager;
pub mod wav_writer;

pub use audio_reader::{AudioBuffer, AudioReader};
pub use mp3_writer::Mp3Writer;
pub use peak_cache::PeakCache;
pub use project_file::ProjectFile;
pub use project_manager::ProjectManager;
pub use wav_writer::WavWriter;
