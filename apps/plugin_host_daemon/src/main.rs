use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::mpsc::{self, TryRecvError};
use std::thread;
use std::time::Duration;

use dream_plugins::sandbox_ipc::{PluginHostControlMessage, PluginHostEventMessage};
use memmap2::MmapMut;
use uuid::Uuid;

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
    let instance_id = instance_id.ok_or_else(|| "Missing --instance-id".to_string())?;
    let plugin_path = plugin_path.ok_or_else(|| "Missing --plugin-path".to_string())?;
    let heartbeat_file = heartbeat_file.ok_or_else(|| "Missing --heartbeat-file".to_string())?;
    let num_inputs = num_inputs.unwrap_or(2);
    let num_outputs = num_outputs.unwrap_or(2);
    let max_frames = max_frames.unwrap_or(2048);

    Ok(Args {
        instance_id,
        plugin_path,
        heartbeat_file,
        shared_region_file,
        num_inputs,
        num_outputs,
        max_frames,
    })
}

fn open_shared_region(path: &PathBuf) -> Option<MmapMut> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .ok()?;
    unsafe { MmapMut::map_mut(&file).ok() }
}

fn process_passthrough(mmap: &mut MmapMut, num_inputs: u16, num_outputs: u16, max_frames: u32) {
    let header_bytes = 64usize;
    let stride = max_frames as usize * std::mem::size_of::<f32>();
    let total_needed = header_bytes + (num_inputs as usize + num_outputs as usize) * stride;
    if mmap.len() < total_needed || stride == 0 {
        return;
    }

    // Copy input channels to outputs (or silence when no matching input exists).
    for out_idx in 0..num_outputs as usize {
        let out_off = header_bytes + (num_inputs as usize + out_idx) * stride;
        let out_end = out_off + stride;
        if out_end > mmap.len() {
            continue;
        }
        if out_idx < num_inputs as usize {
            let in_off = header_bytes + out_idx * stride;
            let in_end = in_off + stride;
            if in_end <= mmap.len() {
                // Input/output ranges are non-overlapping in this layout.
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        mmap.as_ptr().add(in_off),
                        mmap.as_mut_ptr().add(out_off),
                        stride,
                    );
                }
            }
        } else {
            mmap[out_off..out_end].fill(0);
        }
    }
}

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
    let mut shared_mmap = args
        .shared_region_file
        .as_ref()
        .and_then(open_shared_region);
    if shared_mmap.is_some() {
        log::info!("[plugin_host_daemon] shared region attached");
    }

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
                    if cmd_tx.send(cmd).is_err() {
                        break;
                    }
                }
                Err(err) => {
                    log::warn!("[plugin_host_daemon] invalid control message: {err}");
                }
            }
        }
    });

    let mut running = true;
    let mut loaded_instances: Vec<Uuid> = Vec::new();
    let mut output_gain: f32 = 1.0;

    // Current phase: watchdog heartbeat + process isolation shell.
    // Audio/data bridge will be attached over shared memory in next iteration.
    while running {
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
                        plugin_path: _,
                        sample_rate: _,
                        max_block_size: _,
                    } => {
                        if !loaded_instances.contains(&instance_id) {
                            loaded_instances.push(instance_id);
                        }
                    }
                    PluginHostControlMessage::UnloadPlugin { instance_id } => {
                        loaded_instances.retain(|id| *id != instance_id);
                    }
                    PluginHostControlMessage::SetParameter {
                        instance_id: _,
                        index,
                        value,
                    } => {
                        // Basic bridge: Param0 drives output gain in daemon.
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
                        let evt = PluginHostEventMessage::HeartbeatAck { seq };
                        if let Ok(json) = serde_json::to_string(&evt) {
                            println!("{json}");
                        }
                    }
                    PluginHostControlMessage::SendMidiEvents {
                        instance_id,
                        events,
                    } => {
                        // Store pending MIDI events for the next process cycle.
                        // The daemon's shared-memory process loop will convert
                        // these to format-specific events when driving the plugin.
                        log::debug!(
                            "[plugin_host_daemon] received {} MIDI events for instance {}",
                            events.len(),
                            instance_id
                        );
                        // Phase 1: MIDI events stored but not yet consumed by daemon
                        // process loop (daemon runs as passthrough stub currently).
                        // Full integration happens in Phase 2 when the daemon's
                        // process loop calls PluginInstance::process() with real events.
                        let _ = (instance_id, events);
                    }
                    PluginHostControlMessage::Shutdown => {
                        running = false;
                    }
                },
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    running = false;
                    break;
                }
            }
        }

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
        if let Some(mmap) = shared_mmap.as_mut()
            && !mmap.is_empty()
        {
            process_passthrough(mmap, args.num_inputs, args.num_outputs, args.max_frames);
            if (output_gain - 1.0).abs() > f32::EPSILON {
                // Apply gain to output channels in-place.
                let header_bytes = 64usize;
                let stride = args.max_frames as usize * std::mem::size_of::<f32>();
                for out_idx in 0..args.num_outputs as usize {
                    let out_off = header_bytes + (args.num_inputs as usize + out_idx) * stride;
                    let out_end = out_off + stride;
                    if out_end > mmap.len() {
                        continue;
                    }
                    let slice = &mut mmap[out_off..out_end];
                    let samples: &mut [f32] = bytemuck::cast_slice_mut(slice);
                    for s in samples.iter_mut() {
                        *s *= output_gain;
                    }
                }
            }
            mmap[0] = mmap[0].wrapping_add(1);
            let _ = mmap.flush_async();
        }
        thread::sleep(Duration::from_millis(25));
    }
    log::info!(
        "[plugin_host_daemon] shutdown instance={}",
        args.instance_id
    );
}
