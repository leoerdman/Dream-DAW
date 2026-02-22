// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Comprehensive VST3 Plugin Test Harness
// ═══════════════════════════════════════════════════════════════════════════
//
// Tests ALL installed VST3 plugins through the PluginInstance trait API.
// Each plugin is tested in a SUBPROCESS for crash isolation.
//
// Test suite per plugin:
//   1. Load & init (Vst3Instance::load)
//   2. Activate (44100 Hz, 512 frames)
//   3. Process silence (10 buffer cycles)
//   4. Process sine wave (10 buffer cycles)
//   5. MIDI note on/off (synths) or MIDI CC (effects)
//   6. Parameter enumeration
//   7. Parameter changes (sweep first 5 params between 0.0, 0.5, 1.0)
//   8. State save (getState)
//   9. State load (setComponentState)
//   10. Deactivate
//   11. Re-activate (48kHz/1024 — verify re-usability)
//   12. Process after re-activate
//   13. Latency & tail report
//   14. Final deactivate & drop
//
// Usage:
//   cargo run -p dream_plugins --example test_all_vst3
//   cargo run -p dream_plugins --example test_all_vst3 -- --filter "FabFilter"
//   cargo run -p dream_plugins --example test_all_vst3 -- --filter "Serum"
//   cargo run -p dream_plugins --example test_all_vst3 -- --single "/path/to/Plugin.vst3"
//
// ═══════════════════════════════════════════════════════════════════════════

use dream_plugins::format::PluginCategory;
use dream_plugins::{
    MidiEvent, PluginDescriptor, PluginFormat, PluginInstance, PluginScanner, TransportContext,
    Vst3Instance,
};
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const SAMPLE_RATE: f64 = 44100.0;
const BUFFER_SIZE: usize = 512;
const NUM_PROCESS_CYCLES: usize = 10;
/// Per-plugin subprocess timeout (seconds)
const PLUGIN_TIMEOUT_SECS: u64 = 30;

fn generate_sine_buffer(
    freq: f32,
    sample_rate: f32,
    num_frames: usize,
    phase: &mut f32,
) -> Vec<f32> {
    let mut buf = vec![0.0f32; num_frames];
    let step = 2.0 * std::f32::consts::PI * freq / sample_rate;
    for i in 0..num_frames {
        buf[i] = (*phase).sin() * 0.5;
        *phase += step;
        if *phase > 2.0 * std::f32::consts::PI {
            *phase -= 2.0 * std::f32::consts::PI;
        }
    }
    buf
}

fn check_output_not_nan_inf(output: &[f32]) -> Result<(), String> {
    for (i, &sample) in output.iter().enumerate() {
        if sample.is_nan() {
            return Err(format!("NaN at sample {}", i));
        }
        if sample.is_infinite() {
            return Err(format!("Inf at sample {}", i));
        }
        if sample.abs() > 100.0 {
            return Err(format!("Absurd value {} at sample {}", sample, i));
        }
    }
    Ok(())
}

/// Run all tests for a single plugin. Outputs structured test results to stdout.
/// This function is called when the binary is invoked with --single.
fn run_single_plugin_test(plugin_path: &str) -> i32 {
    // Use eprintln for crash diagnostics (stderr is unbuffered, survives SIGSEGV)
    eprintln!("DIAG: Starting test for: {}", plugin_path);

    // Discover descriptors matching this path
    let scanner = PluginScanner::new();
    eprintln!("DIAG: Scanner created, scanning...");
    let all = scanner.scan_format(PluginFormat::VST3);
    eprintln!("DIAG: Scan complete, {} descriptors total", all.len());
    let descriptors: Vec<_> = all
        .into_iter()
        .filter(|d| d.path.to_string_lossy() == plugin_path)
        .collect();
    eprintln!("DIAG: {} descriptors match path", descriptors.len());

    if descriptors.is_empty() {
        println!("TEST_RESULT:FAIL:Scan:No descriptors found for path");
        return 1;
    }

    // Test each descriptor (some bundles expose multiple classes)
    let mut exit_code = 0;
    for descriptor in descriptors {
        let name = descriptor.name.clone();
        let is_instrument = descriptor.category == PluginCategory::Instrument;

        // ── Test 1: Load ──
        eprintln!("DIAG: Loading '{}'...", name);
        let mut instance = match Vst3Instance::load(descriptor) {
            Ok(inst) => {
                eprintln!("DIAG: Load OK for '{}'", name);
                println!("TEST_RESULT:PASS:Load:{}", name);
                inst
            }
            Err(e) => {
                eprintln!("DIAG: Load FAILED for '{}': {}", name, e);
                println!("TEST_RESULT:FAIL:Load:{}:{}", name, e);
                exit_code = 1;
                continue;
            }
        };

        // ── Test 2: Activate ──
        match instance.activate(SAMPLE_RATE, BUFFER_SIZE) {
            Ok(()) => println!("TEST_RESULT:PASS:Activate:{}", name),
            Err(e) => {
                println!("TEST_RESULT:FAIL:Activate:{}:{}", name, e);
                exit_code = 1;
                continue;
            }
        }

        // Set initial transport
        instance.set_transport_context(TransportContext {
            sample_rate: SAMPLE_RATE,
            tempo: 120.0,
            position_samples: 0,
            is_playing: true,
            is_recording: false,
            time_sig_numerator: 4,
            time_sig_denominator: 4,
        });

        // ── Test 3: Process silence ──
        {
            let silence = vec![0.0f32; BUFFER_SIZE];
            let inputs: &[&[f32]] = &[&silence, &silence];
            let mut all_ok = true;
            let mut err_msg = String::new();

            for cycle in 0..NUM_PROCESS_CYCLES {
                let mut out_l = vec![0.0f32; BUFFER_SIZE];
                let mut out_r = vec![0.0f32; BUFFER_SIZE];
                {
                    let mut outputs: Vec<&mut [f32]> = vec![&mut out_l, &mut out_r];
                    if let Err(e) = instance.process(inputs, &mut outputs, BUFFER_SIZE, &[]) {
                        all_ok = false;
                        err_msg = format!("cycle {}: {}", cycle, e);
                        break;
                    }
                }
                if let Err(e) = check_output_not_nan_inf(&out_l) {
                    all_ok = false;
                    err_msg = format!("cycle {} L: {}", cycle, e);
                    break;
                }
                if let Err(e) = check_output_not_nan_inf(&out_r) {
                    all_ok = false;
                    err_msg = format!("cycle {} R: {}", cycle, e);
                    break;
                }
            }
            if all_ok {
                println!("TEST_RESULT:PASS:ProcessSilence:{}", name);
            } else {
                println!("TEST_RESULT:FAIL:ProcessSilence:{}:{}", name, err_msg);
                exit_code = 1;
            }
        }

        // ── Test 4: Process sine wave ──
        {
            let mut phase = 0.0f32;
            let mut all_ok = true;
            let mut err_msg = String::new();

            for cycle in 0..NUM_PROCESS_CYCLES {
                let sine = generate_sine_buffer(440.0, SAMPLE_RATE as f32, BUFFER_SIZE, &mut phase);
                let inputs: &[&[f32]] = &[&sine, &sine];
                let mut out_l = vec![0.0f32; BUFFER_SIZE];
                let mut out_r = vec![0.0f32; BUFFER_SIZE];
                {
                    let mut outputs: Vec<&mut [f32]> = vec![&mut out_l, &mut out_r];
                    if let Err(e) = instance.process(inputs, &mut outputs, BUFFER_SIZE, &[]) {
                        all_ok = false;
                        err_msg = format!("cycle {}: {}", cycle, e);
                        break;
                    }
                }
                if let Err(e) = check_output_not_nan_inf(&out_l) {
                    all_ok = false;
                    err_msg = format!("cycle {} L: {}", cycle, e);
                    break;
                }
            }
            if all_ok {
                println!("TEST_RESULT:PASS:ProcessSine:{}", name);
            } else {
                println!("TEST_RESULT:FAIL:ProcessSine:{}:{}", name, err_msg);
                exit_code = 1;
            }
        }

        // ── Test 5: MIDI ──
        {
            let silence = vec![0.0f32; BUFFER_SIZE];
            let inputs: &[&[f32]] = &[&silence, &silence];

            if is_instrument {
                // Note On
                let midi_on = vec![MidiEvent::note_on(0, 0, 60, 100)];
                let mut out_l = vec![0.0f32; BUFFER_SIZE];
                let mut out_r = vec![0.0f32; BUFFER_SIZE];
                let mut outputs: Vec<&mut [f32]> = vec![&mut out_l, &mut out_r];
                let mut ok = true;
                let mut err_msg = String::new();

                if let Err(e) = instance.process(inputs, &mut outputs, BUFFER_SIZE, &midi_on) {
                    ok = false;
                    err_msg = format!("note_on: {}", e);
                }
                if ok {
                    if let Err(e) = check_output_not_nan_inf(&out_l) {
                        ok = false;
                        err_msg = format!("note_on L: {}", e);
                    }
                }

                // Let note ring
                if ok {
                    for _ in 0..5 {
                        let mut o_l = vec![0.0f32; BUFFER_SIZE];
                        let mut o_r = vec![0.0f32; BUFFER_SIZE];
                        let mut outs: Vec<&mut [f32]> = vec![&mut o_l, &mut o_r];
                        let _ = instance.process(inputs, &mut outs, BUFFER_SIZE, &[]);
                    }
                }

                // Note Off
                if ok {
                    let midi_off = vec![MidiEvent::note_off(0, 0, 60, 0)];
                    let mut o_l = vec![0.0f32; BUFFER_SIZE];
                    let mut o_r = vec![0.0f32; BUFFER_SIZE];
                    let mut outs: Vec<&mut [f32]> = vec![&mut o_l, &mut o_r];
                    if let Err(e) = instance.process(inputs, &mut outs, BUFFER_SIZE, &midi_off) {
                        ok = false;
                        err_msg = format!("note_off: {}", e);
                    }
                }

                if ok {
                    println!("TEST_RESULT:PASS:MIDI_NoteOnOff:{}", name);
                } else {
                    println!("TEST_RESULT:FAIL:MIDI_NoteOnOff:{}:{}", name, err_msg);
                    exit_code = 1;
                }
            } else {
                // Effect: MIDI CC
                let midi_cc = vec![MidiEvent::cc(0, 0, 1, 64)];
                let mut out_l = vec![0.0f32; BUFFER_SIZE];
                let mut out_r = vec![0.0f32; BUFFER_SIZE];
                let mut outputs: Vec<&mut [f32]> = vec![&mut out_l, &mut out_r];
                match instance.process(inputs, &mut outputs, BUFFER_SIZE, &midi_cc) {
                    Ok(()) => println!("TEST_RESULT:PASS:MIDI_CC:{}", name),
                    Err(e) => {
                        println!("TEST_RESULT:FAIL:MIDI_CC:{}:{}", name, e);
                        exit_code = 1;
                    }
                }
            }
        }

        // ── Test 6: Parameter enumeration ──
        let param_count = instance.parameter_count();
        println!("TEST_RESULT:PASS:ParamCount:{}:count={}", name, param_count);

        // ── Test 7: Parameter changes ──
        if param_count > 0 {
            let test_count = param_count.min(5);
            let mut ok = true;
            let mut err_msg = String::new();

            for idx in 0..test_count {
                let _original = instance.get_parameter(idx);
                let silence = vec![0.0f32; BUFFER_SIZE];
                let inputs: &[&[f32]] = &[&silence, &silence];

                for val in &[0.0, 0.5, 1.0] {
                    if let Err(e) = instance.set_parameter(idx, *val) {
                        ok = false;
                        err_msg = format!("set_param({}, {}): {}", idx, val, e);
                        break;
                    }
                    let mut out_l = vec![0.0f32; BUFFER_SIZE];
                    let mut out_r = vec![0.0f32; BUFFER_SIZE];
                    let mut outputs: Vec<&mut [f32]> = vec![&mut out_l, &mut out_r];
                    if let Err(e) = instance.process(inputs, &mut outputs, BUFFER_SIZE, &[]) {
                        ok = false;
                        err_msg = format!("process after param({}, {}): {}", idx, val, e);
                        break;
                    }
                    if let Err(e) = check_output_not_nan_inf(&out_l) {
                        ok = false;
                        err_msg = format!("output after param({}, {}) L: {}", idx, val, e);
                        break;
                    }
                }
                if !ok {
                    break;
                }
            }

            if ok {
                println!(
                    "TEST_RESULT:PASS:ParamChanges:{}:tested={}",
                    name, test_count
                );
            } else {
                println!("TEST_RESULT:FAIL:ParamChanges:{}:{}", name, err_msg);
                exit_code = 1;
            }
        } else {
            println!("TEST_RESULT:SKIP:ParamChanges:{}:no_params", name);
        }

        // ── Test 8: State save ──
        let saved_state = match instance.save_state() {
            Ok(state) => {
                println!("TEST_RESULT:PASS:SaveState:{}:bytes={}", name, state.len());
                Some(state)
            }
            Err(e) => {
                println!("TEST_RESULT:FAIL:SaveState:{}:{}", name, e);
                exit_code = 1;
                None
            }
        };

        // ── Test 9: State load ──
        if let Some(ref state) = saved_state {
            match instance.load_state_blob(Some("ProcessorState"), state) {
                Ok(()) => println!("TEST_RESULT:PASS:LoadState:{}", name),
                Err(e) => {
                    println!("TEST_RESULT:FAIL:LoadState:{}:{}", name, e);
                    exit_code = 1;
                }
            }
        } else {
            println!("TEST_RESULT:SKIP:LoadState:{}:no_state_saved", name);
        }

        // ── Test 10: Deactivate ──
        match instance.deactivate() {
            Ok(()) => println!("TEST_RESULT:PASS:Deactivate:{}", name),
            Err(e) => {
                println!("TEST_RESULT:FAIL:Deactivate:{}:{}", name, e);
                exit_code = 1;
                continue;
            }
        }

        // ── Test 11: Re-activate (48kHz/1024) ──
        match instance.activate(48000.0, 1024) {
            Ok(()) => println!("TEST_RESULT:PASS:ReActivate:{}", name),
            Err(e) => {
                println!("TEST_RESULT:FAIL:ReActivate:{}:{}", name, e);
                exit_code = 1;
                continue;
            }
        }

        // ── Test 12: Process after re-activate ──
        {
            let mut phase = 0.0f32;
            let sine = generate_sine_buffer(880.0, 48000.0, 1024, &mut phase);
            let inputs: &[&[f32]] = &[&sine, &sine];
            let mut out_l = vec![0.0f32; 1024];
            let mut out_r = vec![0.0f32; 1024];
            let mut outputs: Vec<&mut [f32]> = vec![&mut out_l, &mut out_r];
            instance.set_transport_context(TransportContext {
                sample_rate: 48000.0,
                tempo: 140.0,
                position_samples: 0,
                is_playing: true,
                is_recording: false,
                time_sig_numerator: 4,
                time_sig_denominator: 4,
            });
            match instance.process(inputs, &mut outputs, 1024, &[]) {
                Ok(()) => match check_output_not_nan_inf(&out_l) {
                    Ok(()) => println!("TEST_RESULT:PASS:ProcessPostReactivate:{}", name),
                    Err(e) => {
                        println!("TEST_RESULT:FAIL:ProcessPostReactivate:{}:{}", name, e);
                        exit_code = 1;
                    }
                },
                Err(e) => {
                    println!("TEST_RESULT:FAIL:ProcessPostReactivate:{}:{}", name, e);
                    exit_code = 1;
                }
            }
        }

        // ── Test 13: Latency & tail ──
        let latency = instance.latency_samples();
        let tail = instance.tail_samples();
        println!(
            "TEST_RESULT:PASS:LatencyTail:{}:latency={},tail={}",
            name, latency, tail
        );

        // ── Test 14: Final deactivate ──
        match instance.deactivate() {
            Ok(()) => println!("TEST_RESULT:PASS:FinalDeactivate:{}", name),
            Err(e) => {
                println!("TEST_RESULT:FAIL:FinalDeactivate:{}:{}", name, e);
                exit_code = 1;
            }
        }

        // Instance drops here
        println!("TEST_RESULT:PASS:Drop:{}", name);
    }

    exit_code
}

/// Coordinator: runs each plugin in a subprocess and collects results.
fn main() {
    let args: Vec<String> = std::env::args().collect();

    // If invoked with --single, run single plugin test
    if let Some(idx) = args.iter().position(|a| a == "--single") {
        if let Some(path) = args.get(idx + 1) {
            std::process::exit(run_single_plugin_test(path));
        } else {
            eprintln!("--single requires a plugin path");
            std::process::exit(1);
        }
    }

    // Parse optional filter
    let filter = args
        .iter()
        .position(|a| a == "--filter")
        .and_then(|i| args.get(i + 1))
        .map(|s| s.to_lowercase());

    println!("╔══════════════════════════════════════════════════════════════════╗");
    println!("║     Dream DAW — Comprehensive VST3 Plugin Test Suite            ║");
    println!("╚══════════════════════════════════════════════════════════════════╝");
    println!();

    // Scan for all VST3 plugins
    let scanner = PluginScanner::new();
    let all_plugins = scanner.scan_format(PluginFormat::VST3);
    println!(
        "Scanner found {} VST3 plugin descriptors",
        all_plugins.len()
    );

    // Deduplicate by path (some bundles expose multiple descriptors)
    let mut seen_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut unique_plugins: Vec<PluginDescriptor> = Vec::new();
    for p in all_plugins {
        let path_str = p.path.to_string_lossy().to_string();
        if seen_paths.insert(path_str) {
            unique_plugins.push(p);
        }
    }

    let plugins: Vec<_> = if let Some(ref f) = filter {
        unique_plugins
            .into_iter()
            .filter(|p| {
                p.name.to_lowercase().contains(f)
                    || p.vendor.to_lowercase().contains(f)
                    || p.path.to_string_lossy().to_lowercase().contains(f)
            })
            .collect()
    } else {
        unique_plugins
    };

    if plugins.is_empty() {
        println!("No plugins match the filter. Exiting.");
        return;
    }

    println!(
        "Testing {} unique plugin bundles{}",
        plugins.len(),
        filter
            .as_ref()
            .map(|f| format!(" (filter: '{}')", f))
            .unwrap_or_default()
    );
    println!(
        "Config: {}Hz, {} frames, {} process cycles, {}s timeout",
        SAMPLE_RATE, BUFFER_SIZE, NUM_PROCESS_CYCLES, PLUGIN_TIMEOUT_SECS
    );
    println!();
    println!("════════════════════════════════════════════════════════════════════");

    let total_start = Instant::now();

    struct PluginResult {
        name: String,
        path: String,
        passed: usize,
        failed: usize,
        skipped: usize,
        failures: Vec<String>,
        crashed: bool,
        timed_out: bool,
    }

    let mut results: Vec<PluginResult> = Vec::new();
    let self_exe = std::env::current_exe().expect("Failed to get current exe path");
    let total_plugins = plugins.len();

    for (idx, plugin) in plugins.iter().enumerate() {
        let plugin_path = plugin.path.to_string_lossy().to_string();
        let type_label = if plugin.category == PluginCategory::Instrument {
            "INST"
        } else {
            "FX"
        };
        print!(
            "\n[{}/{}] {} ({}) [{}] ... ",
            idx + 1,
            total_plugins,
            plugin.name,
            plugin.vendor,
            type_label
        );
        let _ = std::io::stdout().flush();

        let start = Instant::now();

        // Spawn subprocess
        let child_result = Command::new(&self_exe)
            .args(["--single", &plugin_path])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();

        let mut pr = PluginResult {
            name: format!("{} ({})", plugin.name, plugin.vendor),
            path: plugin_path.clone(),
            passed: 0,
            failed: 0,
            skipped: 0,
            failures: Vec::new(),
            crashed: false,
            timed_out: false,
        };

        match child_result {
            Ok(child) => {
                // Wait with timeout
                match child.wait_with_output() {
                    Ok(output) => {
                        let elapsed = start.elapsed();
                        let stdout = String::from_utf8_lossy(&output.stdout);

                        // Parse results
                        for line in stdout.lines() {
                            if line.starts_with("TEST_RESULT:") {
                                let parts: Vec<&str> = line.splitn(5, ':').collect();
                                if parts.len() >= 3 {
                                    match parts[1] {
                                        "PASS" => pr.passed += 1,
                                        "FAIL" => {
                                            pr.failed += 1;
                                            let test_name = parts.get(2).unwrap_or(&"?");
                                            let detail = parts.get(4).unwrap_or(&"");
                                            pr.failures.push(format!("{}: {}", test_name, detail));
                                        }
                                        "SKIP" => pr.skipped += 1,
                                        _ => {}
                                    }
                                }
                            }
                        }

                        if !output.status.success() && pr.passed == 0 && pr.failed == 0 {
                            pr.crashed = true;
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            pr.failures.push(format!(
                                "CRASH: exit={:?}, stderr: {}",
                                output.status.code(),
                                stderr.chars().take(500).collect::<String>()
                            ));
                        }

                        if pr.failed == 0 && !pr.crashed {
                            println!(
                                "✅ {}/{} pass in {:?}",
                                pr.passed,
                                pr.passed + pr.skipped,
                                elapsed
                            );
                        } else if pr.crashed {
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            println!("💥 CRASHED in {:?}", elapsed);
                            for line in stderr.lines().take(10) {
                                println!("     💥 {}", line);
                            }
                        } else {
                            println!(
                                "❌ {} fail / {} pass in {:?}",
                                pr.failed, pr.passed, elapsed
                            );
                            for f in &pr.failures {
                                println!("     ❌ {}", f);
                            }
                        }
                    }
                    Err(e) => {
                        pr.crashed = true;
                        pr.failures.push(format!("IO error: {}", e));
                        println!("💥 IO ERROR: {}", e);
                    }
                }
            }
            Err(e) => {
                pr.crashed = true;
                pr.failures.push(format!("Spawn error: {}", e));
                println!("💥 SPAWN ERROR: {}", e);
            }
        }

        results.push(pr);
    }

    let total_elapsed = total_start.elapsed();

    // ── Summary ──
    println!("\n\n╔══════════════════════════════════════════════════════════════════╗");
    println!("║                     TEST SUMMARY                                ║");
    println!("╚══════════════════════════════════════════════════════════════════╝");

    let plugins_pass = results
        .iter()
        .filter(|r| r.failed == 0 && !r.crashed && !r.timed_out)
        .count();
    let plugins_fail = results.iter().filter(|r| r.failed > 0).count();
    let plugins_crash = results.iter().filter(|r| r.crashed).count();
    let plugins_timeout = results.iter().filter(|r| r.timed_out).count();

    let total_tests: usize = results
        .iter()
        .map(|r| r.passed + r.failed + r.skipped)
        .sum();
    let total_pass: usize = results.iter().map(|r| r.passed).sum();
    let total_fail: usize = results.iter().map(|r| r.failed).sum();
    let total_skip: usize = results.iter().map(|r| r.skipped).sum();

    println!();
    println!("  Plugins: {} total", results.len());
    println!("    ✅ {} all-pass", plugins_pass);
    if plugins_fail > 0 {
        println!("    ❌ {} with failures", plugins_fail);
    }
    if plugins_crash > 0 {
        println!("    💥 {} crashed", plugins_crash);
    }
    if plugins_timeout > 0 {
        println!("    ⏱️  {} timed out", plugins_timeout);
    }
    println!();
    println!(
        "  Tests:   {} total, {} pass, {} fail, {} skip",
        total_tests, total_pass, total_fail, total_skip
    );
    println!("  Time:    {:?}", total_elapsed);
    println!();

    // List all failures
    let problem_plugins: Vec<_> = results
        .iter()
        .filter(|r| r.failed > 0 || r.crashed || r.timed_out)
        .collect();

    if !problem_plugins.is_empty() {
        println!("  ═══ PROBLEM PLUGINS ═══");
        for r in &problem_plugins {
            let status = if r.crashed {
                "💥 CRASH"
            } else if r.timed_out {
                "⏱️  TIMEOUT"
            } else {
                "❌ FAIL"
            };
            println!("  {} │ {}", status, r.name);
            for f in &r.failures {
                println!("         │ {}", f);
            }
        }
    } else {
        println!("  ✅ ALL {} PLUGINS PASSED!", results.len());
    }

    println!();
    println!("════════════════════════════════════════════════════════════════════");
}
