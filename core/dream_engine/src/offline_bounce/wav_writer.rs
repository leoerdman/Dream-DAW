use crate::offline_bounce_types::BounceError;
use dream_dsp::dither::TpdfDitherer;

pub struct WavWriter {
    writer: hound::WavWriter<std::io::BufWriter<std::fs::File>>,
    is_float: bool,
    bit_depth: u16,
    scaler: f32,
    ditherer: TpdfDitherer,
}

impl WavWriter {
    pub fn create(
        output_path: &str,
        sample_rate: u32,
        bit_depth: u16,
    ) -> Result<Self, BounceError> {
        let is_float = bit_depth == 32;
        let sample_format = if is_float {
            hound::SampleFormat::Float
        } else {
            hound::SampleFormat::Int
        };

        let spec = hound::WavSpec {
            channels: 2,
            sample_rate,
            bits_per_sample: bit_depth,
            sample_format,
        };

        let writer = hound::WavWriter::create(output_path, spec)
            .map_err(|e| BounceError::WriteError(e.to_string()))?;

        let scaler = if bit_depth == 16 {
            32767.0
        } else if bit_depth == 24 {
            8388607.0
        } else {
            1.0
        };

        Ok(Self {
            writer,
            is_float,
            bit_depth,
            scaler,
            ditherer: TpdfDitherer::new(),
        })
    }

    pub fn write_chunk(&mut self, final_l: &[f32], final_r: &[f32]) -> Result<(), BounceError> {
        let frames = final_l.len();
        for i in 0..frames {
            self.write_sample(final_l[i])?;
            self.write_sample(final_r[i])?;
        }
        Ok(())
    }

    fn write_sample(&mut self, s: f32) -> Result<(), BounceError> {
        if self.is_float {
            self.writer
                .write_sample(s)
                .map_err(|e| BounceError::WriteError(e.to_string()))?;
        } else if self.bit_depth == 16 {
            let dithered = s * self.scaler + self.ditherer.next_tpdf();
            let scaled = dithered.round().clamp(-32768.0, 32767.0) as i16;
            self.writer
                .write_sample(scaled)
                .map_err(|e| BounceError::WriteError(e.to_string()))?;
        } else {
            let dithered = s * self.scaler + self.ditherer.next_tpdf();
            let scaled = dithered.round().clamp(-8388608.0, 8388607.0) as i32;
            self.writer
                .write_sample(scaled)
                .map_err(|e| BounceError::WriteError(e.to_string()))?;
        }
        Ok(())
    }

    pub fn finalize(self) -> Result<(), BounceError> {
        self.writer
            .finalize()
            .map_err(|e| BounceError::WriteError(e.to_string()))
    }
}
