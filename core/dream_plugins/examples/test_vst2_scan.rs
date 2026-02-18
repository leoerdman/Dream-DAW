// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — VST2 Plugin Scanner Test
// ═══════════════════════════════════════════════════════════════════════════
//
// Scans all standard VST2 paths, discovers plugins, and validates each
// by loading + immediate close. Reports pass/fail for each plugin.
//
// Usage:
//   cargo run -p dream_plugins --example test_vst2_scan
//
// ═══════════════════════════════════════════════════════════════════════════

use std::path::Path;
use std::time::Instant;

use dream_plugins::format::PluginFormat;
use dream_plugins::instance::PluginInstance;
use dream_plugins::scanner::PluginScanner;
use dream_plugins::vst2_host::Vst2Instance;

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn"))
        .format_timestamp_millis()
        .init();

    println!("═══════════════════════════════════════════════════════════");
    println!("  Dream DAW — VST2 Plugin Scanner Test");
    println!("═══════════════════════════════════════════════════════════");
    println!();

    let start = Instant::now();

    // 1. Scan for VST2 plugins
    println!("[1] Scanning for VST2 plugins...");
    let scanner = PluginScanner::new();
    let plugins = scanner.scan_format(PluginFormat::VST2);
    println!("[1] Found {} VST2 plugins", plugins.len());
    println!();

    if plugins.is_empty() {
        println!("No VST2 plugins found in standard locations.");
        println!("Check: /Library/Audio/Plug-Ins/VST/ and ~/Library/Audio/Plug-Ins/VST/");
        return;
    }

    // 2. Print all discovered plugins
    println!("[2] Discovered plugins:");
    for (i, desc) in plugins.iter().enumerate() {
        println!(
            "    {:3}. {} ({}) [{}]",
            i + 1,
            desc.name,
            desc.vendor,
            desc.path.display()
        );
    }
    println!();

    // 3. Validate each plugin by loading + closing
    println!("[3] Validating plugins (load → close)...");
    println!();

    let mut pass_count = 0;
    let mut fail_count = 0;
    let mut skip_count = 0;

    for desc in &plugins {
        let plugin_start = Instant::now();
        let path = &desc.path;

        // Skip non-existent paths
        if !path.exists() {
            println!("    SKIP  {} (path not found)", desc.name);
            skip_count += 1;
            continue;
        }

        match Vst2Instance::load(Path::new(path)) {
            Ok(instance) => {
                let load_time = plugin_start.elapsed();
                println!(
                    "    ✓ PASS  {:40} | in={} out={} params={} | {:?}",
                    desc.name,
                    instance.descriptor().audio_inputs,
                    instance.descriptor().audio_outputs,
                    instance.parameter_count(),
                    load_time,
                );
                drop(instance);
                pass_count += 1;
            }
            Err(e) => {
                println!("    ✗ FAIL  {:40} | {}", desc.name, e);
                fail_count += 1;
            }
        }
    }

    // 4. Summary
    let total_time = start.elapsed();
    println!();
    println!("═══════════════════════════════════════════════════════════");
    println!("  RESULTS:");
    println!("    Total:   {}", plugins.len());
    println!("    Passed:  {}", pass_count);
    println!("    Failed:  {}", fail_count);
    println!("    Skipped: {}", skip_count);
    println!("    Time:    {:?}", total_time);
    println!("═══════════════════════════════════════════════════════════");

    if fail_count > 0 {
        std::process::exit(1);
    }
}
