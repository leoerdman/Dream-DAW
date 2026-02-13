// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Titanium Kernel: Proof of Life
// ═══════════════════════════════════════════════════════════════════════════
//
// Phase 1 Genesis Sprint — Console test harness.
//
// This binary demonstrates the lock-free audio pipeline:
//   main() → rtrb::Producer → [commands] → cpal callback → [sine wave] → 🔊
//
// Expected output when running `cargo run --release`:
//   1. 440 Hz sine tone plays for 2 seconds (A4)
//   2. Smoothly glides to 880 Hz (A5) — no click
//   3. Plays 880 Hz for 2 seconds
//   4. Smoothly glides to 261 Hz (C4) — no click
//   5. Plays 261 Hz for 2 seconds
//   6. Silence (Stop command)
//
// Total runtime: ~7 seconds.
//
// ═══════════════════════════════════════════════════════════════════════════

mod audio_driver;
mod lock_free;

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use lock_free::{AudioBridge, EngineCommand};

fn main() {
    // ── Initialize logging ──────────────────────────────────────────
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    log::info!("═══════════════════════════════════════════════════");
    log::info!("  Dream DAW — Titanium Kernel v0.1.0");
    log::info!("  Phase 1: Proof of Life");
    log::info!("═══════════════════════════════════════════════════");

    // ── Create the lock-free bridge ─────────────────────────────────
    // Capacity 1024: more than enough for our command throughput.
    let bridge = AudioBridge::new(1024);

    // Split the bridge into producer (stays here) and consumer (goes to audio)
    let mut producer = bridge.producer;
    let consumer = bridge.consumer;
    let clock = Arc::new(bridge.clock);

    // ── Start the audio thread ──────────────────────────────────────
    let clock_for_audio = Arc::clone(&clock);
    let stream_handle = match audio_driver::start_audio_thread(consumer, clock_for_audio) {
        Ok(handle) => {
            log::info!("✅ Audio driver initialized successfully");
            handle
        }
        Err(e) => {
            log::error!("❌ Failed to start audio driver: {}", e);
            log::error!("   Make sure you have an audio output device connected.");
            std::process::exit(1);
        }
    };

    // ── Command Sequence ────────────────────────────────────────────
    // Demonstrates the full lock-free pipeline:
    // Producer (this thread) → rtrb → Consumer (audio callback)

    log::info!("───────────────────────────────────────────────────");
    log::info!("▶  Sending PLAY command (440 Hz — A4)");
    send_command(&mut producer, EngineCommand::Play);
    wait_and_report(&clock, Duration::from_secs(2));

    log::info!("🎵 Sending frequency change: 880 Hz (A5)");
    send_command(&mut producer, EngineCommand::SetTestToneFrequency(880.0));
    wait_and_report(&clock, Duration::from_secs(2));

    log::info!("🎵 Sending frequency change: 261.63 Hz (C4 — Middle C)");
    send_command(&mut producer, EngineCommand::SetTestToneFrequency(261.63));
    wait_and_report(&clock, Duration::from_secs(2));

    log::info!("⏹  Sending STOP command");
    send_command(&mut producer, EngineCommand::Stop);
    wait_and_report(&clock, Duration::from_secs(1));

    log::info!("───────────────────────────────────────────────────");
    log::info!("✅ Proof of Life COMPLETE.");
    log::info!("   Total frames rendered: {}", clock.position());
    log::info!(
        "   ≈ {:.2} seconds of audio",
        clock.position() as f64 / 48000.0
    );
    log::info!("═══════════════════════════════════════════════════");

    // Keep the stream alive until we're done
    drop(stream_handle);
}

/// Sends a command to the audio thread via the lock-free ring buffer.
///
/// If the queue is full (extremely unlikely), logs a warning and drops
/// the command. This is the correct real-time behavior: never block,
/// never panic, just report and continue.
fn send_command(producer: &mut rtrb::Producer<EngineCommand>, cmd: EngineCommand) {
    match producer.push(cmd) {
        Ok(()) => {}
        Err(_) => {
            log::warn!("⚠  Command queue full, dropping: {:?}", cmd);
        }
    }
}

/// Sleeps for the given duration while periodically reporting the master clock.
///
/// This simulates what the UI thread would do: sleep between frames,
/// read the atomic clock for display, repeat.
fn wait_and_report(clock: &Arc<lock_free::MasterClock>, duration: Duration) {
    let intervals = 4; // Report 4 times during the wait
    let interval = duration / intervals;

    for _ in 0..intervals {
        thread::sleep(interval);
        let frames = clock.position();
        log::info!(
            "   ⏱  Clock: {} frames ({:.2}s)",
            frames,
            frames as f64 / 48000.0
        );
    }
}
