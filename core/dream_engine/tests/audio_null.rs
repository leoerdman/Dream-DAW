use std::path::Path;

use dream_clip_engine::pool::{ClipAudio, ClipPool};
use dream_engine::offline_bounce::{BounceConfig, OfflineRenderer};
use dream_models::project::{AudioClip, DeviceNode, PluginSlot, Project, Track, TrackType};
use dream_models::time::AbsoluteTime;

struct WavData {
    sample_rate: u32,
    channels: u16,
    samples: Vec<f32>,
}

fn read_wav_as_f32(path: &Path) -> Result<WavData, String> {
    let mut reader =
        hound::WavReader::open(path).map_err(|e| format!("open wav '{}': {e}", path.display()))?;
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

    Ok(WavData {
        sample_rate: spec.sample_rate,
        channels: spec.channels,
        samples: out,
    })
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

fn make_constant_stereo(frames: usize, amp: f32) -> Vec<Vec<f32>> {
    vec![vec![amp; frames], vec![amp; frames]]
}

fn avg_abs_stereo(samples: &[f32], channels: u16) -> f32 {
    if channels == 0 {
        return 0.0;
    }
    let ch = channels as usize;
    let mut sum = 0.0_f32;
    let mut count = 0usize;
    for frame in samples.chunks_exact(ch) {
        let l = frame[0].abs();
        let r = frame.get(1).copied().unwrap_or(frame[0]).abs();
        sum += (l + r) * 0.5;
        count += 1;
    }
    if count == 0 { 0.0 } else { sum / count as f32 }
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
    let candidate =
        std::env::var("DREAM_NULL_CANDIDATE_WAV").expect("DREAM_NULL_CANDIDATE_WAV is required");
    let golden = std::env::var("DREAM_NULL_GOLDEN_WAV").expect("DREAM_NULL_GOLDEN_WAV is required");

    let candidate_samples =
        read_wav_as_f32(Path::new(&candidate)).expect("candidate wav should be readable");
    let golden_samples =
        read_wav_as_f32(Path::new(&golden)).expect("golden wav should be readable");

    assert_eq!(
        candidate_samples.sample_rate, golden_samples.sample_rate,
        "candidate/golden sample_rate mismatch"
    );
    assert_eq!(
        candidate_samples.channels, golden_samples.channels,
        "candidate/golden channel count mismatch"
    );

    let residual_db = null_residual_rms_dbfs(&candidate_samples.samples, &golden_samples.samples)
        .expect("residual should compute");

    let threshold_db = std::env::var("DREAM_NULL_THRESHOLD_DB")
        .ok()
        .and_then(|s| s.parse::<f32>().ok())
        .unwrap_or(-90.0_f32);
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

    let bouncer_a = OfflineRenderer::new(mk_cfg(&out_a));
    let bouncer_b = OfflineRenderer::new(mk_cfg(&out_b));

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
    assert_eq!(a.sample_rate, b.sample_rate, "bounce sample_rate mismatch");
    assert_eq!(a.channels, b.channels, "bounce channel count mismatch");

    let residual_db =
        null_residual_rms_dbfs(&a.samples, &b.samples).expect("residual should compute");

    assert!(
        residual_db <= -110.0,
        "determinism null-test failed, residual={residual_db:.2} dBFS"
    );

    let _ = std::fs::remove_file(out_a);
    let _ = std::fs::remove_file(out_b);
}

#[test]
fn grouped_plus_direct_path_hits_master_fx_and_is_deterministic() {
    const SR: f64 = 44_100.0;
    const BPM: f64 = 174.0;
    const FRAMES: i64 = 8192;

    let mut project_base = Project::new("Group Master Null", BPM, SR);
    project_base.tracks.clear();

    let group = Track::with_type("Group", TrackType::Group, 0);
    let group_id = group.id;
    project_base.tracks.push(group);

    let mut grouped_src = Track::with_type("GroupedSrc", TrackType::Audio, 1);
    grouped_src.output_destination_id = Some(group_id);
    grouped_src.clips.push(AudioClip::new(
        "GroupedClip",
        "__null_group__/grouped.wav",
        AbsoluteTime::ZERO,
        AbsoluteTime::new(FRAMES),
    ));
    project_base.tracks.push(grouped_src);

    let mut direct_src = Track::with_type("DirectSrc", TrackType::Audio, 2);
    direct_src.clips.push(AudioClip::new(
        "DirectClip",
        "__null_group__/direct.wav",
        AbsoluteTime::ZERO,
        AbsoluteTime::new(FRAMES),
    ));
    project_base.tracks.push(direct_src);

    let mut project_with_master_fx = project_base.clone();
    let mut master_utility = PluginSlot::new("Utility", "internal://effect/utility");
    master_utility.params = Some(vec![-60.0]);
    project_with_master_fx
        .master_track
        .effects
        .push(DeviceNode::single(master_utility));

    let mut pool = ClipPool::new();
    pool.insert(ClipAudio::new(
        "__null_group__/grouped.wav",
        make_constant_stereo(FRAMES as usize, 0.5),
        SR as u32,
    ))
    .expect("insert grouped source");
    pool.insert(ClipAudio::new(
        "__null_group__/direct.wav",
        make_constant_stereo(FRAMES as usize, 0.5),
        SR as u32,
    ))
    .expect("insert direct source");

    let temp = std::env::temp_dir();
    let out_dry = temp.join("dream_null_group_master_dry.wav");
    let out_wet_a = temp.join("dream_null_group_master_wet_a.wav");
    let out_wet_b = temp.join("dream_null_group_master_wet_b.wav");

    let mk_cfg = |path: &Path| BounceConfig {
        output_path: path.to_string_lossy().to_string(),
        sample_rate: SR as u32,
        bit_depth: 32,
        start_frame: 0,
        end_frame: FRAMES,
        normalize: false,
        tail_frames: 0,
        format: "wav".to_string(),
        project_sample_rate: SR,
        bpm: BPM,
    };

    OfflineRenderer::new(mk_cfg(&out_dry))
        .bounce(
            &mut project_base,
            &mut pool,
            None,
            &std::collections::HashMap::new(),
            &[],
            |_| {},
        )
        .expect("dry bounce should succeed");

    OfflineRenderer::new(mk_cfg(&out_wet_a))
        .bounce(
            &mut project_with_master_fx.clone(),
            &mut pool,
            None,
            &std::collections::HashMap::new(),
            &[],
            |_| {},
        )
        .expect("wet bounce A should succeed");

    OfflineRenderer::new(mk_cfg(&out_wet_b))
        .bounce(
            &mut project_with_master_fx,
            &mut pool,
            None,
            &std::collections::HashMap::new(),
            &[],
            |_| {},
        )
        .expect("wet bounce B should succeed");

    let dry = read_wav_as_f32(&out_dry).expect("dry wav should be readable");
    let wet_a = read_wav_as_f32(&out_wet_a).expect("wet A wav should be readable");
    let wet_b = read_wav_as_f32(&out_wet_b).expect("wet B wav should be readable");

    let dry_avg = avg_abs_stereo(&dry.samples, dry.channels);
    let wet_avg = avg_abs_stereo(&wet_a.samples, wet_a.channels);
    assert!(
        wet_avg < dry_avg * 0.35,
        "master FX attenuation should affect group+direct sum: dry={dry_avg}, wet={wet_avg}"
    );

    let residual_db = null_residual_rms_dbfs(&wet_a.samples, &wet_b.samples)
        .expect("wet residual should compute");
    assert!(
        residual_db <= -110.0,
        "wet deterministic null-test failed, residual={residual_db:.2} dBFS"
    );

    let _ = std::fs::remove_file(out_dry);
    let _ = std::fs::remove_file(out_wet_a);
    let _ = std::fs::remove_file(out_wet_b);
}
