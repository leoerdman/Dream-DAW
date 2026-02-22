// ═══════════════════════════════════════════════════════════════════════════
// Plugin Host Daemon — Out-of-Process VST3 Plugin Executor
// ═══════════════════════════════════════════════════════════════════════════
//
// This binary runs as a child process of Dream DAW, hosting a single VST3
// plugin instance in isolation. If this process crashes (e.g., due to a buggy
// third-party plugin), the main DAW process survives and can recover.
//
// Communication:
//   - Control plane: JSON messages over stdin/stdout (heartbeat, load, params)
//   - Data plane: Shared memory mmap with atomic seq-counter synchronization
//   - MIDI: Inline events in shared mem header + overflow via IPC
//
// Processing loop (seq-based, replaces legacy 25ms polling):
//   1. Check for new request_seq from host (Acquire)
//   2. Read inputs from shared memory via read_input_channel
//   3. Process through loaded VST3 plugin
//   4. Write outputs to shared memory via write_output_channel
//   5. Store processed_seq (Release) to signal completion to host

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

use dream_plugins::descriptor::PluginDescriptor;
use dream_plugins::format::{PluginCategory, PluginFormat};
use dream_plugins::instance::{MidiEvent, PluginInstance};
use dream_plugins::sandbox_ipc::{PluginHostControlMessage, PluginHostEventMessage};
use dream_plugins::shared_memory::{SharedAudioBufferLayout, SharedAudioBufferRegion};
use dream_plugins::vst3_host::Vst3Instance;
use uuid::Uuid;

// ── Configuration ───────────────────────────────────────────────────────

/// Sleep duration when no new work is available from the host.
/// Balances latency vs. CPU — 1ms keeps the daemon responsive without
/// burning a full core.
const IDLE_SLEEP: Duration = Duration::from_millis(1);

/// Maximum time between heartbeats before self-terminating (orphan protection).
/// If the host crashes or terminates without sending Shutdown, the daemon
/// will self-terminate after this interval to avoid zombie processes.
const ORPHAN_TIMEOUT: Duration = Duration::from_secs(30);

// ── Args ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct Args {
    instance_id: String,
    plugin_path: String,
    heartbeat_file: PathBuf,
    shared_region_file: Option<PathBuf>,
    num_inputs: u16,
    num_outputs: u16,
    max_frames: u32,
}

fn parse_args() -> Result<Args, String> {
    let mut instance_id = None;
    let mut plugin_path = None;
    let mut heartbeat_file = None;
    let mut shared_region_file = None;
    let mut num_inputs: Option<u16> = None;
    let mut num_outputs: Option<u16> = None;
    let mut max_frames: Option<u32> = None;
    let mut daemon_mode = false;

    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--daemon" | "--plugin-host-daemon" => daemon_mode = true,
            "--instance-id" => instance_id = it.next(),
            "--plugin-path" => plugin_path = it.next(),
            "--heartbeat-file" => heartbeat_file = it.next().map(PathBuf::from),
            "--shared-region-file" => shared_region_file = it.next().map(PathBuf::from),
            "--num-inputs" => num_inputs = it.next().and_then(|v| v.parse::<u16>().ok()),
            "--num-outputs" => num_outputs = it.next().and_then(|v| v.parse::<u16>().ok()),
            "--max-frames" => max_frames = it.next().and_then(|v| v.parse::<u32>().ok()),
            _ => {}
        }
    }

    if !daemon_mode {
        return Err("Missing --daemon flag".to_string());
    }

    Ok(Args {
        instance_id: instance_id.ok_or("Missing --instance-id")?,
        plugin_path: plugin_path.ok_or("Missing --plugin-path")?,
        heartbeat_file: heartbeat_file.ok_or("Missing --heartbeat-file")?,
        shared_region_file,
        num_inputs: num_inputs.unwrap_or(2),
        num_outputs: num_outputs.unwrap_or(2),
        max_frames: max_frames.unwrap_or(2048),
    })
}

// ── Audio Processing ────────────────────────────────────────────────────

/// Processes one audio block through the loaded plugin using shared memory.
fn process_audio_block(
    region: &mut SharedAudioBufferRegion,
    plugin: &mut dyn PluginInstance,
    num_frames: usize,
    midi: &[MidiEvent],
    output_gain: f32,
    num_inputs: u16,
    num_outputs: u16,
) {
    // Read inputs from shared memory.
    let mut input_bufs: Vec<Vec<f32>> = Vec::with_capacity(num_inputs as usize);
    for ch in 0..num_inputs as usize {
        let mut buf = vec![0.0f32; num_frames];
        if region.read_input_channel(ch, num_frames, &mut buf).is_err() {
            buf.fill(0.0);
        }
        input_bufs.push(buf);
    }
    let input_refs: Vec<&[f32]> = input_bufs.iter().map(|b| b.as_slice()).collect();

    // Prepare output buffers.
    let mut output_bufs: Vec<Vec<f32>> = (0..num_outputs as usize)
        .map(|_| vec![0.0; num_frames])
        .collect();
    let mut output_slices: Vec<&mut [f32]> = output_bufs
        .iter_mut()
        .map(|b| b.as_mut_slice())
        .collect();

    // Process through the plugin.
    let _ = plugin.process(&input_refs, &mut output_slices, num_frames, midi);

    // Apply output gain if necessary.
    if (output_gain - 1.0).abs() > f32::EPSILON {
        for out in output_bufs.iter_mut() {
            for s in out.iter_mut() {
                *s *= output_gain;
            }
        }
    }

    // Write outputs back to shared memory.
    for (ch, out) in output_bufs.iter().enumerate() {
        let _ = region.write_output_channel(ch, &out[..num_frames]);
    }
}

/// Passthrough: copies input channels to output channels (bypass mode).
fn process_passthrough(
    region: &mut SharedAudioBufferRegion,
    num_frames: usize,
    num_inputs: u16,
    num_outputs: u16,
) {
    for out_idx in 0..num_outputs as usize {
        if out_idx < num_inputs as usize {
            let mut buf = vec![0.0f32; num_frames];
            let _ = region.read_input_channel(out_idx, num_frames, &mut buf);
            let _ = region.write_output_channel(out_idx, &buf);
        } else {
            let silence = vec![0.0f32; num_frames];
            let _ = region.write_output_channel(out_idx, &silence);
        }
    }
}

// ── Main ────────────────────────────────────────────────────────────────

fn main() {
    env_logger::Builder::from_default_env()
        .format_timestamp_millis()
        .init();

    let args = match parse_args() {
        Ok(v) => v,
        Err(err) => {
            eprintln!("[plugin_host_daemon] {err}");
            std::process::exit(2);
        }
    };

    log::info!(
        "[plugin_host_daemon] started instance={} path={}",
        args.instance_id,
        args.plugin_path
    );

    // Open shared memory region.
    let layout = SharedAudioBufferLayout {
        num_inputs: args.num_inputs,
        num_outputs: args.num_outputs,
        max_frames: args.max_frames,
    };
    let mut shared_region = args.shared_region_file.as_ref().and_then(|path| {
        SharedAudioBufferRegion::open_existing(path.clone(), layout.clone())
            .map_err(|e| log::error!("[plugin_host_daemon] shared region open failed: {e}"))
            .ok()
    });
    if shared_region.is_some() {
        log::info!("[plugin_host_daemon] shared region attached");
    }

    // Spawn stdin reader thread for control messages.
    let running = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let running_stdin = running.clone();
    let (cmd_tx, cmd_rx) = mpsc::channel::<PluginHostControlMessage>();

    thread::spawn(move || {
        let stdin = std::io::stdin();
        let reader = BufReader::new(stdin);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<PluginHostControlMessage>(trimmed) {
                Ok(cmd) => {
                    let is_shutdown = matches!(cmd, PluginHostControlMessage::Shutdown);
                    if cmd_tx.send(cmd).is_err() {
                        break;
                    }
                    if is_shutdown {
                        running_stdin.store(false, Ordering::Relaxed);
                        break;
                    }
                }
                Err(err) => {
                    log::warn!("[plugin_host_daemon] invalid control message: {err}");
                }
            }
        }
    });

    let daemon_instance_id: Uuid = args.instance_id.parse().unwrap_or_else(|_| Uuid::new_v4());
    let mut loaded_instances: HashMap<Uuid, Box<dyn PluginInstance>> = HashMap::new();
    let mut pending_midi: HashMap<Uuid, Vec<MidiEvent>> = HashMap::new();
    let mut output_gain: f32 = 1.0;
    let mut last_heartbeat = Instant::now();
    let mut last_seen_seq: u32 = 0;

    // ── Main Processing Loop ────────────────────────────────────────────
    while running.load(Ordering::Relaxed) {
        // ── Drain control messages (non-blocking) ───────────────────────
        loop {
            match cmd_rx.try_recv() {
                Ok(msg) => match msg {
                    PluginHostControlMessage::Hello {
                        protocol_version,
                        host_name,
                    } => {
                        let evt = PluginHostEventMessage::Ready {
                            protocol_version,
                            shared_region: None,
                        };
                        if let Ok(json) = serde_json::to_string(&evt) {
                            println!("{json}");
                        }
                        log::info!("[plugin_host_daemon] hello from host: {host_name}");
                    }
                    PluginHostControlMessage::LoadPlugin {
                        instance_id,
                        plugin_path,
                        sample_rate,
                        max_block_size,
                    } => {
                        let path = PathBuf::from(&plugin_path);
                        if !path.exists() {
                            log::error!(
                                "[plugin_host_daemon] plugin path does not exist: {}",
                                plugin_path
                            );
                            let evt = PluginHostEventMessage::Error {
                                instance_id: Some(instance_id),
                                message: format!("Plugin path not found: {plugin_path}"),
                            };
                            if let Ok(json) = serde_json::to_string(&evt) {
                                println!("{json}");
                            }
                            continue;
                        }

                        if !loaded_instances.contains_key(&instance_id) {
                            let name = path
                                .file_stem()
                                .and_then(|s| s.to_str())
                                .unwrap_or("Unknown")
                                .to_string();
                            let descriptor = PluginDescriptor::new(
                                name,
                                "Unknown Vendor",
                                PluginFormat::VST3,
                                PluginCategory::Effect,
                                path,
                            );
                            match Vst3Instance::load(descriptor) {
                                Ok(mut inst) => {
                                    if let Err(e) =
                                        inst.activate(sample_rate, max_block_size as usize)
                                    {
                                        log::error!(
                                            "[plugin_host_daemon] activate failed: {} — {}",
                                            instance_id, e
                                        );
                                    }
                                    let latency = inst.latency_samples();
                                    let editor = inst.supports_editor();
                                    loaded_instances.insert(instance_id, Box::new(inst));
                                    let evt = PluginHostEventMessage::Loaded {
                                        instance_id,
                                        latency_samples: latency,
                                        supports_editor: editor,
                                    };
                                    if let Ok(json) = serde_json::to_string(&evt) {
                                        println!("{json}");
                                    }
                                }
                                Err(e) => {
                                    log::error!(
                                        "[plugin_host_daemon] load failed: {} — {}",
                                        instance_id, e
                                    );
                                    let evt = PluginHostEventMessage::Error {
                                        instance_id: Some(instance_id),
                                        message: format!("Plugin load failed: {e}"),
                                    };
                                    if let Ok(json) = serde_json::to_string(&evt) {
                                        println!("{json}");
                                    }
                                }
                            }
                        }
                    }
                    PluginHostControlMessage::UnloadPlugin { instance_id } => {
                        if let Some(mut inst) = loaded_instances.remove(&instance_id) {
                            let _ = inst.deactivate();
                        }
                        pending_midi.remove(&instance_id);
                    }
                    PluginHostControlMessage::SetParameter {
                        instance_id: _,
                        index,
                        value,
                    } => {
                        if index == 0 {
                            output_gain = value.clamp(0.0, 2.0) as f32;
                        }
                    }
                    PluginHostControlMessage::OpenEditor { instance_id } => {
                        let evt = PluginHostEventMessage::EditorOpened { instance_id };
                        if let Ok(json) = serde_json::to_string(&evt) {
                            println!("{json}");
                        }
                    }
                    PluginHostControlMessage::CloseEditor { instance_id } => {
                        let evt = PluginHostEventMessage::EditorClosed { instance_id };
                        if let Ok(json) = serde_json::to_string(&evt) {
                            println!("{json}");
                        }
                    }
                    PluginHostControlMessage::Heartbeat { seq } => {
                        last_heartbeat = Instant::now();
                        let evt = PluginHostEventMessage::HeartbeatAck { seq };
                        if let Ok(json) = serde_json::to_string(&evt) {
                            println!("{json}");
                        }
                    }
                    PluginHostControlMessage::SendMidiEvents {
                        instance_id,
                        events,
                    } => {
                        // Overflow MIDI from IPC (inline events come via shared mem header).
                        let midi_events: Vec<MidiEvent> = events
                            .iter()
                            .map(|(offset, ch, data)| MidiEvent {
                                sample_offset: *offset,
                                channel: *ch,
                                data: *data,
                            })
                            .collect();
                        pending_midi
                            .entry(instance_id)
                            .or_default()
                            .extend(midi_events);
                    }
                    // ── LAZARUS PROTOCOL: Save/Restore State ────────────────
                    PluginHostControlMessage::SaveState { instance_id } => {
                        // Attempt to get plugin state as raw bytes.
                        // For now, VST3 state serialization is not yet
                        // exposed via the PluginInstance trait — emit an
                        // empty blob so the protocol handshake works.
                        // TODO: Wire Vst3Instance::save_preset_data()
                        let state_blob_b64 = if let Some(_plugin) = loaded_instances.get(&instance_id) {
                            // Placeholder: real implementation would call plugin.save_state()
                            use std::io::Write;
                            let mut buf = Vec::new();
                            let _ = write!(buf, "lazarus_placeholder_state");
                            // base64-encode for IPC transport
                            let encoded: String = buf.iter()
                                .map(|b| format!("{:02x}", b))
                                .collect();
                            encoded
                        } else {
                            String::new()
                        };
                        let evt = PluginHostEventMessage::StateSaved {
                            instance_id,
                            state_blob_b64,
                        };
                        if let Ok(json) = serde_json::to_string(&evt) {
                            println!("{json}");
                        }
                    }
                    PluginHostControlMessage::RestoreState {
                        instance_id,
                        state_blob_b64,
                    } => {
                        // TODO: Wire Vst3Instance::load_preset_data()
                        // For now, log the restore attempt — the state blob
                        // will be used when VST3 state serialization is exposed.
                        if loaded_instances.contains_key(&instance_id) {
                            log::info!(
                                "[plugin_host_daemon][Lazarus] Restore state for {} ({} bytes)",
                                instance_id,
                                state_blob_b64.len()
                            );
                        } else {
                            log::warn!(
                                "[plugin_host_daemon][Lazarus] Cannot restore state — instance {} not loaded",
                                instance_id
                            );
                        }
                    }
                    PluginHostControlMessage::Shutdown => {
                        running.store(false, Ordering::Relaxed);
                    }
                },
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    running.store(false, Ordering::Relaxed);
                    break;
                }
            }
        }

        // ── Orphan protection ───────────────────────────────────────────
        if last_heartbeat.elapsed() > ORPHAN_TIMEOUT {
            log::warn!(
                "[plugin_host_daemon] no heartbeat for {:?}, self-terminating",
                ORPHAN_TIMEOUT
            );
            break;
        }

        // ── Heartbeat file update ───────────────────────────────────────
        if let Err(err) = fs::write(
            &args.heartbeat_file,
            format!("{:?}", std::time::SystemTime::now()),
        ) {
            log::warn!(
                "[plugin_host_daemon] heartbeat write failed (instance={}): {}",
                args.instance_id,
                err
            );
        }

        // ── Audio processing via shared memory ─────────────────────────
        if let Some(region) = shared_region.as_mut() {
            // Check for new work from the host via atomic request_seq.
            let current_seq = region.request_seq();
            if current_seq == last_seen_seq || current_seq == 0 {
                // No new work — brief sleep to avoid busy-wait.
                thread::sleep(IDLE_SLEEP);
                continue;
            }
            last_seen_seq = current_seq;

            let num_frames = region.requested_frames() as usize;
            if num_frames == 0 || num_frames > args.max_frames as usize {
                thread::sleep(IDLE_SLEEP);
                continue;
            }

            // Read inline MIDI from shared memory header.
            let mut all_midi: Vec<MidiEvent> = region
                .read_midi_events()
                .iter()
                .map(|ie| MidiEvent {
                    sample_offset: ie.sample_offset,
                    channel: ie.channel,
                    data: ie.data,
                })
                .collect();
            region.clear_midi_events();

            // Merge with overflow MIDI from IPC channel.
            if let Some(overflow) = pending_midi.remove(&daemon_instance_id) {
                all_midi.extend(overflow);
            }

            // Process through plugin or passthrough.
            if let Some(plugin) = loaded_instances.get_mut(&daemon_instance_id) {
                process_audio_block(
                    region,
                    plugin.as_mut(),
                    num_frames,
                    &all_midi,
                    output_gain,
                    args.num_inputs,
                    args.num_outputs,
                );
            } else {
                process_passthrough(region, num_frames, args.num_inputs, args.num_outputs);
            }

            // Signal completion to host via atomic processed_seq.
            region.set_processed_seq(current_seq);
        } else {
            // No shared region — sleep to avoid busy-wait.
            thread::sleep(Duration::from_millis(10));
        }
    }

    log::info!(
        "[plugin_host_daemon] shutdown instance={}",
        args.instance_id
    );
}
