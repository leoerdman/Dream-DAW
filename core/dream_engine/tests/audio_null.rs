use std::path::Path;

use dream_clip_engine::pool::ClipPool;
use dream_engine::offline_bounce::{BounceConfig, OfflineBouncer};
use dream_models::project::{AudioClip, Project, Track, TrackType};
use dream_models::time::AbsoluteTime;

fn read_wav_as_f32(path: &Path) -> Result<Vec<f32>, String> {
    let mut reader = hound::WavReader::open(path)
        .map_err(|e| format!("open wav '{}': {e}", path.display()))?;
    let spec = reader.spec();

    if spec.channels == 0 {
        return Err(format!("wav '{}' has zero channels", path.display()));
    }

    let mut out = Vec::new();
    match (spec.sample_format, spec.bits_per_sample) {
        (hound::SampleFormat::Float, 32) => {
            for s in reader.samples::<f32>() {
                out.push(s.map_err(|e| format!("read f32 sample: {e}"))?);
            }
        }
        (hound::SampleFormat::Int, 16) => {
            let denom = i16::MAX as f32;
            for s in reader.samples::<i16>() {
                out.push((s.map_err(|e| format!("read i16 sample: {e}"))? as f32) / denom);
            }
        }
        (hound::SampleFormat::Int, 24) => {
            // hound reads 24-bit PCM into i32 with valid top 24 bits.
            let denom = ((1_i32 << 23) - 1) as f32;
            for s in reader.samples::<i32>() {
                out.push((s.map_err(|e| format!("read i24 sample: {e}"))? as f32) / denom);
            }
        }
        (hound::SampleFormat::Int, 32) => {
            let denom = i32::MAX as f32;
            for s in reader.samples::<i32>() {
                out.push((s.map_err(|e| format!("read i32 sample: {e}"))? as f32) / denom);
            }
        }
        _ => {
            return Err(format!(
                "unsupported wav format '{}': {:?} {}-bit",
                path.display(),
                spec.sample_format,
                spec.bits_per_sample
            ));
        }
    }

    Ok(out)
}

fn make_silent_project() -> Project {
    let mut project = Project::new("Null Test Project", 120.0, 44100.0);
    let mut track = Track::new("Null Track");
    track.track_type = TrackType::Audio;
    // A dummy unresolved clip path yields deterministic silence in bounce path.
    track.clips.push(AudioClip::new(
        "Null Clip",
        "__null_test__/silence.wav",
        AbsoluteTime::new(0),
        AbsoluteTime::new(4096),
    ));
    project.tracks.push(track);
    project
}

fn null_residual_rms_dbfs(candidate: &[f32], golden: &[f32]) -> Result<f32, String> {
    if candidate.len() != golden.len() {
        return Err(format!(
            "length mismatch: candidate={} golden={}",
            candidate.len(),
            golden.len()
        ));
    }
    if candidate.is_empty() {
        return Ok(-120.0);
    }

    let mut sum_sq = 0.0_f64;
    for i in 0..candidate.len() {
        // Null test: add candidate + (-golden)
        let r = candidate[i] as f64 - golden[i] as f64;
        sum_sq += r * r;
    }

    let rms = (sum_sq / candidate.len() as f64).sqrt() as f32;
    if rms <= 1.0e-12 {
        return Ok(-120.0);
    }

    Ok(20.0 * rms.log10())
}

#[test]
fn null_math_is_zero_for_identical_buffers() {
    let a = vec![0.0_f32, 0.1, -0.2, 0.3, -0.4, 0.5];
    let db = null_residual_rms_dbfs(&a, &a).expect("null residual should compute");
    assert!(db <= -110.0, "expected near -inf, got {db:.2} dBFS");
}

#[test]
fn null_math_detects_a_difference() {
    let a = vec![0.0_f32, 0.1, -0.2, 0.3, -0.4, 0.5];
    let mut b = a.clone();
    b[3] += 0.01;
    let db = null_residual_rms_dbfs(&a, &b).expect("null residual should compute");
    assert!(db > -100.0, "expected non-zero residual, got {db:.2} dBFS");
}

/// Infrastructure test for golden-reference null workflow.
///
/// Usage:
///   DREAM_NULL_CANDIDATE_WAV=/abs/path/test_out.wav \
///   DREAM_NULL_GOLDEN_WAV=/abs/path/golden_reference.wav \
///   cargo test -p dream_engine audio_null_against_golden_reference -- --ignored --nocapture
#[test]
#[ignore = "requires external WAV fixtures"]
fn audio_null_against_golden_reference() {
    let candidate = std::env::var("DREAM_NULL_CANDIDATE_WAV")
        .expect("DREAM_NULL_CANDIDATE_WAV is required");
    let golden = std::env::var("DREAM_NULL_GOLDEN_WAV")
        .expect("DREAM_NULL_GOLDEN_WAV is required");

    let candidate_samples = read_wav_as_f32(Path::new(&candidate))
        .expect("candidate wav should be readable");
    let golden_samples = read_wav_as_f32(Path::new(&golden))
        .expect("golden wav should be readable");

    let residual_db = null_residual_rms_dbfs(&candidate_samples, &golden_samples)
        .expect("residual should compute");

    // Practical threshold for deterministic offline bounce pipelines.
    // Tighten to -120 dBFS when render path is fully bit-stable across platforms.
    let threshold_db = -90.0_f32;
    assert!(
        residual_db <= threshold_db,
        "null-test failed: residual={residual_db:.2} dBFS, threshold={threshold_db:.2} dBFS"
    );
}

#[test]
fn offline_bounce_is_deterministic_for_silent_project() {
    let temp = std::env::temp_dir();
    let out_a = temp.join("dream_null_deterministic_a.wav");
    let out_b = temp.join("dream_null_deterministic_b.wav");

    let mk_cfg = |path: &Path| BounceConfig {
        output_path: path.to_string_lossy().to_string(),
        sample_rate: 44100,
        bit_depth: 32,
        start_frame: 0,
        end_frame: 4096,
        normalize: false,
        tail_frames: 0,
        format: "wav".to_string(),
        project_sample_rate: 44100.0,
        bpm: 120.0,
    };

    let mut pool = ClipPool::new();
    let mut project_a = make_silent_project();
    let mut project_b = make_silent_project();

    let bouncer_a = OfflineBouncer::new(mk_cfg(&out_a));
    let bouncer_b = OfflineBouncer::new(mk_cfg(&out_b));

    bouncer_a
        .bounce(
            &mut project_a,
            &mut pool,
            None,
            &std::collections::HashMap::new(),
            &[],
            |_| {},
        )
        .expect("first bounce should succeed");

    bouncer_b
        .bounce(
            &mut project_b,
            &mut pool,
            None,
            &std::collections::HashMap::new(),
            &[],
            |_| {},
        )
        .expect("second bounce should succeed");

    let a = read_wav_as_f32(&out_a).expect("bounce A should be readable");
    let b = read_wav_as_f32(&out_b).expect("bounce B should be readable");
    let residual_db = null_residual_rms_dbfs(&a, &b).expect("residual should compute");

    assert!(
        residual_db <= -110.0,
        "determinism null-test failed, residual={residual_db:.2} dBFS"
    );

    let _ = std::fs::remove_file(out_a);
    let _ = std::fs::remove_file(out_b);
}
