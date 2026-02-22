// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — VST2 Timeout / Stress Test
// ═══════════════════════════════════════════════════════════════════════════
//
// Loads multiple VST2 plugins sequentially with configurable timeout per
// plugin. Each plugin is activated, processes 5 buffers, deactivated, and
// closed. Reports timing and any failures.
//
// Usage:
//   cargo run -p dream_plugins --example test_vst2_timeout
//
//   # With custom timeout (in seconds):
//   VST2_TIMEOUT_SECS=10 cargo run -p dream_plugins --example test_vst2_timeout
//
//   # Test specific plugins only (comma-separated paths):
//   VST2_PLUGINS="/path/to/a.vst,/path/to/b.vst" \
//     cargo run -p dream_plugins --example test_vst2_timeout
//
// ═══════════════════════════════════════════════════════════════════════════

use std::path::Path;
use std::time::{Duration, Instant};

use dream_plugins::format::PluginFormat;
use dream_plugins::instance::PluginInstance;
use dream_plugins::scanner::PluginScanner;
use dream_plugins::vst2_host::Vst2Instance;

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn"))
        .format_timestamp_millis()
        .init();

    let timeout_secs: u64 = std::env::var("VST2_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);
    let timeout = Duration::from_secs(timeout_secs);

    println!("═══════════════════════════════════════════════════════════");
    println!("  Dream DAW — VST2 Timeout / Stress Test");
    println!("  Timeout per plugin: {}s", timeout_secs);
    println!("═══════════════════════════════════════════════════════════");
    println!();

    // Determine plugin list
    let plugins: Vec<String> = if let Ok(list) = std::env::var("VST2_PLUGINS") {
        list.split(',').map(|s| s.trim().to_string()).collect()
    } else {
        // Auto-discover all VST2 plugins
        let scanner = PluginScanner::new();
        let descs = scanner.scan_format(PluginFormat::VST2);
        descs
            .iter()
            .map(|d| d.path.to_string_lossy().to_string())
            .collect()
    };

    println!("[1] Testing {} plugins...", plugins.len());
    println!();

    let sample_rate = 44100.0;
    let buffer_size = 512;
    let num_blocks = 5;

    let mut results: Vec<(String, &str, Duration)> = Vec::new();

    for (idx, plugin_path) in plugins.iter().enumerate() {
        let path = Path::new(plugin_path);
        let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("???");

        if !path.exists() {
            println!("  {:3}. SKIP  {:40} (not found)", idx + 1, name);
            results.push((name.to_string(), "SKIP", Duration::ZERO));
            continue;
        }

        let plugin_start = Instant::now();

        // Phase 1: Load
        let mut instance = match Vst2Instance::load(path) {
            Ok(inst) => inst,
            Err(e) => {
                let elapsed = plugin_start.elapsed();
                println!(
                    "  {:3}. FAIL  {:40} | load error: {} ({:?})",
                    idx + 1,
                    name,
                    e,
                    elapsed
                );
                results.push((name.to_string(), "FAIL", elapsed));
                continue;
            }
        };

        // Check timeout after load
        if plugin_start.elapsed() > timeout {
            println!(
                "  {:3}. TIMEOUT {:38} | load took {:?}",
                idx + 1,
                name,
                plugin_start.elapsed()
            );
            results.push((name.to_string(), "TIMEOUT", plugin_start.elapsed()));
            continue;
        }

        // Phase 2: Activate
        if let Err(e) = instance.activate(sample_rate, buffer_size) {
            let elapsed = plugin_start.elapsed();
            println!(
                "  {:3}. FAIL  {:40} | activate error: {} ({:?})",
                idx + 1,
                name,
                e,
                elapsed
            );
            results.push((name.to_string(), "FAIL", elapsed));
            continue;
        }

        // Phase 3: Process N blocks
        let mut process_ok = true;
        for _ in 0..num_blocks {
            if plugin_start.elapsed() > timeout {
                process_ok = false;
                break;
            }

            let num_inputs = instance.descriptor().audio_inputs as usize;
            let num_outputs = instance.descriptor().audio_outputs as usize;

            let input_data: Vec<Vec<f32>> = (0..num_inputs.max(1))
                .map(|_| vec![0.1f32; buffer_size])
                .collect();
            let mut output_data: Vec<Vec<f32>> = (0..num_outputs.max(1))
                .map(|_| vec![0.0f32; buffer_size])
                .collect();

            let input_refs: Vec<&[f32]> = input_data.iter().map(|v| v.as_slice()).collect();
            let mut output_refs: Vec<&mut [f32]> =
                output_data.iter_mut().map(|v| v.as_mut_slice()).collect();

            if let Err(e) = instance.process(&input_refs, &mut output_refs, buffer_size, &[]) {
                println!("  {:3}. FAIL  {:40} | process error: {}", idx + 1, name, e);
                process_ok = false;
                break;
            }
        }

        // Phase 4: Deactivate + close
        let _ = instance.deactivate();
        drop(instance);

        let elapsed = plugin_start.elapsed();

        if !process_ok {
            if elapsed > timeout {
                println!("  {:3}. TIMEOUT {:38} | {:?}", idx + 1, name, elapsed);
                results.push((name.to_string(), "TIMEOUT", elapsed));
            } else {
                results.push((name.to_string(), "FAIL", elapsed));
            }
        } else {
            println!("  {:3}. ✓ PASS  {:40} | {:?}", idx + 1, name, elapsed);
            results.push((name.to_string(), "PASS", elapsed));
        }
    }

    // Summary
    let pass = results.iter().filter(|r| r.1 == "PASS").count();
    let fail = results.iter().filter(|r| r.1 == "FAIL").count();
    let timeouts = results.iter().filter(|r| r.1 == "TIMEOUT").count();
    let skips = results.iter().filter(|r| r.1 == "SKIP").count();

    let max_time = results.iter().map(|r| r.2).max().unwrap_or(Duration::ZERO);
    let avg_time = if pass > 0 {
        let total: Duration = results.iter().filter(|r| r.1 == "PASS").map(|r| r.2).sum();
        total / pass as u32
    } else {
        Duration::ZERO
    };

    println!();
    println!("═══════════════════════════════════════════════════════════");
    println!("  STRESS TEST RESULTS:");
    println!("    Total:    {}", results.len());
    println!("    Passed:   {}", pass);
    println!("    Failed:   {}", fail);
    println!("    Timeouts: {}", timeouts);
    println!("    Skipped:  {}", skips);
    println!("    Slowest:  {:?}", max_time);
    println!("    Average:  {:?} (passing only)", avg_time);
    println!("═══════════════════════════════════════════════════════════");

    if fail > 0 || timeouts > 0 {
        std::process::exit(1);
    }
}
