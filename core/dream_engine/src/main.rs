// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Titanium Kernel: Proof of Life (Monorepo Edition)
// ═══════════════════════════════════════════════════════════════════════════
//
// This binary demonstrates the full lock-free audio pipeline across crates:
//   dream_ipc::create_command_queue() → Producer → rtrb → Consumer →
//   dream_engine::driver::start_audio_thread() → cpal → speakers 🔊
//
// Expected output when running `cargo run -p dream_engine --release`:
//   1. 440 Hz sine tone (A4) for 2 seconds
//   2. Smooth glide to 880 Hz (A5) — zero clicks
//   3. 880 Hz for 2 seconds
//   4. Smooth glide to 261.63 Hz (C4 — Middle C) — zero clicks
//   5. 261.63 Hz for 2 seconds
//   6. Silence (Stop)
//
// Total runtime: ~7 seconds.
//
// ═══════════════════════════════════════════════════════════════════════════

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use dream_clip_engine::pool::ClipPool;
use dream_engine::driver::SharedClipSnapshot;
use dream_ipc::metering::MeterBank;
use dream_ipc::{self, EngineCommand, MasterClock};

fn main() {
    // ── Initialize logging ──────────────────────────────────────────
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    log::info!("═══════════════════════════════════════════════════");
    log::info!("  Dream DAW — Titanium Kernel v0.1.0");
    log::info!("  Leviathan Architecture • Proof of Life");
    log::info!("═══════════════════════════════════════════════════");

    // ── Create the lock-free bridge ─────────────────────────────────
    let (mut producer, consumer) = dream_ipc::create_command_queue();
    let clock = Arc::new(MasterClock::new());
    let meter_bank = Arc::new(MeterBank::new(64));
    let clip_pool = Arc::new(arc_swap::ArcSwap::from_pointee(ClipPool::new()));
    let clip_snapshot = Arc::new(SharedClipSnapshot::new());

    // ── Start the audio thread ──────────────────────────────────────
    let clock_for_audio = Arc::clone(&clock);
    let meter_for_audio = Arc::clone(&meter_bank);
    let shared_state = dream_engine::driver::AudioSharedState {
        clock: clock_for_audio,
        meter_bank: meter_for_audio,
        clip_pool,
        clip_snapshot,
        midi_snapshot: Arc::new(dream_engine::driver::SharedMidiSnapshot::new()),
        routing_snapshot: Arc::new(dream_engine::driver::SharedRoutingSnapshot::new()),
        sidechain_snapshot: Arc::new(dream_engine::driver::SharedSidechainSnapshot::new()),
        external_fx_snapshot: Arc::new(dream_engine::driver::SharedExternalPluginSnapshot::new()),
        automation_snapshot: Arc::new(dream_engine::driver::SharedAutomationSnapshot::new()),
        sampler_samples: Arc::new(dream_engine::driver::SharedSamplerSamples::new()),
        sample_rack_samples: Arc::new(dream_engine::driver::SharedSampleRackSamples::new()),
        prepared_graph_snapshot: Arc::new(dream_engine::driver::SharedPreparedGraphSnapshot::new()),
        rt_debug_stats: Arc::new(dream_engine::driver::SharedRtDebugStats::new()),
        plugin_registry: Arc::new(dream_engine::driver::SharedPluginRegistry::new()),
        preview_buffer: Arc::new(arc_swap::ArcSwap::from_pointee(None)),
        preview_cursor: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        preview_source_sr: Arc::new(std::sync::atomic::AtomicU32::new(0)),
        disk_streamers: Arc::new(dream_engine::driver::SharedDiskStreamers::new()),
    };

    let _stream_handle = match dream_engine::driver::start_audio_thread(
        consumer,
        {
            let (_prealloc_prod, prealloc_cons) =
                dream_ipc::prealloc_queue::new_prealloc_queue();
            prealloc_cons
        },
        shared_state,
    ) {
        Ok(handle) => {
            log::info!("✅ Audio driver initialized");
            handle
        }
        Err(e) => {
            log::error!("❌ Failed to start audio driver: {}", e);
            log::error!("   Make sure an audio output device is connected.");
            std::process::exit(1);
        }
    };

    // ── Command Sequence ────────────────────────────────────────────
    log::info!("───────────────────────────────────────────────────");

    log::info!("▶  PLAY — 440 Hz (A4)");
    send(&mut producer, EngineCommand::SetPlay(true));
    wait_report(&clock, Duration::from_secs(2));

    log::info!("🎵 Frequency → 880 Hz (A5)");
    send(&mut producer, EngineCommand::SetFreq(880.0));
    wait_report(&clock, Duration::from_secs(2));

    log::info!("🎵 Frequency → 261.63 Hz (C4 — Middle C)");
    send(&mut producer, EngineCommand::SetFreq(261.63));
    wait_report(&clock, Duration::from_secs(2));

    log::info!("⏹  STOP");
    send(&mut producer, EngineCommand::SetPlay(false));
    wait_report(&clock, Duration::from_secs(1));

    log::info!("───────────────────────────────────────────────────");
    log::info!("✅ Proof of Life COMPLETE");
    log::info!("   Frames rendered: {}", clock.position());
    log::info!("   ≈ {:.2}s of audio", clock.position() as f64 / 48000.0);
    log::info!("═══════════════════════════════════════════════════");
}

/// Sends a command via the lock-free ring buffer.
/// If queue full (extremely unlikely), logs warning and drops command.
fn send(producer: &mut rtrb::Producer<EngineCommand>, cmd: EngineCommand) {
    let dbg = format!("{:?}", &cmd);
    if producer.push(cmd).is_err() {
        log::warn!("⚠  Command queue full, dropping: {}", dbg);
    }
}

/// Sleeps for the duration while periodically reporting the master clock.
fn wait_report(clock: &Arc<MasterClock>, duration: Duration) {
    let ticks = 4u32;
    let interval = duration / ticks;
    for _ in 0..ticks {
        thread::sleep(interval);
        let frames = clock.position();
        log::info!(
            "   ⏱  Clock: {} frames ({:.2}s)",
            frames,
            frames as f64 / 48000.0
        );
    }
}
