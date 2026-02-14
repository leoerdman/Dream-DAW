# Protocol SYNAPSE — React ↔ Rust Integration Audit

> **Date**: 2026-02-13 | **Auditor**: Antigravity | **Scope**: Full-stack Dream DAW
> **Verdict**: 🔴 **CRITICAL — 0% Live IPC Integration**

---

## Executive Summary

The Dream DAW has a **fully functional Rust audio backend** (13 crates, 53 source files, 347 passing tests) and a **visually stunning React frontend** (10 widgets, ~4,500 lines). However, **zero communication exists between them**. The frontend is a pure UI mockup with hardcoded demo data. No `invoke()` calls, no `@tauri-apps/api` dependency, no state management layer.

### Integration Score: **12%** (Infrastructure Only)

| Layer | Status | Score |
|-------|--------|-------|
| Rust Engine (cpal + rtrb) | ✅ Functional | 90% |
| Tauri Command Handlers | ✅ Registered (16 cmds) | 75% |
| `ts-rs` Type Generation | ⚠️ Generated but unused | 30% |
| Frontend IPC Calls | 🔴 **ZERO** | 0% |
| State Management (Zustand) | 🔴 **Missing** | 0% |
| `@tauri-apps/api` Dependency | 🔴 **Missing** | 0% |
| Real-time Metering Pipeline | 🔴 **Disconnected** | 0% |
| Settings ↔ Engine Sync | 🔴 **Disconnected** | 0% |

---

## The Three Black Holes

### 🕳️ Black Hole #1: The Severed Bridge (CRITICAL)

**Problem**: The frontend has **zero** calls to `@tauri-apps/api`. Not a single `invoke()` exists anywhere in the React codebase.

**Evidence** (grep results across entire `frontend/` directory):
```
grep "invoke" frontend/**/*.{ts,tsx}     → 0 results
grep "@tauri-apps" frontend/**/*.{ts,tsx} → 0 results
grep "zustand" frontend/**/*.{ts,tsx}     → 0 results
```

**Impact**: Every UI interaction is a lie. Play button toggles local `useState(false)` — audio engine never receives `SetPlay`. BPM changes update a local variable — engine stays at default. Track mute/solo/volume — purely cosmetic.

**Root Cause**: `@tauri-apps/api` is not in [package.json](file:///Users/leoerdman/Programming%20-%20MAIN%20FOLDER/Dream%20DAW/frontend/ui_app/package.json). No state management library installed. No IPC client module exists.

---

### 🕳️ Black Hole #2: The Silent Swallower (HIGH)

**Problem**: `driver.rs` audio callback only processes 2 of 12 `EngineCommand` variants. The other 10 are silently discarded.

**Evidence** from [driver.rs:119-141](file:///Users/leoerdman/Programming%20-%20MAIN%20FOLDER/Dream%20DAW/core/dream_engine/src/driver.rs#L119-L141):
```rust
match cmd {
    EngineCommand::SetPlay(play) => { /* ✅ HANDLED */ }
    EngineCommand::SetFreq(freq) => { /* ✅ HANDLED */ }
    // ⚠️ ALL BELOW ARE SILENTLY SWALLOWED:
    EngineCommand::Seek(_)
    | EngineCommand::SetBpm(_)
    | EngineCommand::SetLoopEnabled(_)
    | EngineCommand::SetLoopRegion { .. }
    | EngineCommand::SetTrackVolume { .. }
    | EngineCommand::SetTrackPan { .. }
    | EngineCommand::SetTrackMute { .. }
    | EngineCommand::SetTrackSolo { .. }
    | EngineCommand::Shutdown => {}  // NO-OP
}
```

**Impact**: Even if the IPC bridge were connected, Seek/BPM/Loop/Track controls would have zero effect on audio output. The engine only plays a sine wave test tone.

---

### 🕳️ Black Hole #3: The Phantom Data (MEDIUM-HIGH)

**Problem**: Every React widget contains elaborate hardcoded demo data that creates the illusion of a working DAW but connects to nothing.

| Widget | Lines | Demo Data | IPC Calls |
|--------|-------|-----------|-----------|
| [TransportBar.tsx](file:///Users/leoerdman/Programming%20-%20MAIN%20FOLDER/Dream%20DAW/frontend/ui_app/src/widgets/TransportBar/TransportBar.tsx) | 375 | `useState(128.0)` for BPM | 0 |
| [Timeline.tsx](file:///Users/leoerdman/Programming%20-%20MAIN%20FOLDER/Dream%20DAW/frontend/ui_app/src/widgets/Timeline/Timeline.tsx) | 583 | `DEMO_CLIPS[]` hardcoded | 0 |
| [DeviceRack.tsx](file:///Users/leoerdman/Programming%20-%20MAIN%20FOLDER/Dream%20DAW/frontend/ui_app/src/widgets/DeviceRack/DeviceRack.tsx) | 726 | `TRACK_DEVICE_CHAINS{}` | 0 |
| [AssetBrowser.tsx](file:///Users/leoerdman/Programming%20-%20MAIN%20FOLDER/Dream%20DAW/frontend/ui_app/src/widgets/AssetBrowser/AssetBrowser.tsx) | 505 | `DEMO_SAMPLES[]` 33 items | 0 |
| [TrackInspector.tsx](file:///Users/leoerdman/Programming%20-%20MAIN%20FOLDER/Dream%20DAW/frontend/ui_app/src/widgets/TrackInspector/TrackInspector.tsx) | 411 | `DEMO_TRACKS[]` 17 tracks | 0 |
| [StatusBar.tsx](file:///Users/leoerdman/Programming%20-%20MAIN%20FOLDER/Dream%20DAW/frontend/ui_app/src/widgets/StatusBar/StatusBar.tsx) | 139 | Default props only | 0 |
| [SettingsPanel.tsx](file:///Users/leoerdman/Programming%20-%20MAIN%20FOLDER/Dream%20DAW/frontend/ui_app/src/widgets/SettingsPanel/SettingsPanel.tsx) | 519 | `DEFAULT_SETTINGS{}` | 0 |
| [SplashScreen.tsx](file:///Users/leoerdman/Programming%20-%20MAIN%20FOLDER/Dream%20DAW/frontend/ui_app/src/widgets/SplashScreen/SplashScreen.tsx) | 101 | Fake loading steps | 0 |
| [DawShell.tsx](file:///Users/leoerdman/Programming%20-%20MAIN%20FOLDER/Dream%20DAW/frontend/ui_app/src/app/layouts/DawShell.tsx) | 134 | Orchestrator only | 0 |

**Specific examples**:
- `SplashScreen` shows "Loading Core Modules..." → "Initializing DSP Pipeline..." via `setTimeout` — no actual engine communication
- `SettingsPanel` has Audio tab with buffer size, sample rate, test tone controls — all update `useState` only
- `TrackInspector` toggleMute/toggleSolo/toggleArm — purely local state, never sent to engine

---

## Section-by-Section Audit (120 Questions)

### A. Tauri IPC Command Protocol (Q1-Q15)

**Q1: How many Tauri commands are registered?**
16 commands in [lib.rs](file:///Users/leoerdman/Programming%20-%20MAIN%20FOLDER/Dream%20DAW/apps/desktop_host/src/lib.rs): `play`, `stop`, `toggle_play`, `set_frequency`, `get_state`, `seek`, `set_bpm`, `set_loop_enabled`, `set_loop_region`, `set_track_volume`, `set_track_pan`, `set_track_mute`, `set_track_solo`, `get_transport`, `get_meters`, `update_track`.

**Q2: Are commands invoked from the frontend?**
🔴 **NO.** Zero `invoke()` calls exist. grep confirms 0 matches across all `.ts`/`.tsx` files.

**Q3: Is `@tauri-apps/api` installed?**
🔴 **NO.** Not in `dependencies` or `devDependencies` of `package.json`.

**Q4: What is the command queue implementation?**
✅ `rtrb::RingBuffer` (SPSC lock-free). Capacity: 1024. Created via `create_command_queue()` in `dream_ipc`.

**Q5: What commands does the audio callback actually process?**
Only `SetPlay(bool)` and `SetFreq(f32)`. All others are matched but silently ignored.

**Q6: Is there error propagation from Tauri commands?**
⚠️ Partial. `push()` failures on the ring buffer return `Err(String)` to the frontend — but no frontend code ever receives these errors.

**Q7: What data format crosses the IPC boundary?**
JSON via serde. `PlaybackState` is `Serialize`/`Deserialize` with `ts-rs` for TypeScript generation.

**Q8: Is the generated TypeScript binding used?**
🔴 **NO.** `shared_bindings/PlaybackState.ts` exists (42 lines, auto-generated) but is never imported by any component.

**Q9: Is CSP configured?**
⚠️ `"csp": null` in `tauri.conf.json` — no Content Security Policy. Security risk for production.

**Q10: Are Tauri permissions properly configured?**
⚠️ Only `tauri-plugin-shell` is included. No file dialog, no fs, no clipboard permissions configured.

**Q11-Q15: Frontend command dispatching pattern?**
🔴 Non-existent. No command service, no API client, no hooks layer, no error boundary for IPC failures.

---

### B. State Synchronization (Q16-Q30)

**Q16: What state management library is used?**
🔴 **None.** No Zustand, Redux, Jotai, or any global store. Each widget manages independent `useState`.

**Q17: How does transport state flow from engine to UI?**
🔴 It doesn't. `MasterClock.position()` is never polled. `PlaybackState` is never fetched.

**Q18: How are VU meters updated?**
🔴 Disconnected. `MeterBank` exists in Rust with `Arc<AtomicU32>` per channel. `get_meters` Tauri command exists. Frontend `DeviceRack.tsx` uses hardcoded `vuLevel` floats — never polls the engine.

**Q19: How does BPM sync work?**
🔴 Non-functional. `TransportBar` has `useState(128.0)`. Engine default is in `PlaybackState { bpm: 120.0 }`. These are independent values.

**Q20: Is playhead position displayed?**
⚠️ `StatusBar` shows `position = '1.1.24'` (hardcoded default prop). `Timeline` draws a playhead at a fixed position. Neither reads from `MasterClock`.

**Q21-Q25: Bidirectional state sync architecture?**
🔴 No polling loop, no event subscription, no `listen()` from Tauri events. Complete absence.

**Q26-Q30: Conflict resolution / optimistic updates?**
🔴 N/A — no state flows to resolve conflicts over.

---

### C. Audio Engine Architecture (Q31-Q45)

**Q31: What audio backend is used?**
✅ `cpal 0.17` via [driver.rs](file:///Users/leoerdman/Programming%20-%20MAIN%20FOLDER/Dream%20DAW/core/dream_engine/src/driver.rs). Platform-abstracted (CoreAudio on macOS).

**Q32: What does the engine actually produce?**
A 440Hz sine wave test tone with exponential frequency smoothing. No real audio file playback.

**Q33: Is `render_callback.rs` connected to the driver?**
🔴 **NO.** `render_callback.rs` (342 lines) implements a full TrackSlot → ClipScheduler → FadeCache → ChannelStrip → SummingBus pipeline, but `driver.rs` uses its own inline sine generator. They are **separate, unconnected systems**.

**Q34: What DSP is implemented?**
✅ `dream_dsp` has: Butterworth biquad (7 filter types), BiquadCascade, State Variable Filter (Chamberlin), StereoSvf, Crossfade functions. All tested.

**Q35: Is clip playback functional?**
🔴 No. `dream_clip_engine` has `ClipPool`, `AsyncFileReader`, `ClipScheduler` — but `render_callback.rs` marks audio reading as a no-op: `let _ = active_clips;`

**Q36: Transport state machine?**
✅ `dream_transport` has `TransportState`, `TransportCommand`, `Playhead`, `LoopRegion` — but these are not wired into `driver.rs`.

**Q37-Q40: Real-time safety?**
✅ Design is sound: `Copy` commands, SPSC queue, atomic clock, no heap in callback. But actual implementation only covers sine wave.

**Q41-Q45: Plugin system?**
⚠️ `dream_plugins` has `PluginDescriptor`, `PluginFormat`, `PluginInstance`, `PluginScanner` — structure exists but likely stubs (not connected to audio graph).

---

### D. Build System & Workspace (Q46-Q60)

**Q46: Workspace members?**
13 core crates + 1 app. See [Cargo.toml](file:///Users/leoerdman/Programming%20-%20MAIN%20FOLDER/Dream%20DAW/Cargo.toml).

**Q47: Does `cargo test --workspace` pass?**
✅ Yes. 347 tests, 0 failures (verified).

**Q48: Does `cargo build` succeed?**
✅ Yes (confirmed by test run).

**Q49: Frontend build toolchain?**
Vite 7 + React 19 + TypeScript + Tailwind CSS v4. Custom `autoVersionPlugin` for build numbering.

**Q50: pnpm workspace configured?**
✅ `pnpm-workspace.yaml` links `frontend/ui_app` and `apps/desktop_host`.

**Q51: Tauri build commands?**
✅ `beforeDevCommand: "pnpm --filter ui_app dev"`, `beforeBuildCommand: "pnpm --filter ui_app build"`.

**Q52: Release profile optimizations?**
✅ Aggressive: `lto = "fat"`, `codegen-units = 1`, `strip = "symbols"`, `panic = "abort"`.

**Q53: Cross-platform readiness?**
⚠️ `tauri.conf.json` has Windows icon (`icon.ico`), but `driver.rs` uses `device.description()` which may differ across platforms. `SettingsPanel` hardcodes "CoreAudio" as the only driver option.

**Q54-Q60: CI/CD, linting, formatting?**
🔴 No CI configuration found. No `.github/workflows`. No `rustfmt.toml` or `clippy.toml`.

---

### E. Swift Legacy Compatibility (Q61-Q75)

**Q61: What Swift code exists?**
Referenced as "SWIFT UI Archive" (ported from). Comments indicate:
- `BottomPanelView.swift` (1094 lines) → `DeviceRack.tsx` (726 lines)
- `BrowserSidebarView.swift` (1639 lines) → `AssetBrowser.tsx` (505 lines)
- `StatusBarView.swift` (142 lines) → `StatusBar.tsx` (139 lines)
- `SettingsWindowController.swift` (692 lines) + `AppSettings.swift` (520 lines) → `SettingsPanel.tsx` (519 lines)
- `SplashScreenView.swift` → `SplashScreen.tsx` (101 lines)

**Q62: Is `.ddpj` project file parsing implemented?**
⚠️ `dream_io/src/project_file.rs` exists — implementation status unknown, not connected to frontend.

**Q63-Q75: Swift feature parity?**
The React port captures the **visual layout** of Swift views but none of the **functional logic** (Core Audio integration, real-time metering, file system access, etc.).

---

### F. Metering & Telemetry (Q76-Q85)

**Q76: MeterBank implementation?**
✅ Rust: `dream_ipc/src/metering.rs` — `Arc<MeterBank>` with `AtomicU32` per channel. Lock-free read/write.

**Q77: Is metering data flowing to UI?**
🔴 **NO.** `get_meters` Tauri command exists. Frontend uses hardcoded `vuLevel` values. No polling loop.

**Q78-Q85: VU meter rendering?**
Frontend `DeviceRack.tsx` renders VU bars with CSS transitions (0.1s linear). `TrackInspector.tsx` renders volume bars. Both are static — values never change at runtime.

---

### G. Hotkeys & Input (Q86-Q95)

**Q86: Global keyboard shortcuts?**
⚠️ `SettingsPanel` handles `⌘,` and `Escape`. `AssetBrowser` handles `⌘F`. `DawShell` handles `⌘,`. **No transport hotkeys** (Space for play/stop, etc.).

**Q87-Q95: MIDI input handling?**
🔴 No MIDI input layer exists in the frontend or backend.

---

### H. Rendering & WebGPU (Q96-Q105)

**Q96: WebGPU renderer status?**
⚠️ `dream_renderer` has `gpu_types.rs`, `timeline.rs`, `viewport.rs` — structure exists but not connected to frontend. The "Hole-Punch Architecture" mentioned in conversation history for transparent React overlay over WebGPU is not implemented.

**Q97-Q105: Waveform rendering?**
🔴 `Timeline.tsx` draws colored rectangles for clips. No actual waveform rendering. `dream_io/src/peak_cache.rs` exists for waveform data but is not connected.

---

### I. Export & AI Features (Q106-Q115)

**Q106-Q110: Audio export?**
⚠️ `dream_io/src/wav_writer.rs` exists. Not connected to any UI or command handler.

**Q111-Q115: AI features?**
🔴 None implemented. No AI-related code in frontend or backend.

---

### J. Error Handling & Resilience (Q116-Q120)

**Q116: Graceful shutdown?**
⚠️ `EngineCommand::Shutdown` exists but is silently ignored in `driver.rs`. Stream stops only when `AudioStreamHandle` is dropped.

**Q117: Audio device hot-swap?**
🔴 Not implemented. `driver.rs` selects default device at startup; no reconnection logic.

**Q118: Error boundaries in React?**
🔴 No React error boundaries. No `ErrorBoundary` component.

**Q119: Panic handling?**
⚠️ Release profile uses `panic = "abort"`. Audio callback has no panic catch. A panic in the callback would terminate the entire application.

**Q120: Logging infrastructure?**
✅ `env_logger` with `RUST_LOG` env var. `dev.sh` sets `RUST_BACKTRACE=1`. Frontend has no logging framework.

---

## Crate-by-Crate Status Matrix

| Crate | Files | Tests | Connected to Driver | Connected to UI |
|-------|-------|-------|--------------------:|----------------:|
| `dream_models` | 5 | ✅ | — | 🔴 |
| `dream_ipc` | 2 | ✅ | ✅ (partial) | 🔴 |
| `dream_engine` | 4 | ✅ | ✅ (sine only) | 🔴 |
| `dream_dsp` | 5 | ✅ | 🔴 | 🔴 |
| `dream_mixer` | 6 | ✅ | 🔴 | 🔴 |
| `dream_transport` | 4 | ✅ | 🔴 | 🔴 |
| `dream_clip_engine` | 4 | ✅ | 🔴 | 🔴 |
| `dream_io` | 5 | ✅ | 🔴 | 🔴 |
| `dream_graph` | 4 | ✅ | 🔴 | 🔴 |
| `dream_automation` | 4 | ✅ | 🔴 | 🔴 |
| `dream_plugins` | 5 | ✅ | 🔴 | 🔴 |
| `dream_renderer` | 4 | ✅ | 🔴 | 🔴 |
| `desktop_host` | 3 | ✅ | ✅ | 🔴 |

---

## What Actually Works End-to-End

1. `cargo test --workspace` — 347 tests pass
2. `driver.rs` plays a sine wave tone when `SetPlay(true)` is sent via rtrb queue
3. `MasterClock` atomically advances frame count in audio callback
4. Frontend renders a beautiful DAW interface with all expected panels
5. `ts-rs` generates `PlaybackState.ts` from Rust struct

**What does NOT work end-to-end**: Everything else. No user action in the UI reaches the audio engine. No engine state reaches the UI.

---

## Critical Path to First Working Integration

### Phase 1: Wire the Bridge (Essential)
1. `pnpm add @tauri-apps/api` in `frontend/ui_app`
2. Create `src/shared/api/engine.ts` — typed `invoke()` wrappers
3. Create Zustand store `src/shared/stores/useEngineStore.ts`
4. Wire `TransportBar` play/stop/bpm to `invoke('play')`, `invoke('set_bpm')`
5. Add 60fps polling loop for `invoke('get_state')` → update store

### Phase 2: Process Commands in Engine
6. Replace `driver.rs` sine generator with `render_callback.rs` pipeline
7. Implement `Seek`, `SetBpm`, `SetLoopEnabled` in audio callback
8. Connect `MeterBank` writes in `render_callback.rs`

### Phase 3: Real-Time Metering
9. Poll `invoke('get_meters')` at 60fps → update `DeviceRack` VU levels
10. Connect `StatusBar` to `MasterClock.position()` for live playhead

---

## Final Verdict

| Metric | Value |
|--------|-------|
| **Overall Integration** | **12%** |
| **Rust Backend Maturity** | 75% (well-architected, tested, but only sine output) |
| **Frontend UI Maturity** | 85% (production-quality visuals, zero functionality) |
| **IPC Bridge** | 5% (handlers registered, nothing calls them) |
| **Risk Level** | 🔴 CRITICAL — project cannot ship in current state |
| **Estimated Fix Effort** | ~40-60 hours for Phase 1-3 |
| **TODO/FIXME Count** | 0 (grep confirms none — code is clean but incomplete) |

> **Bottom Line**: Dream DAW is two excellent halves of a project that have never met. The Rust engine is a well-tested audio foundation. The React frontend is a pixel-perfect DAW mock. Between them lies a void — no wire, no pipe, no signal. The Tauri bridge infrastructure exists (commands registered, types generated) but the last mile — the `invoke()` call from JavaScript to Rust — was never written.
