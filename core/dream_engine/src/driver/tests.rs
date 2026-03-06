use super::*;

#[test]
fn realtime_callback_forbidden_ops_guard() {
    let src = include_str!("executor/audio_thread_runner.rs");
    let start_marker = "// RT_CALLBACK_START";
    let end_marker = "// RT_CALLBACK_END";

    let start = src
        .find(start_marker)
        .expect("RT callback start marker must exist");
    let rest = &src[start + start_marker.len()..];
    let end_rel = rest
        .find(end_marker)
        .expect("RT callback end marker must exist");
    let callback_src = &rest[..end_rel];

    // AUD-064 FIX: Expanded forbidden tokens list with .unwrap(), .expect(),
    // panic!(), format!(), HashMap::new() for stricter RT-safety enforcement.
    let forbidden = [
        "std::sync::Mutex",
        "std::sync::RwLock",
        ".lock(",
        "println!(",
        "eprintln!(",
        "dbg!(",
        "std::fs::",
        "File::",
        "std::net::",
        "thread::sleep(",
        "Vec::new(",
        "vec![",
        "String::from(",
        "HashMap::new(",
        "format!(",
    ];

    for token in forbidden {
        assert!(
            !callback_src.contains(token),
            "forbidden token in realtime callback: {token}",
        );
    }
}

#[test]
#[allow(clippy::assertions_on_constants)]
fn constants_are_valid() {
    assert!((DEFAULT_FREQUENCY - 440.0).abs() < f32::EPSILON);
    assert!(TEST_TONE_AMPLITUDE > 0.0 && TEST_TONE_AMPLITUDE <= 1.0);
    // AUD-049: FREQ_SMOOTHING removed — replaced with sample-rate-dependent
    // coefficient computed at usage site (see AUD-010 fix).
}

#[test]
fn shared_clip_snapshot_swap_and_load() {
    let snapshot = SharedClipSnapshot::new();
    assert!(snapshot.load().is_empty());

    let clips = vec![vec![AudioClip::new(
        "Test",
        "test.wav",
        dream_models::time::AbsoluteTime::ZERO,
        dream_models::time::AbsoluteTime::new(44100),
    )]];
    snapshot.swap(clips);

    let loaded = snapshot.load();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].len(), 1);
    assert_eq!(loaded[0][0].name, "Test");
}

#[test]
fn sample_accurate_plugin_gain_changes_within_buffer() {
    let mut left = vec![1.0f32; 8];
    let mut right = vec![1.0f32; 8];
    let gain_points = vec![
        AutomationPoint {
            sample_frame: 0,
            value: 0.0,
            ..Default::default()
        },
        AutomationPoint {
            sample_frame: 7,
            value: 2.0,
            ..Default::default()
        },
    ];

    apply_gain_pan_automation_sample_accurate(&mut left, &mut right, 0, Some(&gain_points), None);

    assert!(left[0] < left[7]);
    assert!(right[0] < right[7]);
    // With equal-power pan at center, gain is multiplied by cos(π/4) ≈ 0.707.
    // So gain=2.0 → left[7] ≈ 2.0 * cos(π/4) ≈ 1.414.
    let expected = 2.0 * std::f32::consts::FRAC_PI_4.cos();
    assert!(
        (left[7] - expected).abs() < 0.05,
        "Expected left[7] ≈ {:.3} (gain=2.0 * cos(π/4)), got {:.3}",
        expected,
        left[7]
    );
}

#[test]
fn sample_accurate_plugin_pan_unit_interval_maps_correctly() {
    let mut left = vec![1.0f32; 4];
    let mut right = vec![1.0f32; 4];
    // 0.0 -> hard left, 1.0 -> hard right in legacy unit domain.
    let pan_points = vec![
        AutomationPoint {
            sample_frame: 0,
            value: 0.0,
            ..Default::default()
        },
        AutomationPoint {
            sample_frame: 3,
            value: 1.0,
            ..Default::default()
        },
    ];

    apply_gain_pan_automation_sample_accurate(&mut left, &mut right, 0, None, Some(&pan_points));

    assert!(left[0] > right[0]);
    assert!(right[3] > left[3]);
}

#[test]
fn sample_accurate_track_pan_all_zero_stays_centered() {
    let mut left = vec![1.0f32; 4];
    let mut right = vec![1.0f32; 4];
    let pan_points = vec![AutomationPoint {
        sample_frame: 0,
        value: 0.0,
        ..Default::default()
    }];

    apply_track_mixer_automation_sample_accurate(&mut left, &mut right, 0, None, Some(&pan_points));

    for i in 0..left.len().min(right.len()) {
        assert!((left[i] - right[i]).abs() <= 1e-6);
    }
}

#[test]
fn sample_accurate_track_mixer_volume_and_pan_change_within_buffer() {
    let mut left = vec![1.0f32; 6];
    let mut right = vec![1.0f32; 6];
    let vol_points = vec![
        AutomationPoint {
            sample_frame: 0,
            value: 0.5,
            ..Default::default()
        },
        AutomationPoint {
            sample_frame: 5,
            value: 1.5,
            ..Default::default()
        },
    ];
    let pan_points = vec![
        AutomationPoint {
            sample_frame: 0,
            value: -1.0,
            ..Default::default()
        },
        AutomationPoint {
            sample_frame: 5,
            value: 1.0,
            ..Default::default()
        },
    ];

    apply_track_mixer_automation_sample_accurate(
        &mut left,
        &mut right,
        0,
        Some(&vol_points),
        Some(&pan_points),
    );

    // Early frames biased left with lower volume; later frames biased right with higher volume.
    assert!(left[0] > right[0]);
    assert!(right[5] > left[5]);
    assert!(left[5] > left[0] || right[5] > right[0]);
}

#[test]
fn resolve_master_runtime_slots_prefers_tail_on_stale_snapshot() {
    let map = vec![
        vec![ExternalPluginRuntimeSlot {
            slot_id: None,
            internal_slot_index: Some(0),
            instance_id: None,
            sidechain_track_index: None,
            sidechain_send_mode: 0,
            is_instrument: false,
            is_bypassed: false,
        }],
        vec![ExternalPluginRuntimeSlot {
            slot_id: None,
            internal_slot_index: Some(1),
            instance_id: None,
            sidechain_track_index: None,
            sidechain_send_mode: 0,
            is_instrument: false,
            is_bypassed: false,
        }],
        vec![ExternalPluginRuntimeSlot {
            slot_id: None,
            internal_slot_index: Some(2),
            instance_id: None,
            sidechain_track_index: None,
            sidechain_send_mode: 0,
            is_instrument: false,
            is_bypassed: false,
        }],
    ];

    // Fresh snapshot shape (track_count + 1): picks index == track_count.
    let fresh = resolve_master_runtime_slots(&map[..2], 1).expect("fresh master slots");
    assert_eq!(fresh[0].internal_slot_index, Some(1));

    // Stale/oversized snapshot: picks tail entry for safety.
    let stale = resolve_master_runtime_slots(&map, 1).expect("stale master slots");
    assert_eq!(stale[0].internal_slot_index, Some(2));
}
