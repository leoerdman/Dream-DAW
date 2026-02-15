use std::fs::OpenOptions;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use memmap2::MmapMut;

pub const HEADER_MAGIC_OFFSET: usize = 0;
pub const HEADER_REQUESTED_FRAMES_OFFSET: usize = 4;
pub const HEADER_REQUEST_SEQ_OFFSET: usize = 8;
pub const HEADER_PROCESSED_SEQ_OFFSET: usize = 12;
pub const SHARED_AUDIO_MAGIC: u32 = 0x4452_4D44; // "DRMD"

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
        64
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

pub struct SharedAudioBufferRegion {
    pub path: PathBuf,
    pub layout: SharedAudioBufferLayout,
    mmap: MmapMut,
}

impl SharedAudioBufferRegion {
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

        let mmap = unsafe { MmapMut::map_mut(&file) }
            .map_err(|e| format!("mmap shared region '{}': {e}", path.display()))?;

        let mut region = Self { path, layout, mmap };
        region.set_magic(SHARED_AUDIO_MAGIC);
        region.set_requested_frames(0);
        region.set_request_seq(0);
        region.set_processed_seq(0);
        Ok(region)
    }

    pub fn open_existing(path: PathBuf, layout: SharedAudioBufferLayout) -> Result<Self, String> {
        if !path.exists() {
            return Err(format!("shared region not found: {}", path.display()));
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|e| format!("open shared region '{}': {e}", path.display()))?;
        let mmap = unsafe { MmapMut::map_mut(&file) }
            .map_err(|e| format!("mmap shared region '{}': {e}", path.display()))?;
        Ok(Self { path, layout, mmap })
    }

    pub fn write_output_channel(&mut self, output_index: usize, samples: &[f32]) -> Result<(), String> {
        if output_index >= self.layout.num_outputs as usize {
            return Err(format!("output channel out of range: {}", output_index));
        }
        if samples.len() > self.layout.max_frames as usize {
            return Err(format!(
                "too many frames for shared buffer: {} > {}",
                samples.len(),
                self.layout.max_frames
            ));
        }

        let base = self.layout.output_offset(output_index);
        let bytes: &[u8] = bytemuck::cast_slice(samples);
        let end = base + bytes.len();
        if end > self.mmap.len() {
            return Err("shared region overflow".to_string());
        }
        self.mmap[base..end].copy_from_slice(bytes);
        Ok(())
    }

    pub fn write_input_channel(&mut self, input_index: usize, samples: &[f32]) -> Result<(), String> {
        if input_index >= self.layout.num_inputs as usize {
            return Err(format!("input channel out of range: {}", input_index));
        }
        if samples.len() > self.layout.max_frames as usize {
            return Err(format!(
                "too many frames for shared buffer: {} > {}",
                samples.len(),
                self.layout.max_frames
            ));
        }
        let base = self.layout.header_bytes() + input_index * self.layout.channel_stride_bytes();
        let bytes: &[u8] = bytemuck::cast_slice(samples);
        let end = base + bytes.len();
        if end > self.mmap.len() {
            return Err("shared region overflow".to_string());
        }
        self.mmap[base..end].copy_from_slice(bytes);
        Ok(())
    }

    pub fn read_output_channel(
        &self,
        output_index: usize,
        num_frames: usize,
        out: &mut [f32],
    ) -> Result<(), String> {
        if output_index >= self.layout.num_outputs as usize {
            return Err(format!("output channel out of range: {}", output_index));
        }
        if num_frames > self.layout.max_frames as usize || num_frames > out.len() {
            return Err(format!(
                "requested frames out of bounds: requested={} max={} out_len={}",
                num_frames, self.layout.max_frames, out.len()
            ));
        }
        let base = self.layout.output_offset(output_index);
        let bytes_len = num_frames * std::mem::size_of::<f32>();
        let end = base + bytes_len;
        if end > self.mmap.len() {
            return Err("shared region overflow".to_string());
        }
        let src = &self.mmap[base..end];
        let src_f32: &[f32] = bytemuck::cast_slice(src);
        out[..num_frames].copy_from_slice(src_f32);
        Ok(())
    }

    pub fn region_pulse_byte(&self) -> u8 {
        self.mmap.first().copied().unwrap_or(0)
    }

    fn write_u32(&mut self, offset: usize, value: u32) {
        let bytes = value.to_le_bytes();
        if offset + 4 <= self.mmap.len() {
            self.mmap[offset..offset + 4].copy_from_slice(&bytes);
        }
    }

    fn read_u32(&self, offset: usize) -> u32 {
        if offset + 4 > self.mmap.len() {
            return 0;
        }
        let mut arr = [0u8; 4];
        arr.copy_from_slice(&self.mmap[offset..offset + 4]);
        u32::from_le_bytes(arr)
    }

    pub fn set_magic(&mut self, magic: u32) {
        self.write_u32(HEADER_MAGIC_OFFSET, magic);
    }

    pub fn magic(&self) -> u32 {
        self.read_u32(HEADER_MAGIC_OFFSET)
    }

    pub fn set_requested_frames(&mut self, frames: u32) {
        self.write_u32(HEADER_REQUESTED_FRAMES_OFFSET, frames);
    }

    pub fn requested_frames(&self) -> u32 {
        self.read_u32(HEADER_REQUESTED_FRAMES_OFFSET)
    }

    pub fn set_request_seq(&mut self, seq: u32) {
        self.write_u32(HEADER_REQUEST_SEQ_OFFSET, seq);
    }

    pub fn request_seq(&self) -> u32 {
        self.read_u32(HEADER_REQUEST_SEQ_OFFSET)
    }

    pub fn set_processed_seq(&mut self, seq: u32) {
        self.write_u32(HEADER_PROCESSED_SEQ_OFFSET, seq);
    }

    pub fn processed_seq(&self) -> u32 {
        self.read_u32(HEADER_PROCESSED_SEQ_OFFSET)
    }

    pub fn flush(&mut self) -> Result<(), String> {
        self.mmap.flush().map_err(|e| format!("flush shared mmap: {e}"))
    }

    pub fn path_ref(&self) -> &Path {
        &self.path
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
        let mut region = SharedAudioBufferRegion::create(path.clone(), layout.clone()).unwrap();
        region
            .write_output_channel(0, &[0.1, 0.2, 0.3, 0.4])
            .unwrap();
        region.flush().unwrap();
        drop(region);

        let reopened = SharedAudioBufferRegion::open_existing(path.clone(), layout).unwrap();
        assert!(reopened.mmap.len() >= 64);
        let _ = std::fs::remove_file(path);
    }
}
