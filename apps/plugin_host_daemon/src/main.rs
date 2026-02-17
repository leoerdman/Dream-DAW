use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::mpsc::{self, TryRecvError};
use std::thread;
use std::time::Duration;

use dream_plugins::descriptor::PluginDescriptor;
use dream_plugins::format::{PluginCategory, PluginFormat};
use dream_plugins::instance::{MidiEvent, PluginInstance};
use dream_plugins::sandbox_ipc::{PluginHostControlMessage, PluginHostEventMessage};
use dream_plugins::vst3_host::Vst3Instance;
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

    // Parse instance_id as Uuid for HashMap lookups.
    let daemon_instance_id: Uuid = args.instance_id.parse().unwrap_or_else(|_| Uuid::new_v4());

    let mut running = true;
    let mut loaded_instances: HashMap<Uuid, Box<dyn PluginInstance>> = HashMap::new();
    let mut pending_midi: HashMap<Uuid, Vec<MidiEvent>> = HashMap::new();
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
                        plugin_path,
                        sample_rate,
                        max_block_size,
                    } => {
                        // Bug 60: validate plugin path before attempting load
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
                                    if let Err(e) = inst.activate(sample_rate, max_block_size as usize) {
                                        log::error!(
                                            "[plugin_host_daemon] activate failed for {}: {}",
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
                                        "[plugin_host_daemon] load failed for {}: {}",
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
                        let midi_events: Vec<MidiEvent> = events
                            .iter()
                            .map(|(offset, _ch, data)| MidiEvent {
                                sample_offset: *offset,
                                channel: 0,
                                data: *data,
                            })
                            .collect();
                        pending_midi
                            .entry(instance_id)
                            .or_default()
                            .extend(midi_events);
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
            // Determine number of frames requested from the shared header.
            let num_frames = args.max_frames as usize;
            let header_bytes = 64usize;
            let stride = num_frames * std::mem::size_of::<f32>();

            // Collect the first loaded instance for processing.
            // (daemon runs one plugin per process — keyed by args.instance_id)
            let inst = loaded_instances.get_mut(&daemon_instance_id);
            let midi = pending_midi.remove(&daemon_instance_id).unwrap_or_default();

            if let Some(plugin) = inst {
                // Read inputs from shared memory into temp buffers.
                let mut input_bufs: Vec<Vec<f32>> = Vec::with_capacity(args.num_inputs as usize);
                for ch in 0..args.num_inputs as usize {
                    let off = header_bytes + ch * stride;
                    let end = off + stride;
                    if end <= mmap.len() {
                        let slice = &mmap[off..end];
                        let samples: &[f32] = bytemuck::cast_slice(slice);
                        input_bufs.push(samples[..num_frames].to_vec());
                    } else {
                        input_bufs.push(vec![0.0; num_frames]);
                    }
                }
                let input_refs: Vec<&[f32]> = input_bufs.iter().map(|b| b.as_slice()).collect();

                // Prepare output buffers.
                let mut output_bufs: Vec<Vec<f32>> = (0..args.num_outputs as usize)
                    .map(|_| vec![0.0; num_frames])
                    .collect();
                let mut output_slices: Vec<&mut [f32]> = output_bufs
                    .iter_mut()
                    .map(|b| b.as_mut_slice())
                    .collect();

                // Process through the actual plugin.
                let _ = plugin.process(&input_refs, &mut output_slices, num_frames, &midi);

                // Write outputs back to shared memory.
                for (ch, out) in output_bufs.iter().enumerate() {
                    let out_off = header_bytes + (args.num_inputs as usize + ch) * stride;
                    let out_end = out_off + stride;
                    if out_end <= mmap.len() {
                        let dest: &mut [f32] = bytemuck::cast_slice_mut(&mut mmap[out_off..out_end]);
                        dest[..num_frames].copy_from_slice(&out[..num_frames]);
                    }
                }
            } else {
                // No loaded plugin — fallback to passthrough.
                process_passthrough(mmap, args.num_inputs, args.num_outputs, args.max_frames);
            }

            if (output_gain - 1.0).abs() > f32::EPSILON {
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
