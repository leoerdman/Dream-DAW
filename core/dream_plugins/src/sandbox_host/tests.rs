use super::*;
use std::sync::atomic::Ordering;

fn test_instance(
    status: PluginSandboxStatus,
    restart_count: u32,
    crash_count: u32,
    event_rx: Option<Receiver<PluginHostEventMessage>>,
) -> PluginSandboxInstance {
    PluginSandboxInstance {
        descriptor: PluginDescriptor::new(
            "Test",
            "Dream",
            crate::format::PluginFormat::VST3,
            crate::format::PluginCategory::Effect,
            PathBuf::from("/tmp/test.vst3"),
        ),
        process: None,
        status,
        crash_count,
        restart_count,
        bypass_requested: false,
        last_error: None,
        heartbeat_file: std::env::temp_dir().join("dream_daw_plugin_host_test.hb"),
        shared_region: SharedAudioRegion {
            map_name: "test".to_string(),
            num_inputs: 2,
            num_outputs: 2,
            max_frames: 64,
            total_bytes: 0,
        },
        _shared_region_owner: SharedAudioBufferRegion::create(
            std::env::temp_dir().join(format!(
                "dream_daw_plugin_host_test_region_{}.bin",
                Uuid::new_v4()
            )),
            SharedAudioBufferLayout {
                num_inputs: 2,
                num_outputs: 2,
                max_frames: 64,
            },
        )
        .expect("test invariant: unwrap removed for clippy policy"),
        control_stdin: None,
        event_rx,
        heartbeat_seq: 0,
        heartbeat_seen: false,
        spawned_at: SystemTime::now(),
        last_known_state_blob: None,
        ticks_since_last_save: 0,
        pending_events: Vec::new(),
    }
}

#[test]
fn supervisor_disabled_without_config() {
    let sup = PluginSandboxSupervisor::new(None);
    assert!(!sup.enabled());
}

#[test]
fn heartbeat_updates_running_state() {
    let mut sup = PluginSandboxSupervisor::new(None);
    // Force enabled flag for pure state test.
    sup.enabled = true;
    let id = Uuid::new_v4();
    sup.instances
        .insert(id, test_instance(PluginSandboxStatus::Spawning, 0, 0, None));
    sup.mark_heartbeat(id);
    let snap = sup.snapshot();
    assert_eq!(snap.instances.len(), 1);
    assert_eq!(snap.instances[0].status, PluginSandboxStatus::Running);
}

#[test]
fn crash_flag_signal_sets_and_clears_atomically() {
    let id = Uuid::new_v4();
    let crash_flag = Arc::new(AtomicBool::new(false));
    let mut crash_flags: HashMap<Uuid, Arc<AtomicBool>> = HashMap::new();
    crash_flags.insert(id, crash_flag.clone());

    PluginSandboxSupervisor::signal_crash(&crash_flags, &id);
    assert!(crash_flag.load(Ordering::Relaxed));

    PluginSandboxSupervisor::signal_recovery(&crash_flags, &id);
    assert!(!crash_flag.load(Ordering::Relaxed));
}

#[test]
fn ready_after_restart_emits_recovery_event() {
    let mut sup = PluginSandboxSupervisor::new(None);
    sup.enabled = true;
    let id = Uuid::new_v4();
    let (tx, rx) = mpsc::channel();
    tx.send(PluginHostEventMessage::Ready {
        protocol_version: 1,
        shared_region: None,
    })
    .expect("test invariant: unwrap removed for clippy policy");
    drop(tx);
    sup.instances.insert(
        id,
        test_instance(PluginSandboxStatus::Spawning, 1, 1, Some(rx)),
    );

    let _ = sup.tick_watchdog();
    let recoveries = sup.drain_recovery_events();
    let snap = sup.snapshot();

    assert_eq!(recoveries.len(), 1);
    assert_eq!(recoveries[0].instance_id, id);
    assert_eq!(snap.instances.len(), 1);
    assert_eq!(snap.instances[0].status, PluginSandboxStatus::Running);
    assert!(!snap.instances[0].bypass_requested);
}

#[test]
fn ready_on_initial_start_does_not_emit_recovery_event() {
    let mut sup = PluginSandboxSupervisor::new(None);
    sup.enabled = true;
    let id = Uuid::new_v4();
    let (tx, rx) = mpsc::channel();
    tx.send(PluginHostEventMessage::Ready {
        protocol_version: 1,
        shared_region: None,
    })
    .expect("test invariant: unwrap removed for clippy policy");
    drop(tx);
    sup.instances.insert(
        id,
        test_instance(PluginSandboxStatus::Spawning, 0, 0, Some(rx)),
    );

    let _ = sup.tick_watchdog();
    let recoveries = sup.drain_recovery_events();

    assert!(recoveries.is_empty());
}

#[test]
fn repeated_ready_while_running_does_not_duplicate_recovery_event() {
    let mut sup = PluginSandboxSupervisor::new(None);
    sup.enabled = true;
    let id = Uuid::new_v4();
    let (tx, rx) = mpsc::channel();
    tx.send(PluginHostEventMessage::Ready {
        protocol_version: 1,
        shared_region: None,
    })
    .expect("test invariant: unwrap removed for clippy policy");
    tx.send(PluginHostEventMessage::Ready {
        protocol_version: 1,
        shared_region: None,
    })
    .expect("test invariant: unwrap removed for clippy policy");
    drop(tx);
    sup.instances.insert(
        id,
        test_instance(PluginSandboxStatus::Spawning, 2, 1, Some(rx)),
    );

    let _ = sup.tick_watchdog();
    let recoveries = sup.drain_recovery_events();

    assert_eq!(recoveries.len(), 1);
    assert_eq!(recoveries[0].instance_id, id);
}

#[test]
fn has_pending_recovery_events_reflects_queue_state() {
    let mut sup = PluginSandboxSupervisor::new(None);
    sup.enabled = true;
    let id = Uuid::new_v4();
    let (tx, rx) = mpsc::channel();
    tx.send(PluginHostEventMessage::Ready {
        protocol_version: 1,
        shared_region: None,
    })
    .expect("test invariant: unwrap removed for clippy policy");
    drop(tx);
    sup.instances.insert(
        id,
        test_instance(PluginSandboxStatus::Spawning, 1, 1, Some(rx)),
    );

    assert!(!sup.has_pending_recovery_events());
    let _ = sup.tick_watchdog();
    assert!(sup.has_pending_recovery_events());

    let drained = sup.drain_recovery_events();
    assert_eq!(drained.len(), 1);
    assert!(!sup.has_pending_recovery_events());
}

#[test]
fn crashed_then_ready_toggles_shared_crash_flag_and_emits_both_events() {
    let mut sup = PluginSandboxSupervisor::new(None);
    sup.enabled = true;
    let id = Uuid::new_v4();
    let (tx, rx) = mpsc::channel();
    tx.send(PluginHostEventMessage::Crashed {
        instance_id: Some(id),
        reason: "simulated crash".to_string(),
    })
    .expect("test invariant: unwrap removed for clippy policy");
    tx.send(PluginHostEventMessage::Ready {
        protocol_version: 1,
        shared_region: None,
    })
    .expect("test invariant: unwrap removed for clippy policy");
    drop(tx);

    sup.instances.insert(
        id,
        test_instance(PluginSandboxStatus::Running, 1, 0, Some(rx)),
    );
    let crash_flag = Arc::new(AtomicBool::new(false));
    sup.register_crash_flag(id, crash_flag.clone());

    let _ = sup.tick_watchdog();

    // Ready should clear the crash flag after transient crash processing.
    assert!(!crash_flag.load(Ordering::Relaxed));

    let crashes = sup.drain_crash_events();
    assert_eq!(crashes.len(), 1);
    assert_eq!(crashes[0].instance_id, id);
    assert!(!crashes[0].auto_restarted);

    let recoveries = sup.drain_recovery_events();
    assert_eq!(recoveries.len(), 1);
    assert_eq!(recoveries[0].instance_id, id);
}

#[test]
fn crashed_event_sets_bypass_requested() {
    let mut sup = PluginSandboxSupervisor::new(None);
    sup.enabled = true;
    let id = Uuid::new_v4();
    let (tx, rx) = mpsc::channel();
    tx.send(PluginHostEventMessage::Crashed {
        instance_id: Some(id),
        reason: "simulated crash".to_string(),
    })
    .expect("test invariant: unwrap removed for clippy policy");
    drop(tx);

    sup.instances.insert(
        id,
        test_instance(PluginSandboxStatus::Running, 0, 0, Some(rx)),
    );
    let _ = sup.tick_watchdog();
    let snap = sup.snapshot();
    let crashes = sup.drain_crash_events();

    assert_eq!(crashes.len(), 1);
    assert_eq!(snap.instances.len(), 1);
    assert!(snap.instances[0].bypass_requested);
    assert_eq!(snap.instances[0].status, PluginSandboxStatus::Crashed);
}
