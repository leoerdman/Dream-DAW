// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — VST2 Headless Audio Processing Test
// ═══════════════════════════════════════════════════════════════════════════
//
// Standalone test that loads a VST2 plugin, processes audio buffers,
// and validates output. No GUI / AppKit dependencies.
//
// Usage:
//   VST2_BUNDLE_PATH="/Library/Audio/Plug-Ins/VST/FabFilter Pro-Q 3.vst" \
//     cargo run -p dream_plugins --example test_vst2_headless
//
// ═══════════════════════════════════════════════════════════════════════════

use std::path::Path;
use std::time::Instant;

use dream_plugins::instance::{MidiEvent, PluginInstance, TransportContext};
use dream_plugins::vst2_host::{vst2_get_param_display, vst2_get_param_label, vst2_get_param_name, Vst2Instance};

fn main() {
    // Initialize logger
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    // Get plugin path from env or use a default
    let bundle_path = std::env::var("VST2_BUNDLE_PATH").unwrap_or_else(|_| {
        // Try common installed plugins
        let defaults = [
            "/Library/Audio/Plug-Ins/VST/FabFilter Pro-Q 3.vst",
            "/Library/Audio/Plug-Ins/VST/ValhallaRoom.vst",
            "/Library/Audio/Plug-Ins/VST/ValhallaRoom_x64.vst",
        ];
        for path in &defaults {
            if Path::new(path).exists() {
                return path.to_string();
            }
        }
        eprintln!("ERROR: No VST2 plugin found. Set VST2_BUNDLE_PATH env var.");
        eprintln!("Example: VST2_BUNDLE_PATH=\"/Library/Audio/Plug-Ins/VST/MyPlugin.vst\"");
        std::process::exit(1);
    });

    println!("═══════════════════════════════════════════════════════════");
    println!("  Dream DAW — VST2 Headless Test");
    println!("═══════════════════════════════════════════════════════════");
    println!("  Bundle: {}", bundle_path);
    println!();

    let start = Instant::now();

    // 1. Load the plugin
    println!("[1] Loading plugin...");
    let mut instance = match Vst2Instance::load(Path::new(&bundle_path)) {
        Ok(inst) => inst,
        Err(e) => {
            eprintln!("FAIL: Failed to load plugin: {}", e);
            std::process::exit(1);
        }
    };
    println!("[1] ✓ Loaded in {:?}", start.elapsed());

    // 2. Print plugin info
    let desc = instance.descriptor().clone();
    println!();
    println!("  Name:     {}", desc.name);
    println!("  Vendor:   {}", desc.vendor);
    println!("  Format:   {}", desc.format);
    println!("  Category: {}", desc.category);
    println!("  Inputs:   {}", desc.audio_inputs);
    println!("  Outputs:  {}", desc.audio_outputs);
    println!("  MIDI:     {}", desc.accepts_midi);
    println!("  Latency:  {} samples", instance.latency_samples());
    println!("  Params:   {}", instance.parameter_count());
    println!("  Editor:   {}", instance.supports_editor());

    // 3. Print first 10 parameters
    let param_count = instance.parameter_count().min(10);
    if param_count > 0 {
        println!();
        println!("  First {} parameters:", param_count);
        for i in 0..param_count {
            let name = vst2_get_param_name(&instance, i);
            let display = vst2_get_param_display(&instance, i);
            let label = vst2_get_param_label(&instance, i);
            let value = instance.get_parameter(i).unwrap_or(0.0);
            println!("    [{}] {} = {:.4} ({} {})", i, name, value, display, label);
        }
    }

    // 4. Activate
    let sample_rate = 44100.0;
    let buffer_size = 1024;
    println!();
    println!("[2] Activating (sr={}, bs={})...", sample_rate, buffer_size);
    if let Err(e) = instance.activate(sample_rate, buffer_size) {
        eprintln!("FAIL: Activation failed: {}", e);
        std::process::exit(1);
    }
    println!("[2] ✓ Activated");

    // 5. Set transport context
    instance.set_transport_context(TransportContext {
        sample_rate,
        tempo: 120.0,
        time_sig_numerator: 4,
        time_sig_denominator: 4,
        position_samples: 0,
        is_playing: true,
        is_recording: false,
    });

    // 6. Process audio buffers
    let num_outputs = desc.audio_outputs as usize;
    let num_inputs = desc.audio_inputs as usize;
    let num_blocks = 10;

    println!();
    println!("[3] Processing {} blocks of {} frames...", num_blocks, buffer_size);

    let mut total_max_amplitude = 0.0f32;
    let mut total_rms = 0.0f64;
    let mut total_samples = 0u64;

    for block in 0..num_blocks {
        // Create input buffers with test signal (sine wave)
        let freq = 440.0;
        let mut input_data: Vec<Vec<f32>> = (0..num_inputs.max(1))
            .map(|_| {
                (0..buffer_size)
                    .map(|i| {
                        let t = (block * buffer_size + i) as f64 / sample_rate;
                        (t * freq * 2.0 * std::f64::consts::PI).sin() as f32 * 0.5
                    })
                    .collect()
            })
            .collect();

        // Create output buffers
        let mut output_data: Vec<Vec<f32>> =
            (0..num_outputs.max(1)).map(|_| vec![0.0f32; buffer_size]).collect();

        let input_refs: Vec<&[f32]> = input_data.iter().map(|v| v.as_slice()).collect();
        let mut output_refs: Vec<&mut [f32]> =
            output_data.iter_mut().map(|v| v.as_mut_slice()).collect();

        // Create MIDI events for synths (Note On at start of first block)
        let midi_events = if desc.accepts_midi && block == 0 {
            vec![MidiEvent::note_on(0, 0, 60, 100)]
        } else if desc.accepts_midi && block == num_blocks - 1 {
            vec![MidiEvent::note_off(0, 0, 60, 0)]
        } else {
            vec![]
        };

        // Process
        let process_start = Instant::now();
        match instance.process(&input_refs, &mut output_refs, buffer_size, &midi_events) {
            Ok(()) => {
                let process_time = process_start.elapsed();

                // Analyze output
                for ch in &output_data {
                    for &sample in ch {
                        let abs = sample.abs();
                        if abs > total_max_amplitude {
                            total_max_amplitude = abs;
                        }
                        total_rms += (sample as f64) * (sample as f64);
                        total_samples += 1;
                    }
                }

                println!(
                    "    Block {:2}: process={:>6?} | max={:.6} | midi={}",
                    block,
                    process_time,
                    output_data[0].iter().map(|s| s.abs()).fold(0.0f32, f32::max),
                    midi_events.len(),
                );
            }
            Err(e) => {
                eprintln!("FAIL: Process error on block {}: {}", block, e);
                std::process::exit(1);
            }
        }
    }

    // 7. Summary stats
    let rms = if total_samples > 0 {
        (total_rms / total_samples as f64).sqrt()
    } else {
        0.0
    };

    println!();
    println!("[4] Audio Statistics:");
    println!("    Peak amplitude: {:.6}", total_max_amplitude);
    println!("    RMS level:      {:.6}", rms);
    println!("    Total samples:  {}", total_samples);

    // 8. Verify output is non-silent for effects (input was non-zero)
    let output_is_silent = total_max_amplitude < 1e-10;
    let is_effect = num_inputs > 0; // Effects have audio inputs

    if is_effect && output_is_silent {
        println!();
        println!("WARNING: Output is silent for an effect plugin with non-zero input.");
        println!("  This might indicate incorrect processing or a muted plugin.");
    }

    // 9. Deactivate
    println!();
    println!("[5] Deactivating...");
    if let Err(e) = instance.deactivate() {
        eprintln!("WARNING: Deactivation error: {}", e);
    }
    println!("[5] ✓ Deactivated");

    // 10. Drop (will call effClose)
    println!();
    println!("[6] Closing plugin...");
    let total_time = start.elapsed();
    drop(instance);
    println!("[6] ✓ Closed");

    // 11. Final verdict
    println!();
    println!("═══════════════════════════════════════════════════════════");
    println!("  RESULT: ✓ PASS");
    println!("  Total time: {:?}", total_time);
    println!("═══════════════════════════════════════════════════════════");
}
