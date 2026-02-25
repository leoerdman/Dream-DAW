use super::*;

#[test]
fn project_creation() {
    let project = Project::new("Test Song", 140.0, 48000.0);
    assert_eq!(project.name, "Test Song");
    assert_eq!(project.track_count(), 0);
    assert!((project.sample_rate - 48000.0).abs() < f64::EPSILON);
    assert!((project.pulse_map.initial_bpm() - 140.0).abs() < f64::EPSILON);
    assert_eq!(project.time_signature, TimeSignature::default());
}

#[test]
fn add_and_find_tracks() {
    let mut project = Project::new("Test", 120.0, 44100.0);

    let track = Track::new("Lead Vocal");
    let tid = track.id;
    project.add_track(track);

    assert_eq!(project.track_count(), 1);
    assert!(project.find_track(tid).is_some());
    assert_eq!(project.find_track(tid).unwrap().name, "Lead Vocal");
}

#[test]
fn clip_end_position() {
    let clip = AudioClip::new(
        "Test Clip",
        "audio/test.wav",
        AbsoluteTime::new(44100), // starts at 1s
        AbsoluteTime::new(88200), // duration 2s
    );
    assert_eq!(clip.end_position().sample_frame, 132300); // 3s
}

#[test]
fn track_defaults() {
    let track = Track::new("Guitar");
    assert!((track.volume - 1.0).abs() < f64::EPSILON);
    assert!((track.pan - 0.0).abs() < f64::EPSILON);
    assert!(!track.is_solo);
    assert!(!track.is_disabled);
    assert!(!track.is_armed);
    assert_eq!(track.track_type, TrackType::Audio);
    assert!((track.height - 48.0).abs() < f64::EPSILON);
    assert!(track.effects.is_empty());
    assert!(track.instrument.is_none());
    assert!(track.parent_track_id.is_none());
    assert!(track.child_track_ids.is_empty());
    assert!(track.is_expanded);
}

#[test]
fn project_serialization_roundtrip() {
    let mut project = Project::new("Roundtrip Test", 128.0, 96000.0);
    let mut track = Track::new("Drums");
    track.volume = 0.8;
    track.pan = -0.5;
    track.clips.push(AudioClip::new(
        "Kick",
        "audio/kick.wav",
        AbsoluteTime::ZERO,
        AbsoluteTime::new(48000),
    ));
    project.add_track(track);

    let json = serde_json::to_string_pretty(&project).unwrap();
    let restored: Project = serde_json::from_str(&json).unwrap();

    assert_eq!(restored.name, "Roundtrip Test");
    assert_eq!(restored.track_count(), 1);
    assert_eq!(restored.tracks[0].name, "Drums");
    assert_eq!(restored.tracks[0].clips.len(), 1);
    assert_eq!(restored.tracks[0].clips[0].name, "Kick");
}

#[test]
fn output_enabled_from_model_defaults_true_without_lane() {
    let track = Track::new("T");
    assert!(track.output_enabled_from_model());
    assert!(!track.effective_disabled_from_model());
}

#[test]
fn output_enabled_from_model_reads_static_lane() {
    let mut track = Track::new("T");
    track.automation_lanes.push(AutomationLane {
        param_id: "mixer.output_enabled".to_string(),
        points: vec![AutomationPoint {
            beat: 0.0,
            value: 0.0,
            curve_type: "linear".to_string(),
            tension: None,
            bezier_cp1x: None,
            bezier_cp1y: None,
            bezier_cp2x: None,
            bezier_cp2y: None,
        }],
    });
    assert!(!track.output_enabled_from_model());
    assert!(track.effective_disabled_from_model());
}

// ── New Sprint 13 tests ────────────────────────────────────────────

#[test]
fn track_color_16_variants() {
    // Verify all 16 colors serialize and deserialize
    let colors = [
        TrackColor::Coral,
        TrackColor::Orange,
        TrackColor::Gold,
        TrackColor::Yellow,
        TrackColor::Lime,
        TrackColor::Green,
        TrackColor::Teal,
        TrackColor::Cyan,
        TrackColor::Sky,
        TrackColor::Blue,
        TrackColor::Indigo,
        TrackColor::Purple,
        TrackColor::Magenta,
        TrackColor::Pink,
        TrackColor::Rose,
        TrackColor::Slate,
    ];

    for (i, color) in colors.iter().enumerate() {
        let json = serde_json::to_string(color).unwrap();
        let restored: TrackColor = serde_json::from_str(&json).unwrap();
        assert_eq!(*color, restored, "Color roundtrip failed for index {i}");
        assert!(!color.hex().is_empty());
    }
}

#[test]
fn track_color_for_index_cycles() {
    assert_eq!(TrackColor::for_index(0), TrackColor::Coral);
    assert_eq!(TrackColor::for_index(15), TrackColor::Slate);
    assert_eq!(TrackColor::for_index(16), TrackColor::Coral); // Wraps around
}

#[test]
fn track_type_serialization() {
    for tt in [
        TrackType::Audio,
        TrackType::Midi,
        TrackType::Group,
        TrackType::Master,
    ] {
        let json = serde_json::to_string(&tt).unwrap();
        let restored: TrackType = serde_json::from_str(&json).unwrap();
        assert_eq!(tt, restored);
    }
}

#[test]
fn time_signature_beats_per_bar() {
    assert_eq!(TimeSignature::new(4, 4).beats_per_bar(), 4);
    assert_eq!(TimeSignature::new(3, 4).beats_per_bar(), 3);
    assert_eq!(TimeSignature::new(6, 8).beats_per_bar(), 3);
    assert_eq!(TimeSignature::new(7, 8).beats_per_bar(), 3); // integer division: 7*4/8 = 3
    assert_eq!(TimeSignature::new(2, 4).beats_per_bar(), 2);
}

#[test]
fn time_signature_display() {
    assert_eq!(TimeSignature::new(4, 4).display(), "4/4");
    assert_eq!(TimeSignature::new(6, 8).display(), "6/8");
}

#[test]
fn plugin_slot_creation() {
    let slot = PluginSlot::new("Pro-Q 3", "com.fabfilter.pro-q-3");
    assert_eq!(slot.name, "Pro-Q 3");
    assert_eq!(slot.plugin_id, "com.fabfilter.pro-q-3");
    assert!(!slot.is_bypassed);
    assert_eq!(slot.latency_frames, 0);
}

#[test]
fn track_total_latency() {
    let mut track = Track::new("Test");
    assert_eq!(track.total_latency_frames(), 0);

    track.instrument = Some(DeviceNode::Single(PluginSlot {
        id: Uuid::new_v4(),
        name: "Serum".into(),
        plugin_id: "com.xfer.serum".into(),
        is_bypassed: false,
        latency_frames: 64,
        sidechain_source_track_id: None,
        supports_sidechain_input: None,
        external_audio_inputs: None,
        external_format: None,
        external_uid: None,
        external_preset_name: None,
        external_program_number: None,
        external_parameter_count: None,
        external_stored_all_parameters: None,
        external_plugin_version: None,
        external_state_blob: None,
        external_state_blob_kind: None,
        external_preset_blob: None,
        external_preset_blob_kind: None,
        params: None,
    }));

    track.effects.push(DeviceNode::Single(PluginSlot {
        id: Uuid::new_v4(),
        name: "Limiter".into(),
        plugin_id: "com.fabfilter.pro-l-2".into(),
        is_bypassed: false,
        latency_frames: 128,
        sidechain_source_track_id: None,
        supports_sidechain_input: None,
        external_audio_inputs: None,
        external_format: None,
        external_uid: None,
        external_preset_name: None,
        external_program_number: None,
        external_parameter_count: None,
        external_stored_all_parameters: None,
        external_plugin_version: None,
        external_state_blob: None,
        external_state_blob_kind: None,
        external_preset_blob: None,
        external_preset_blob_kind: None,
        params: None,
    }));

    track.effects.push(DeviceNode::Single(PluginSlot {
        id: Uuid::new_v4(),
        name: "EQ".into(),
        plugin_id: "com.fabfilter.pro-q-3".into(),
        is_bypassed: true, // Bypassed — should NOT count
        latency_frames: 32,
        sidechain_source_track_id: None,
        supports_sidechain_input: None,
        external_audio_inputs: None,
        external_format: None,
        external_uid: None,
        external_preset_name: None,
        external_program_number: None,
        external_parameter_count: None,
        external_stored_all_parameters: None,
        external_plugin_version: None,
        external_state_blob: None,
        external_state_blob_kind: None,
        external_preset_blob: None,
        external_preset_blob_kind: None,
        params: None,
    }));

    assert_eq!(track.total_latency_frames(), 64 + 128); // Instrument + active effect
}

#[test]
fn track_with_type() {
    let track = Track::with_type("Synth Lead", TrackType::Midi, 5);
    assert_eq!(track.track_type, TrackType::Midi);
    assert_eq!(track.color, TrackColor::Green); // Index 5
}

#[test]
fn project_any_solo() {
    let mut project = Project::default();
    assert!(!project.any_solo());

    let mut track = Track::new("Solo Track");
    track.is_solo = true;
    project.add_track(track);

    assert!(project.any_solo());
}

#[test]
fn project_end_position() {
    let mut project = Project::default();
    let mut track = Track::new("Track 1");
    track.clips.push(AudioClip::new(
        "A",
        "a.wav",
        AbsoluteTime::new(0),
        AbsoluteTime::new(44100),
    ));
    project.add_track(track);

    let mut track2 = Track::new("Track 2");
    track2.clips.push(AudioClip::new(
        "B",
        "b.wav",
        AbsoluteTime::new(44100),
        AbsoluteTime::new(88200),
    ));
    project.add_track(track2);

    assert_eq!(project.end_position().sample_frame, 132300); // 44100 + 88200
}

#[test]
fn project_move_track() {
    let mut project = Project::new("Test", 120.0, 44100.0);
    project.add_track(Track::new("A"));
    project.add_track(Track::new("B"));
    project.add_track(Track::new("C"));

    project.move_track(0, 2);

    assert_eq!(project.tracks[0].name, "B");
    assert_eq!(project.tracks[1].name, "C");
    assert_eq!(project.tracks[2].name, "A");
}

#[test]
fn clip_contains_frame() {
    let clip = AudioClip::new(
        "Test",
        "test.wav",
        AbsoluteTime::new(100),
        AbsoluteTime::new(200),
    );

    assert!(!clip.contains_frame(99));
    assert!(clip.contains_frame(100));
    assert!(clip.contains_frame(200));
    assert!(!clip.contains_frame(300));
}

#[test]
fn clip_overlaps_range() {
    let clip = AudioClip::new(
        "Test",
        "test.wav",
        AbsoluteTime::new(100),
        AbsoluteTime::new(200),
    );

    assert!(clip.overlaps(50, 150)); // Overlaps start
    assert!(clip.overlaps(200, 400)); // Overlaps end
    assert!(clip.overlaps(0, 500)); // Fully contains
    assert!(clip.overlaps(150, 250)); // Straddles
    assert!(!clip.overlaps(0, 100)); // Before (end is exclusive)
    assert!(!clip.overlaps(300, 400)); // After
}

#[test]
fn master_track_is_slate() {
    let project = Project::default();
    assert_eq!(project.master_track.color, TrackColor::Slate);
    assert_eq!(project.master_track.track_type, TrackType::Master);
}

#[test]
fn default_project_starts_with_three_audio_and_three_midi_tracks() {
    let project = Project::default();

    assert_eq!(project.tracks.len(), 6);
    assert!(
        project
            .tracks
            .iter()
            .take(3)
            .all(|t| t.track_type == TrackType::Audio)
    );
    assert!(
        project
            .tracks
            .iter()
            .skip(3)
            .take(3)
            .all(|t| t.track_type == TrackType::Midi)
    );
    assert_eq!(project.tracks[0].name, "Audio 1");
    assert_eq!(project.tracks[2].name, "Audio 3");
    assert_eq!(project.tracks[3].name, "MIDI 1");
    assert_eq!(project.tracks[5].name, "MIDI 3");
}

#[test]
fn builtin_effect_mapping_supports_internal_eq_alias_ids() {
    let expected_eq_type = builtin_effect_type_from_plugin_id("internal://effect/eq-eight");
    assert_eq!(
        builtin_effect_type_from_plugin_id("internal://effect/eq"),
        expected_eq_type
    );
    assert_eq!(
        builtin_effect_type_from_plugin_id("internal://effect/eq8"),
        expected_eq_type
    );
    assert_eq!(
        builtin_effect_type_from_plugin_id("internal://effect/eqthree"),
        expected_eq_type
    );
}

#[test]
fn builtin_effect_mapping_supports_legacy_plain_eq_ids_only() {
    let expected_eq_type = builtin_effect_type_from_plugin_id("internal://effect/eq-eight");
    assert_eq!(builtin_effect_type_from_plugin_id("eq"), expected_eq_type);
    assert_eq!(builtin_effect_type_from_plugin_id("eq8"), expected_eq_type);
    assert_eq!(builtin_effect_type_from_plugin_id("channel eq"), expected_eq_type);
    assert_eq!(
        builtin_effect_type_from_plugin_id("/Library/Audio/Plug-Ins/VST3/FabFilter Pro-Q 4.vst3"),
        None
    );
}
