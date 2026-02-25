use super::*;
use dream_models::project::{DeviceNode, PluginSlot, Project, Track, TrackType};
use uuid::Uuid;

fn unique_temp_audio_path(prefix: &str, ext: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("{prefix}_{}.{}", Uuid::new_v4().simple(), ext))
}

fn make_test_project() -> Project {
    use dream_models::time::AbsoluteTime;
    let mut project = Project::default();
    let mut track = Track::new("Test Track");
    track.track_type = TrackType::Audio;
    // Add a dummy clip so the project isn't considered empty.
    // The clip references a non-existent file, producing silence.
    track.clips.push(AudioClip::new(
        "Dummy Clip",
        "__test_dummy__/silence.wav",
        AbsoluteTime::new(0),
        AbsoluteTime::new(4096),
    ));
    project.tracks.push(track);
    project
}

fn make_external_vst_midi_project() -> Project {
    use dream_models::midi::{MidiClip, MidiNote};
    use dream_models::time::AbsoluteTime;

    let mut project = Project::default();
    let mut track = Track::new("VST MIDI Track");
    track.track_type = TrackType::Midi;

    let mut clip = MidiClip::new("MIDI", AbsoluteTime::new(0), AbsoluteTime::new(4096));
    clip.add_note(MidiNote::new(60, 100, 0, 1024));
    track.midi_clips.push(clip);

    // External (non-internal) instrument declaration.
    let vst_instrument = PluginSlot::new("External Instrument", "/Library/Plugins/Test.vst3");
    track.instrument = Some(DeviceNode::single(vst_instrument));

    project.tracks.push(track);
    project
}

fn make_external_vst_fx_project_on_track() -> Project {
    use dream_models::time::AbsoluteTime;

    let mut project = Project::default();
    let mut track = Track::new("Audio Track");
    track.track_type = TrackType::Audio;
    track.clips.push(AudioClip::new(
        "Audio",
        "__test_dummy__/silence.wav",
        AbsoluteTime::new(0),
        AbsoluteTime::new(4096),
    ));
    let ext_fx = PluginSlot::new("External FX", "/Library/Plugins/TestFx.vst3");
    track.effects.push(DeviceNode::single(ext_fx));
    project.tracks.push(track);
    project
}

fn make_external_vst_fx_project_on_master() -> Project {
    use dream_models::time::AbsoluteTime;

    let mut project = Project::default();
    let mut track = Track::new("Audio Track");
    track.track_type = TrackType::Audio;
    track.clips.push(AudioClip::new(
        "Audio",
        "__test_dummy__/silence.wav",
        AbsoluteTime::new(0),
        AbsoluteTime::new(4096),
    ));
    project.tracks.push(track);

    let ext_master_fx = PluginSlot::new("External Master FX", "/Library/Plugins/TestMasterFx.vst3");
    project
        .master_track
        .effects
        .push(DeviceNode::single(ext_master_fx));
    project
}

#[test]
fn bounce_config_total_frames() {
    let config = BounceConfig {
        output_path: "/tmp/test.wav".to_string(),
        sample_rate: 44100,
        bit_depth: 32,
        start_frame: 0,
        end_frame: 44100,
        normalize: false,
        tail_frames: 4410,
        format: "wav".to_string(),
        project_sample_rate: 44100.0,
        bpm: 120.0,
    };
    assert_eq!(config.total_frames(), 48510);
}

#[test]
fn bounce_rejects_invalid_range() {
    let config = BounceConfig {
        output_path: "/tmp/test.wav".to_string(),
        sample_rate: 44100,
        bit_depth: 32,
        start_frame: 100,
        end_frame: 50, // end < start
        normalize: false,
        tail_frames: 0,
        format: "wav".to_string(),
        project_sample_rate: 44100.0,
        bpm: 120.0,
    };

    let bouncer = OfflineRenderer::new(config);
    let mut project = make_test_project();
    let mut pool = ClipPool::new();

    let result = bouncer.bounce(&mut project, &mut pool, None, &HashMap::new(), &[], |_| {});
    assert!(matches!(result, Err(BounceError::InvalidConfig(_))));
}

#[test]
fn bounce_rejects_invalid_bit_depth() {
    let config = BounceConfig {
        output_path: "/tmp/test.wav".to_string(),
        sample_rate: 44100,
        bit_depth: 8, // unsupported
        start_frame: 0,
        end_frame: 1000,
        normalize: false,
        tail_frames: 0,
        format: "wav".to_string(),
        project_sample_rate: 44100.0,
        bpm: 120.0,
    };

    let bouncer = OfflineRenderer::new(config);
    let mut project = make_test_project();
    let mut pool = ClipPool::new();

    let result = bouncer.bounce(&mut project, &mut pool, None, &HashMap::new(), &[], |_| {});
    assert!(matches!(result, Err(BounceError::InvalidConfig(_))));
}

#[test]
fn bounce_silence_produces_wav() {
    let out_path = unique_temp_audio_path("dream_bounce_test", "wav");
    let config = BounceConfig {
        output_path: out_path.to_str().unwrap().to_string(),
        sample_rate: 44100,
        bit_depth: 32,
        start_frame: 0,
        end_frame: 4096, // ~93ms
        normalize: false,
        tail_frames: 0,
        format: "wav".to_string(),
        project_sample_rate: 44100.0,
        bpm: 120.0,
    };

    let bouncer = OfflineRenderer::new(config);
    let mut project = make_test_project();
    let mut pool = ClipPool::new();

    let mut progress_values: Vec<f32> = Vec::new();
    let result = bouncer.bounce(&mut project, &mut pool, None, &HashMap::new(), &[], |p| {
        progress_values.push(p);
    });

    assert!(result.is_ok(), "Bounce failed: {:?}", result.err());
    assert!(out_path.exists(), "WAV file not created");

    // Progress should reach 1.0
    assert!(!progress_values.is_empty());
    assert!((progress_values.last().unwrap() - 1.0).abs() < 0.01);

    // Clean up
    let _ = std::fs::remove_file(&out_path);
}

#[test]
fn bounce_with_normalization() {
    let out_path = unique_temp_audio_path("dream_bounce_norm_test", "wav");
    let config = BounceConfig {
        output_path: out_path.to_str().unwrap().to_string(),
        sample_rate: 44100,
        bit_depth: 24,
        start_frame: 0,
        end_frame: 2048,
        normalize: true,
        tail_frames: 0,
        format: "wav".to_string(),
        project_sample_rate: 44100.0,
        bpm: 120.0,
    };

    let bouncer = OfflineRenderer::new(config);
    let mut project = make_test_project();
    let mut pool = ClipPool::new();

    let result = bouncer.bounce(&mut project, &mut pool, None, &HashMap::new(), &[], |_| {});
    assert!(result.is_ok());

    let _ = std::fs::remove_file(&out_path);
}

#[test]
fn bounce_continues_best_effort_when_external_vst_instrument_binding_is_missing() {
    let out_path = unique_temp_audio_path("dream_bounce_missing_vst_binding", "wav");
    let config = BounceConfig {
        output_path: out_path.to_str().unwrap().to_string(),
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

    let bouncer = OfflineRenderer::new(config);
    let mut project = make_external_vst_midi_project();
    let mut pool = ClipPool::new();

    // No runtime external FX slots supplied for the declared VST instrument.
    let result = bouncer.bounce(&mut project, &mut pool, None, &HashMap::new(), &[], |_| {});

    assert!(
        result.is_ok(),
        "expected best-effort bounce success for missing VST runtime binding, got {result:?}"
    );
    assert!(
        std::fs::metadata(&out_path).is_ok(),
        "expected output file to be written"
    );

    let _ = std::fs::remove_file(&out_path);
}

#[test]
fn bounce_continues_best_effort_when_external_vst_fx_binding_is_missing_on_track() {
    let out_path = unique_temp_audio_path("dream_bounce_missing_vst_track_fx_binding", "wav");
    let config = BounceConfig {
        output_path: out_path.to_str().unwrap().to_string(),
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

    let bouncer = OfflineRenderer::new(config);
    let mut project = make_external_vst_fx_project_on_track();
    let mut pool = ClipPool::new();

    let result = bouncer.bounce(&mut project, &mut pool, None, &HashMap::new(), &[], |_| {});
    assert!(
        result.is_ok(),
        "expected best-effort bounce success for missing track FX runtime binding, got {result:?}"
    );
    assert!(
        std::fs::metadata(&out_path).is_ok(),
        "expected output file to be written"
    );

    let _ = std::fs::remove_file(&out_path);
}

#[test]
fn bounce_continues_best_effort_when_external_vst_fx_binding_is_missing_on_master() {
    let out_path = unique_temp_audio_path("dream_bounce_missing_vst_master_fx_binding", "wav");
    let config = BounceConfig {
        output_path: out_path.to_str().unwrap().to_string(),
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

    let bouncer = OfflineRenderer::new(config);
    let mut project = make_external_vst_fx_project_on_master();
    let mut pool = ClipPool::new();

    let result = bouncer.bounce(&mut project, &mut pool, None, &HashMap::new(), &[], |_| {});
    assert!(
        result.is_ok(),
        "expected best-effort bounce success for missing master FX runtime binding, got {result:?}"
    );
    assert!(
        std::fs::metadata(&out_path).is_ok(),
        "expected output file to be written"
    );

    let _ = std::fs::remove_file(&out_path);
}

fn make_constant_stereo(frames: usize, value: f32) -> Vec<Vec<f32>> {
    vec![vec![value; frames], vec![value; frames]]
}

fn tail_avg_abs_stereo(interleaved: &[f32], channels: usize, start_frame: usize) -> f32 {
    let mut sum = 0.0f32;
    let mut n = 0usize;
    for frame in interleaved.chunks_exact(channels).skip(start_frame) {
        let l = frame[0].abs();
        let r = frame.get(1).copied().unwrap_or(frame[0]).abs();
        sum += (l + r) * 0.5;
        n += 1;
    }
    if n == 0 { 0.0 } else { sum / n as f32 }
}

#[test]
fn master_fx_processes_both_group_and_direct_paths() {
    use dream_models::time::AbsoluteTime;

    const SR: f64 = 44_100.0;
    const FRAMES: usize = 8192;
    const BPM: f64 = 174.0;

    let mut project = Project {
        sample_rate: SR,
        ..Project::default()
    };
    project.tracks.clear();

    // Group bus receiving one child track.
    let group = Track::with_type("Group", TrackType::Group, 0);
    let group_id = group.id;
    project.tracks.push(group);

    // Source A -> Group.
    let mut grouped_src = Track::with_type("GroupedSrc", TrackType::Audio, 1);
    grouped_src.output_destination_id = Some(group_id);
    grouped_src.clips.push(AudioClip::new(
        "GroupedClip",
        "__test__/grouped.wav",
        AbsoluteTime::ZERO,
        AbsoluteTime::new(FRAMES as i64),
    ));
    project.tracks.push(grouped_src);

    // Source B -> Master (direct path).
    let mut direct_src = Track::with_type("DirectSrc", TrackType::Audio, 2);
    direct_src.clips.push(AudioClip::new(
        "DirectClip",
        "__test__/direct.wav",
        AbsoluteTime::ZERO,
        AbsoluteTime::new(FRAMES as i64),
    ));
    project.tracks.push(direct_src);

    let mut clip_pool = ClipPool::new();
    clip_pool
        .insert(ClipAudio::new(
            "__test__/grouped.wav",
            make_constant_stereo(FRAMES, 0.5),
            SR as u32,
        ))
        .expect("insert grouped source");
    clip_pool
        .insert(ClipAudio::new(
            "__test__/direct.wav",
            make_constant_stereo(FRAMES, 0.5),
            SR as u32,
        ))
        .expect("insert direct source");

    let config = BounceConfig {
        output_path: "/tmp/unused.wav".to_string(),
        sample_rate: SR as u32,
        bit_depth: 32,
        start_frame: 0,
        end_frame: FRAMES as i64,
        normalize: false,
        tail_frames: 0,
        format: "wav".to_string(),
        project_sample_rate: SR,
        bpm: BPM,
    };
    let bouncer = OfflineRenderer::new(config);

    let clips_per_track: Vec<Vec<AudioClip>> =
        project.tracks.iter().map(|t| t.clips.clone()).collect();
    let midi_clips_per_track: Vec<Vec<dream_models::midi::MidiClip>> = project
        .tracks
        .iter()
        .map(|t| t.midi_clips.clone())
        .collect();
    let (routing, post_sum_mask) = OfflineRenderer::build_routing(&project);
    let sidechains: Vec<Vec<Option<usize>>> = vec![Vec::new(); project.tracks.len()];
    let mut render_ctx = bouncer.create_render_ctx(&project, None, SR);
    let mut output_no_master_fx = vec![0.0f32; FRAMES * OFFLINE_CHANNELS];
    let mut output_with_master_fx = vec![0.0f32; FRAMES * OFFLINE_CHANNELS];
    let mut master_chain_none = DeviceChain::new(SR as f32);
    let external_fx_map_empty = vec![Vec::<ExternalPluginRuntimeSlot>::new(); project.tracks.len() + 1];
    let plugin_registry: HashMap<uuid::Uuid, PluginInstanceArc> = HashMap::new();

    let mut routing_ctx_none = super::RenderRoutingCtx {
        clips_per_track: &clips_per_track,
        clip_pool: &clip_pool,
        routing: &routing,
        sidechains: &sidechains,
        post_sum_mask: &post_sum_mask,
        plugin_registry: &plugin_registry,
        external_fx_map: &external_fx_map_empty,
        bpm: BPM,
        time_sig_numerator: 4,
        time_sig_denominator: 4,
        master_device_chain: &mut master_chain_none,
        midi_clips_per_track: &midi_clips_per_track,
        loop_region: None,
    };
    OfflineRenderer::render_routing_aware(
        &mut render_ctx,
        &mut output_no_master_fx,
        &mut routing_ctx_none,
    );

    // Recreate render context for deterministic comparison from frame 0.
    let mut render_ctx_with_master = bouncer.create_render_ctx(&project, None, SR);
    let mut master_chain_utility = DeviceChain::new(SR as f32);
    let mut utility = PluginSlot::new("Utility", "internal://effect/utility");
    // Utility param[0] = Gain (dB). -60 dB should strongly attenuate master output.
    utility.params = Some(vec![-60.0]);
    OfflineRenderer::populate_device_chain_from_effects(
        &mut master_chain_utility,
        &[DeviceNode::single(utility)],
    );

    let mut routing_ctx_utility = super::RenderRoutingCtx {
        clips_per_track: &clips_per_track,
        clip_pool: &clip_pool,
        routing: &routing,
        sidechains: &sidechains,
        post_sum_mask: &post_sum_mask,
        plugin_registry: &plugin_registry,
        external_fx_map: &external_fx_map_empty,
        bpm: BPM,
        time_sig_numerator: 4,
        time_sig_denominator: 4,
        master_device_chain: &mut master_chain_utility,
        midi_clips_per_track: &midi_clips_per_track,
        loop_region: None,
    };
    OfflineRenderer::render_routing_aware(
        &mut render_ctx_with_master,
        &mut output_with_master_fx,
        &mut routing_ctx_utility,
    );

    let dry_tail = tail_avg_abs_stereo(&output_no_master_fx, OFFLINE_CHANNELS, FRAMES / 2);
    let wet_tail = tail_avg_abs_stereo(&output_with_master_fx, OFFLINE_CHANNELS, FRAMES / 2);

    assert!(
        dry_tail > 0.15,
        "expected non-trivial master level without master FX, got {dry_tail}"
    );
    assert!(
        wet_tail < dry_tail * 0.35,
        "master utility attenuation was not applied to combined group+direct paths: dry={dry_tail}, wet={wet_tail}"
    );
}
