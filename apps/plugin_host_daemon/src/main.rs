use std::fs;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use memmap2::MmapMut;

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
    let file = std::fs::OpenOptions::new().read(true).write(true).open(path).ok()?;
    unsafe { MmapMut::map_mut(&file).ok() }
}

fn process_passthrough(
    mmap: &mut MmapMut,
    num_inputs: u16,
    num_outputs: u16,
    max_frames: u32,
) {
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

    // Current phase: watchdog heartbeat + process isolation shell.
    // Audio/data bridge will be attached over shared memory in next iteration.
    loop {
        if let Err(err) = fs::write(&args.heartbeat_file, format!("{:?}", std::time::SystemTime::now())) {
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
            mmap[0] = mmap[0].wrapping_add(1);
            let _ = mmap.flush_async();
        }
        thread::sleep(Duration::from_millis(25));
    }
}
