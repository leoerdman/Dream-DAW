# Dream DAW — Complete Project Structure Documentation

> **Version**: 1.0  
> **Generated**: February 2026  
> **Scope**: Every file, module, struct, function, and interconnection in the Dream DAW monorepo.

---

## Table of Contents

1. [High-Level Architecture](#1-high-level-architecture)
2. [Technology Stack](#2-technology-stack)
3. [Monorepo File Tree](#3-monorepo-file-tree)
4. [Root Configuration Files](#4-root-configuration-files)
5. [Core Rust Crates](#5-core-rust-crates)
   - 5.1 [dream_models — Canonical Data Structures](#51-dream_models--canonical-data-structures)
   - 5.2 [dream_ipc — Inter-Thread Communication](#52-dream_ipc--inter-thread-communication)
   - 5.3 [dream_engine — Audio Engine & Driver](#53-dream_engine--audio-engine--driver)
   - 5.4 [dream_graph — Audio Routing Graph](#54-dream_graph--audio-routing-graph)
   - 5.5 [dream_dsp — DSP Utilities](#55-dream_dsp--dsp-utilities)
   - 5.6 [dream_renderer — GPU Timeline Renderer](#56-dream_renderer--gpu-timeline-renderer)
   - 5.7 [dream_plugins — Plugin Hosting Framework](#57-dream_plugins--plugin-hosting-framework)
   - 5.8 [dream_io — Audio File I/O & Project Serialization](#58-dream_io--audio-file-io--project-serialization)
   - 5.9 [dream_mixer — Real-Time Mixer Engine](#59-dream_mixer--real-time-mixer-engine)
   - 5.10 [dream_transport — Transport State Machine](#510-dream_transport--transport-state-machine)
   - 5.11 [dream_clip_engine — Clip Playback Engine](#511-dream_clip_engine--clip-playback-engine)
   - 5.12 [dream_automation — Automation System](#512-dream_automation--automation-system)
6. [Desktop Host (Tauri v2)](#6-desktop-host-tauri-v2)
7. [Frontend (React + Vite + Tailwind CSS)](#7-frontend-react--vite--tailwind-css)
   - 7.1 [Entry Point & Configuration](#71-entry-point--configuration)
   - 7.2 [Design System (CSS Layers)](#72-design-system-css-layers)
   - 7.3 [Layout Architecture (DawShell)](#73-layout-architecture-dawshell)
   - 7.4 [Widgets](#74-widgets)
8. [Cross-Cutting Concerns](#8-cross-cutting-concerns)
9. [Dependency Graph](#9-dependency-graph)
10. [Design Principles](#10-design-principles)

---

## 1. High-Level Architecture

Dream DAW is a professional Digital Audio Workstation built as a **Rust + React hybrid** monorepo.
The architecture separates concerns into three tiers:

```
┌─────────────────────────────────────────────────────────────────┐
│                     FRONTEND (React/TS)                         │
│  TransportBar · AssetBrowser · DeviceRack · TrackInspector      │
│  StatusBar · DawShell (Hole-Punch Layout)                       │
├─────────────────────────────────────────────────────────────────┤
│                     DESKTOP HOST (Tauri v2)                     │
│  IPC Commands · State Management · Window Management             │
├─────────────────────────────────────────────────────────────────┤
│                     CORE ENGINE (Rust)                           │
│  dream_models · dream_ipc · dream_engine · dream_graph          │
│  dream_dsp · dream_renderer · dream_plugins · dream_io          │
│  dream_mixer · dream_transport · dream_clip_engine              │
│  dream_automation                                                │
└─────────────────────────────────────────────────────────────────┘
```

**Key Architectural Decisions:**

1. **Real-Time Safety First** — The audio callback thread (`dream_engine`) allocates zero bytes, acquires zero locks, and performs zero I/O. All communication uses lock-free ring buffers (`rtrb`).
2. **Hole-Punch UI** — The WebGPU timeline canvas (Layer 0) renders at 144Hz natively. React UI panels (Layer 1) float above with `pointer-events: none`, re-enabling interactions only in glass panels.
3. **Single Source of Truth** — `dream_models` defines all canonical data structures. `AbsoluteTime` (i64 sample frames) is the universal time unit. `PulseMap` converts between samples, seconds, and beats.
4. **Zero-Wait Graph Mutations** — The audio graph uses Read-Copy-Update (RCU) via `arc-swap`. The UI builds a new graph snapshot; the audio thread atomically swaps to it.
5. **GPU-Accelerated Rendering** — `wgpu` powers cross-platform timeline/waveform rendering with instanced draw calls and multi-resolution peak data.

---

## 2. Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Audio Engine** | Rust, `cpal` | Cross-platform audio I/O, real-time callback |
| **Audio Graph** | `petgraph`, `arc-swap` | DAG routing, RCU atomic swaps |
| **DSP** | `rubato` | Sample rate conversion |
| **GPU Rendering** | `wgpu`, WGSL shaders | Timeline, waveform, MIDI note rendering |
| **Audio Codecs** | `symphonia`, `hound` | Decode (WAV/FLAC/OGG/MP3/AIFF), WAV export |
| **IPC** | `rtrb` | Lock-free SPSC ring buffers |
| **Desktop Shell** | Tauri v2, `tauri-plugin-shell` | Native window, system tray, IPC bridge |
| **Frontend** | React 18, TypeScript, Vite | UI components, state management |
| **Styling** | Tailwind CSS v4, CSS Variables | 170+ design tokens, glassmorphism |
| **Serialization** | `serde`, `serde_json`, `ts-rs` | Rust ↔ TypeScript type generation |
| **Time** | Custom `AbsoluteTime` (i64) | Sample-accurate, overflow-safe |
| **Identifiers** | `uuid` | Track, clip, and project IDs |
| **Logging** | `log` | Structured logging across crates |

---

## 3. Monorepo File Tree

```
Dream DAW/
├── Cargo.toml                          # Workspace root — members + shared deps
├── pnpm-workspace.yaml                 # pnpm workspace packages
├── .gitignore                          # Excludes: target/, node_modules/, SWIFT UI Archive/
├── PROJECT_STRUCTURE.md                # ← This file
│
├── core/                               # 12 Rust library crates
│   ├── dream_models/                   # Canonical data structures (SSOT)
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs                  # PlaybackState, module declarations
│   │       ├── project.rs              # Project, Track, AudioClip, MidiClip
│   │       ├── time.rs                 # AbsoluteTime (i64 sample frames)
│   │       └── pulse_map.rs            # TempoEvent, PulseMap (tempo map)
│   │
│   ├── dream_ipc/                      # Inter-thread communication
│   │   ├── Cargo.toml
│   │   └── src/
│   │       └── lib.rs                  # EngineCommand, MasterClock, rtrb queues
│   │
│   ├── dream_engine/                   # Audio engine & real-time driver
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs                  # Crate root, RT safety rules
│   │       └── driver.rs              # start_audio_thread(), cpal callback
│   │
│   ├── dream_graph/                    # Audio routing graph (DAG + RCU + PDC)
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs                  # Module declarations
│   │       ├── dag.rs                  # AudioDag, AudioNode, ExecutionPlan
│   │       ├── rcu.rs                  # LiveGraph (arc-swap atomic snapshots)
│   │       └── pdc.rs                  # Plugin Delay Compensation algorithm
│   │
│   ├── dream_dsp/                      # DSP utilities
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs                  # Crate root
│   │       ├── fades.rs               # Hann window micro-fades, FadeCache
│   │       └── resampler.rs           # rubato-based sample rate conversion
│   │
│   ├── dream_renderer/                 # GPU timeline renderer (wgpu)
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs                  # Crate root
│   │       ├── gpu_types.rs           # ClipInstance, ViewportUniforms, etc.
│   │       ├── viewport.rs            # Viewport (pixel ↔ sample mapping)
│   │       └── timeline.rs            # TimelineRenderer (render pipeline)
│   │
│   ├── dream_plugins/                  # Plugin hosting framework
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs                  # Crate root
│   │       ├── descriptor.rs          # PluginDescriptor (metadata)
│   │       ├── format.rs              # PluginFormat enum (VST3/CLAP/AU)
│   │       ├── scanner.rs             # PluginScanner (filesystem discovery)
│   │       └── instance.rs            # PluginInstance trait
│   │
│   ├── dream_io/                       # Audio file I/O & project serialization
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs                  # Crate root
│   │       ├── audio_reader.rs        # AudioBuffer, AudioReader (symphonia)
│   │       ├── peak_cache.rs          # PeakCache, WaveformPeaks (mip-mapped)
│   │       ├── wav_writer.rs          # WavWriter (hound, 16/24/32-bit)
│   │       └── project_file.rs        # ProjectFile (JSON serialization)
│   │
│   ├── dream_mixer/                    # Real-time mixer engine
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs                  # Crate root
│   │       ├── gain.rs                # dB ↔ linear conversion, apply_gain
│   │       ├── pan.rs                 # PanLaw, constant-power panning
│   │       ├── meter.rs               # VuMeter (peak + RMS ballistics)
│   │       └── bus.rs                 # SummingBus (track → master mixing)
│   │
│   ├── dream_transport/                # Transport state machine
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs                  # Crate root
│   │       ├── state.rs               # TransportState, TransportCommand
│   │       ├── playhead.rs            # Playhead (sample-accurate position)
│   │       └── loop_region.rs         # LoopRegion (seamless looping)
│   │
│   ├── dream_clip_engine/              # Clip playback engine
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs                  # Crate root
│   │       ├── scheduler.rs           # ClipScheduler (overlap detection)
│   │       ├── reader.rs              # ClipReader (pre-loaded sample read)
│   │       └── pool.rs               # ClipPool (Arc-shared audio data)
│   │
│   └── dream_automation/               # Automation curves & modes
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs                  # Crate root
│           ├── curve.rs               # AutomationCurve (4 interpolation modes)
│           ├── mode.rs                # AutomationMode (Off/Read/Write/Touch/Latch)
│           └── lane.rs               # AutomationLane (parameter binding)
│
├── apps/
│   └── desktop_host/                   # Tauri v2 desktop application
│       ├── Cargo.toml                  # Depends on dream_models, dream_ipc, dream_engine
│       ├── build.rs                   # tauri_build::build()
│       ├── tauri.conf.json            # Window config, CSP, build paths
│       └── src/
│           ├── lib.rs                  # AudioEngineHandle, IPC commands
│           └── main.rs               # Desktop entry point → run()
│
└── frontend/
    └── ui_app/                         # React + Vite frontend
        ├── package.json               # Dependencies, scripts
        ├── vite.config.ts             # Vite build config
        ├── tsconfig.json              # TypeScript config
        └── src/
            ├── main.tsx               # React entry point → <Workspace />
            ├── global.css             # Tailwind v4 @theme bridge
            ├── pages/
            │   └── Workspace.tsx      # Single page → <DawShell />
            ├── app/
            │   ├── layouts/
            │   │   └── DawShell.tsx   # Hole-Punch Layout architecture
            │   └── styles/
            │       ├── tokens.css     # 170+ design tokens (from DreamTheme.swift)
            │       ├── glass.css      # Glassmorphism + animations
            │       ├── reset.css      # Global resets, scrollbars
            │       └── plugin-rack.css # Device node styling
            └── widgets/
                ├── TransportBar/
                │   └── TransportBar.tsx    # BPM, transport controls, position
                ├── AssetBrowser/
                │   └── AssetBrowser.tsx    # File browser with categories
                ├── DeviceRack/
                │   └── DeviceRack.tsx      # Plugin chain with knobs
                ├── TrackInspector/
                │   └── TrackInspector.tsx   # Track list + mixer strip
                └── StatusBar/
                    └── StatusBar.tsx        # Bottom info bar
```

---

## 4. Root Configuration Files

### 4.1 `Cargo.toml` — Workspace Root

**Path**: `/Cargo.toml`  
**Purpose**: Defines the Cargo workspace, listing all member crates and shared dependencies.

**Key Sections:**

```toml
[workspace]
members = [
    "core/dream_models",
    "core/dream_ipc",
    "core/dream_engine",
    "core/dream_graph",
    "core/dream_dsp",
    "core/dream_renderer",
    "core/dream_plugins",
    "core/dream_io",
    "core/dream_mixer",
    "core/dream_transport",
    "core/dream_clip_engine",
    "core/dream_automation",
    "apps/desktop_host",
]
resolver = "2"
```

**Shared Dependencies** (managed via `[workspace.dependencies]`):
- `serde` + `serde_json` — Serialization for all data structures
- `ts-rs` — Auto-generates TypeScript type definitions from Rust structs
- `uuid` — Universally unique identifiers for tracks, clips, projects
- `log` — Logging facade used across all crates
- `rtrb` — Lock-free SPSC ring buffer for inter-thread communication
- `cpal` — Cross-platform audio I/O
- `rubato` — High-quality sample rate conversion
- `wgpu` + `bytemuck` — GPU rendering and safe transmutation
- `petgraph` — Graph data structure library
- `arc-swap` — Atomic reference-counted pointer swapping (RCU)
- `symphonia` — Audio codec library (decode WAV/FLAC/OGG/MP3/AIFF)
- `hound` — WAV file writer
- `tauri` — Desktop application framework (v2)

**Release Profile:**
```toml
[profile.release]
opt-level = 3
lto = "fat"
codegen-units = 1
strip = true
```
Enterprise-grade: Full LTO eliminates dead code across crate boundaries, `codegen-units = 1` maximizes LLVM optimization, `strip = true` removes debug symbols for minimal binary size.

---

### 4.2 `pnpm-workspace.yaml`

**Path**: `/pnpm-workspace.yaml`  
**Purpose**: Defines the JavaScript/TypeScript workspace packages for pnpm.

```yaml
packages:
  - "frontend/ui_app"
  - "apps/desktop_host"
```

This enables `pnpm install` from the root to resolve dependencies for both the frontend and the Tauri desktop host.

---

### 4.3 `.gitignore`

**Path**: `/.gitignore`  
**Key Exclusions:**
- `.DS_Store` — macOS metadata
- `target/` — Rust build output (debug + release)
- `*.xcodeproj`, `*.xcworkspace`, `DerivedData/` — Legacy Swift/Xcode artifacts
- `node_modules/`, `dist/` — JavaScript build artifacts
- `SWIFT UI Archive/` — Archived Swift UI code (legacy)
- `*.profdata`, `*.profraw` — Profiling data

---

## 5. Core Rust Crates

### 5.1 `dream_models` — Canonical Data Structures

**Path**: `core/dream_models/`  
**Role**: **Single Source of Truth (SSOT)** for all data structures shared between the engine, IPC, and frontend.  
**Dependencies**: `serde`, `serde_json`, `ts-rs`, `uuid`  
**Dependents**: Every other crate in the workspace.

#### `src/lib.rs` — Crate Root (95 lines)

Re-exports all public types and declares three submodules:

```rust
pub mod project;
pub mod pulse_map;
pub mod time;
```

**Key Type — `PlaybackState`:**
```rust
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PlaybackState {
    pub is_playing: bool,
    pub sample_position: i64,
    pub sample_rate: f64,
    pub bpm: f64,
    pub time_seconds: f64,
    pub beat_position: f64,
    pub bar: i32,
    pub beat_in_bar: i32,
}
```

This is the **canonical transport snapshot** sent from Rust to TypeScript via Tauri IPC. The `#[ts(export)]` attribute auto-generates the corresponding TypeScript interface. It contains both sample-accurate position (`sample_position: i64`) and derived musical time (`bar`, `beat_in_bar`, `beat_position`).

**Connections:**
- Used by `dream_ipc` and `dream_engine` to report engine state to the UI.
- The TypeScript interface is consumed by `TransportBar.tsx` and `StatusBar.tsx`.

---

#### `src/time.rs` — AbsoluteTime (202 lines)

**Purpose**: Sample-accurate time representation. All timing in the DAW uses `AbsoluteTime` instead of floating-point seconds to eliminate accumulation errors.

**Key Type:**
```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct AbsoluteTime {
    frames: i64,
}
```

**Key Methods:**
| Method | Signature | Purpose |
|--------|-----------|---------|
| `new` | `fn new(frames: i64) -> Self` | Create from raw sample frames |
| `from_seconds` | `fn from_seconds(secs: f64, sr: f64) -> Self` | Convert seconds → frames |
| `from_beats` | `fn from_beats(beats: f64, pm: &PulseMap, sr: f64) -> Self` | Convert musical beats → frames via tempo map |
| `to_seconds` | `fn to_seconds(&self, sr: f64) -> f64` | Convert frames → seconds |
| `to_beats` | `fn to_beats(&self, pm: &PulseMap, sr: f64) -> f64` | Convert frames → beats via tempo map |
| `as_frames` | `fn as_frames(&self) -> i64` | Raw frame count accessor |

**Arithmetic Operators**: Implements `Add`, `Sub`, `AddAssign`, `SubAssign` for sample-accurate arithmetic.

**Constants:**
- `AbsoluteTime::ZERO` — The timeline origin (frame 0).

**Design Rationale**: Using `i64` frames (not `f64` seconds) prevents floating-point drift when accumulating buffer-sized increments over hours of playback. At 192kHz, `i64` provides ~1.5 million years of addressable time.

**Connections:**
- Used by `dream_clip_engine` for clip start/end positions.
- Used by `dream_transport` for playhead position.
- Used by `dream_io::project_file` for serializing clip boundaries.
- Used by `dream_automation` for breakpoint positions.

---

#### `src/pulse_map.rs` — Tempo Map (351 lines)

**Purpose**: Converts between sample frames and musical time (beats, bars). Supports both constant and variable tempo.

**Key Types:**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TempoEvent {
    pub beat_position: f64,     // Musical position (beats from origin)
    pub bpm: f64,               // Tempo at this point
    pub sample_position: i64,   // Cached sample position (computed)
}

pub struct PulseMap {
    events: Vec<TempoEvent>,
    sample_rate: f64,
}
```

**Key Methods:**
| Method | Purpose | Complexity |
|--------|---------|------------|
| `new(bpm, sample_rate)` | Create constant-tempo map | O(1) |
| `add_tempo_change(beat, bpm)` | Add a tempo automation point | O(n) (re-sorts) |
| `beats_to_samples(beats)` | Convert beats → sample frames | O(log n) binary search |
| `samples_to_beats(samples)` | Convert sample frames → beats | O(log n) binary search |
| `bpm_at_sample(sample)` | Query tempo at a specific position | O(log n) |
| `bpm_at_beat(beat)` | Query tempo at a beat position | O(log n) |

**Algorithm**: For variable tempo, `PulseMap` stores sorted `TempoEvent`s. Conversion uses binary search to find the relevant tempo region, then linear interpolation within that region. Sample positions are cached in each event for O(1) lookup after the initial binary search.

**Connections:**
- Used by `AbsoluteTime::from_beats()` and `AbsoluteTime::to_beats()`.
- Used by `dream_transport` for musical-time-aware playhead movement.
- Used by `dream_renderer::viewport` for grid line positioning.

---

#### `src/project.rs` — Project Data Model (160+ lines)

**Purpose**: Defines the top-level project structure, tracks, and clips.

**Key Types:**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: Uuid,
    pub name: String,
    pub bpm: f64,
    pub sample_rate: f64,
    pub tracks: Vec<Track>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub id: Uuid,
    pub name: String,
    pub volume: f64,        // Linear gain (0.0 – 1.0+)
    pub pan: f64,           // -1.0 (L) to +1.0 (R)
    pub is_mute: bool,
    pub is_solo: bool,
    pub clips: Vec<AudioClip>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioClip {
    pub id: Uuid,
    pub name: String,
    pub source_path: String,
    pub start: AbsoluteTime,
    pub end: AbsoluteTime,
}
```

**Key Methods:**
- `Project::new(name, bpm, sample_rate)` — Creates a new project with defaults.
- `Project::add_track(track)` — Appends a track.
- `Project::track_count()` — Returns number of tracks.
- `Track::new(name)` — Creates a track with default volume=1.0, pan=0.0.
- `AudioClip::new(name, path, start, end)` — Creates a clip with UUID.

**Connections:**
- Serialized/deserialized by `dream_io::project_file`.
- Track mixer fields (`volume`, `pan`, `is_mute`, `is_solo`) are read by `dream_mixer`.
- Clips are scheduled by `dream_clip_engine::ClipScheduler`.

---

### 5.2 `dream_ipc` — Inter-Thread Communication

**Path**: `core/dream_ipc/`  
**Role**: Lock-free communication bridge between the UI thread and the real-time audio callback.  
**Dependencies**: `rtrb`, `dream_models`  
**Dependents**: `dream_engine`, `desktop_host`

#### `src/lib.rs` (169 lines)

**Key Types:**

```rust
pub enum EngineCommand {
    Play,
    Stop,
    SetFrequency(f32),
    SetVolume(f32),
    Seek(i64),
}
```

Each variant represents a command that can cross the real-time boundary. The enum is `Copy`-sized (no heap allocations), ensuring it can be pushed into the ring buffer without allocating.

**MasterClock — Atomic Timekeeping:**
```rust
pub struct MasterClock {
    position: AtomicI64,
}

impl MasterClock {
    pub fn new() -> Self { ... }
    pub fn get(&self) -> i64 { self.position.load(Ordering::Relaxed) }
    pub fn set(&self, pos: i64) { self.position.store(pos, Ordering::Relaxed) }
    pub fn advance(&self, delta: i64) { self.position.fetch_add(delta, Ordering::Relaxed) }
}
```

`MasterClock` uses `AtomicI64` with `Relaxed` ordering — sufficient because the audio thread is the sole writer and the UI thread is a reader that tolerates stale-by-one-buffer values. This avoids the overhead of `SeqCst` barriers.

**Ring Buffer Setup:**
```rust
pub fn create_command_queue(capacity: usize) -> (Producer<EngineCommand>, Consumer<EngineCommand>)
```
Creates an `rtrb` SPSC (Single-Producer, Single-Consumer) ring buffer. The producer lives on the UI thread; the consumer is polled non-blockingly in the audio callback.

**Real-Time Safety Guarantees:**
- `rtrb::Consumer::pop()` is wait-free (no CAS loops)
- `AtomicI64` load/store are single instructions on x86-64 and ARM64
- No allocations, no locks, no I/O on the consumer side

**Connections:**
- Producer is held by `desktop_host::AudioEngineHandle` (UI thread)
- Consumer is passed to `dream_engine::driver::start_audio_thread()` (audio thread)
- `MasterClock` is shared via `Arc<MasterClock>` between both threads

---

### 5.3 `dream_engine` — Audio Engine & Driver

**Path**: `core/dream_engine/`  
**Role**: Initializes the platform audio subsystem via `cpal` and runs the real-time audio callback.  
**Dependencies**: `cpal`, `rtrb`, `dream_models`, `dream_ipc`  
**Dependents**: `desktop_host`

#### `src/lib.rs` (17 lines)

Declares the `driver` module and documents the **RT Safety Contract**:

```
// ═══ REAL-TIME SAFETY RULES ═══
// The audio callback MUST NOT:
//   1. Allocate heap memory (no Vec::push, no Box::new, no String)
//   2. Acquire any lock (no Mutex, no RwLock, no channel recv)
//   3. Perform I/O (no file reads, no network, no logging)
//   4. Panic (no unwrap on None/Err — use fallback values)
```

#### `src/driver.rs` (193 lines)

**Key Function — `start_audio_thread()`:**

```rust
pub fn start_audio_thread(
    command_rx: Consumer<EngineCommand>,
    clock: Arc<MasterClock>,
) -> Result<cpal::Stream, Box<dyn Error>>
```

**Initialization Flow:**
1. Queries the default audio output device via `cpal::default_host()`
2. Selects the preferred output config (sample rate, channels, buffer size)
3. Creates a `cpal::Stream` with a closure that becomes the audio callback

**Audio Callback Logic (per buffer):**
1. **Drain command queue**: Pops all pending `EngineCommand`s from the ring buffer
2. **Update state**: Applies Play/Stop/SetFrequency/SetVolume/Seek commands
3. **Generate audio**: If playing, synthesizes a sine wave at the current frequency
4. **Advance clock**: Calls `clock.advance(buffer_len)` to update the atomic playhead
5. **Fill output buffer**: Writes f32 samples to the `cpal` output buffer

**Error Handling**: The error callback logs device errors without panicking. Stream creation errors propagate to the caller.

**Connections:**
- Called by `desktop_host::lib.rs` during Tauri app setup
- Receives commands from `desktop_host` IPC handlers
- Updates `MasterClock` which is polled by `desktop_host::get_state()`

---

### 5.4 `dream_graph` — Audio Routing Graph

**Path**: `core/dream_graph/`  
**Role**: Implements the audio processing graph as a Directed Acyclic Graph (DAG) with zero-wait mutations and plugin delay compensation.  
**Dependencies**: `petgraph`, `arc-swap`, `uuid`  
**Dependents**: `dream_engine` (future integration)

#### `src/lib.rs` (24 lines)

Declares three modules:
```rust
pub mod dag;    // Graph structure
pub mod rcu;    // Atomic graph swapping
pub mod pdc;    // Plugin delay compensation
```

#### `src/dag.rs` — Audio DAG (491 lines)

**Key Types:**

```rust
// Unique identifier for graph nodes
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NodeId(pub Uuid);

// What kind of processing a node performs
#[derive(Debug, Clone)]
pub enum NodeKind {
    Input,          // Audio input device
    Output,         // Audio output device  
    Track,          // Track channel strip
    Plugin(String), // VST3/CLAP/AU plugin instance
    Bus,            // Summing bus
    Send,           // Auxiliary send
}

// A node in the audio processing graph
#[derive(Debug, Clone)]
pub struct AudioNode {
    pub id: NodeId,
    pub kind: NodeKind,
    pub latency_samples: u32,  // Plugin-reported latency (for PDC)
    pub channels: u32,         // Number of audio channels
}

// An edge representing audio signal flow
#[derive(Debug, Clone)]
pub struct AudioEdge {
    pub gain: f32,             // Connection gain (default 1.0)
}

// The audio processing graph
pub struct AudioDag {
    graph: StableDiGraph<AudioNode, AudioEdge>,
    node_map: HashMap<NodeId, NodeIndex>,
}

// Topologically sorted processing order
pub struct ExecutionPlan {
    pub order: Vec<NodeIndex>,
    pub graph: StableDiGraph<AudioNode, AudioEdge>,
}
```

**Key Methods:**

| Method | Purpose |
|--------|---------|
| `AudioDag::new()` | Creates an empty graph |
| `add_node(node)` | Inserts a node, returns `NodeIndex` |
| `remove_node(id)` | Removes a node and all its edges |
| `connect(from, to, edge)` | Adds a directed edge (validates no cycles) |
| `disconnect(from, to)` | Removes an edge |
| `has_cycle()` | Validates DAG property using DFS |
| `build_execution_plan()` | Topological sort → `ExecutionPlan` |
| `node_count()`, `edge_count()` | Graph size queries |
| `neighbors(id)` | Returns downstream nodes |

**Cycle Detection**: Uses `petgraph::algo::is_cyclic_directed()` — O(V+E). Called before adding edges to maintain the DAG invariant. If a cycle would be created, `connect()` returns `Err(GraphError::CycleDetected)`.

**Connections:**
- `ExecutionPlan` is consumed by `rcu::LiveGraph` for atomic publishing.
- Node latency values are read by `pdc::compute_delay_compensation()`.

---

#### `src/rcu.rs` — Read-Copy-Update (225 lines)

**Purpose**: Enables the UI thread to update the audio graph without blocking the audio callback.

**Key Type:**
```rust
pub struct LiveGraph {
    shared: Arc<ArcSwap<ExecutionPlan>>,
}
```

**Key Methods:**

| Method | Thread | Purpose |
|--------|--------|---------|
| `LiveGraph::new(plan)` | Any | Creates a new LiveGraph with initial plan |
| `load()` | Audio thread | Returns `Guard<Arc<ExecutionPlan>>` — zero-cost read |
| `swap_graph(new_plan)` | UI thread | Atomically replaces the execution plan |
| `clone()` | Any | Creates a new handle to the same shared state |

**How RCU Works:**
1. **UI thread** builds a new `AudioDag`, computes `ExecutionPlan` via topological sort
2. **UI thread** calls `live_graph.swap_graph(new_plan)` — atomic pointer swap via `arc-swap`
3. **Audio thread** calls `live_graph.load()` — returns the current plan instantly
4. The old plan is dropped when no threads reference it (via `Arc` reference counting)

**Performance**: `load()` compiles to a single atomic load instruction. No CAS loops, no retries, no spin-waiting. The audio thread never blocks.

---

#### `src/pdc.rs` — Plugin Delay Compensation (321 lines)

**Purpose**: Ensures sample-accurate phase alignment across all parallel processing paths, compensating for plugin-reported latency.

**Algorithm**: Bottom-up longest-path traversal of the DAG.

```
Input → [Plugin A: 512 samples latency] → Output
Input → [Plugin B: 0 samples latency]   → Output
```

Without PDC, Plugin B's output would arrive 512 samples early. PDC inserts a 512-sample delay buffer on Plugin B's path.

**Key Function:**
```rust
pub fn compute_delay_compensation(
    dag: &AudioDag,
) -> Vec<u32>  // Indexed by NodeIndex — delay in samples per node
```

**Algorithm Steps:**
1. Compute the cumulative latency from each node to the graph output (longest path)
2. For each node, the required delay = max_cumulative_latency - node_cumulative_latency
3. Return a vector of per-node delay values

**Tests**: Validates with diamond-shaped graphs, serial chains, and complex multi-path topologies.

---

### 5.5 `dream_dsp` — DSP Utilities

**Path**: `core/dream_dsp/`  
**Role**: Pure DSP functions operating on audio buffers. No I/O, no threading, no OS dependencies.  
**Dependencies**: `rubato`  
**Dependents**: `dream_clip_engine`, `dream_renderer`

#### `src/lib.rs` (19 lines)

Declares two modules:
```rust
pub mod fades;
pub mod resampler;
```

#### `src/fades.rs` — Micro-Fades (309 lines)

**Purpose**: Generates Hann-window micro-fades to prevent audible clicks at clip boundaries.

**Key Types:**

```rust
pub struct FadeCache {
    fade_in: Vec<f32>,     // Pre-computed fade-in curve
    fade_out: Vec<f32>,    // Pre-computed fade-out curve
    length: usize,         // Fade length in samples
}
```

**Key Functions:**

| Function | Purpose |
|----------|---------|
| `compute_fade_length(sample_rate)` | Returns 64 samples (≈1.5ms at 44.1kHz) |
| `generate_hann_fade_in(length)` | Creates ascending Hann window: `0.5 * (1.0 - cos(π * i / len))` |
| `generate_hann_fade_out(length)` | Creates descending Hann window |
| `apply_fade_in(buffer, curve)` | Multiplies buffer start by fade curve |
| `apply_fade_out(buffer, curve)` | Multiplies buffer end by fade curve |
| `FadeCache::new(sample_rate)` | Pre-computes both curves for RT use |
| `FadeCache::apply_fades(buffer)` | Applies both fades in-place |

**Real-Time Safety**: `FadeCache` pre-computes the curves on construction. `apply_fades()` performs only multiplication — no allocations, no branches.

**Why Hann Window?** The Hann window has zero derivative at endpoints, ensuring the smoothest possible transition. This eliminates high-frequency transients (clicks) that would occur with linear fades.

**Connections:**
- Used by `dream_clip_engine::ClipReader` to fade clip boundaries.

---

#### `src/resampler.rs` — Sample Rate Conversion (247 lines)

**Purpose**: High-quality sample rate conversion using the `rubato` crate (polyphase FIR filter).

**Key Functions:**

```rust
pub fn resample_mono(
    input: &[f32],
    from_rate: f64,
    to_rate: f64,
) -> Result<Vec<f32>, ResampleError>

pub fn resample_channels(
    channels: &[Vec<f32>],
    from_rate: f64,
    to_rate: f64,
) -> Result<Vec<Vec<f32>>, ResampleError>
```

**Algorithm**: Uses `rubato::FftFixedInOut` — an FFT-based resampler that processes fixed-size blocks. Quality is set to `SincInterpolationParameters` with 256-tap filter for transparent conversion.

**⚠️ NOT Real-Time Safe**: This function allocates memory and should only be called on worker threads (e.g., when importing audio files at a different sample rate).

**Connections:**
- Used by `dream_io::AudioReader` when imported files don't match the project sample rate.
- Used by `dream_clip_engine::ClipPool` during clip pre-loading.


---

### 5.6 `dream_renderer` — GPU Timeline Renderer

**Path**: `core/dream_renderer/`  
**Role**: Cross-platform GPU-accelerated rendering of the DAW timeline, waveforms, and MIDI notes using `wgpu`.  
**Dependencies**: `wgpu`, `bytemuck`  
**Dependents**: Frontend (via WASM or native surface)

#### `src/lib.rs` (26 lines)

Declares three modules:
```rust
pub mod gpu_types;
pub mod viewport;
pub mod timeline;
```

#### `src/gpu_types.rs` — GPU Data Structures (284 lines)

Defines all data types that are uploaded to the GPU via uniform/storage buffers. Every struct derives `bytemuck::Pod` + `bytemuck::Zeroable` for safe zero-copy GPU upload.

**Key Types:**

| Type | Fields | Purpose |
|------|--------|---------|
| `ClipInstance` | `x, y, width, height, color_r/g/b/a, clip_type, waveform_offset, waveform_count` | Per-clip data for instanced rendering |
| `MidiNoteInstance` | `x, y, width, height, velocity, channel, is_selected` | Per-note data for piano roll rendering |
| `ViewportUniforms` | `view_proj (mat4), viewport_size, scroll_offset, samples_per_pixel, beat_grid_interval` | Camera/zoom state uploaded each frame |
| `WaveformPeakBuffer` | `peaks: Vec<f32>`, `push_peaks()`, `gpu_buffer()` | Manages dynamic peak data GPU upload |

**Design**: All types use `#[repr(C)]` for deterministic memory layout matching the WGSL shader expectations. Padding bytes are explicit to match GPU alignment requirements (16-byte for vec4, 64-byte for mat4).

**Connections:**
- `ClipInstance` is populated from `dream_models::AudioClip` positions.
- `ViewportUniforms` is computed from `viewport::Viewport` state.
- `WaveformPeakBuffer` receives data from `dream_io::PeakCache`.

---

#### `src/viewport.rs` — Viewport / Camera (181 lines)

**Purpose**: Maps between screen pixels and audio sample frames. Manages zoom level, scroll position, and visible range.

**Key Type:**
```rust
pub struct Viewport {
    pub scroll_x: f64,            // Horizontal scroll (in samples)
    pub scroll_y: f64,            // Vertical scroll (in pixels)
    pub samples_per_pixel: f64,   // Zoom level (lower = more zoomed in)
    pub width_pixels: f64,        // Canvas width
    pub height_pixels: f64,       // Canvas height
}
```

**Key Methods:**

| Method | Purpose |
|--------|---------|
| `pixel_to_sample(px)` | Convert screen X → sample position |
| `sample_to_pixel(sample)` | Convert sample position → screen X |
| `visible_sample_range()` | Returns `(start_sample, end_sample)` of visible region |
| `zoom_at(center_px, factor)` | Zoom in/out centered on a pixel position |
| `zoom_range()` | Returns `(min_spp, max_spp)` limits |
| `to_uniforms()` | Generates `ViewportUniforms` for GPU upload |

**Zoom Levels**: `samples_per_pixel` ranges from ~0.1 (maximum zoom, sub-sample resolution) to ~65536 (full project overview). The zoom function preserves the sample position under the cursor.

**Connections:**
- Read by `TimelineRenderer` to compute `ViewportUniforms`.
- Used by frontend scroll/zoom event handlers.
- `visible_sample_range()` determines which clips need to be rendered.

---

#### `src/timeline.rs` — Timeline Renderer (339 lines)

**Purpose**: Orchestrates the full GPU rendering pipeline — compiles shaders, manages buffers, and issues draw calls.

**Key Type:**
```rust
pub struct TimelineRenderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::RenderPipeline,
    uniform_buffer: wgpu::Buffer,
    clip_instance_buffer: wgpu::Buffer,
    waveform_buffer: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
}
```

**Initialization Flow:**
1. Request `wgpu::Adapter` (selects best GPU)
2. Create `Device` and `Queue`
3. Compile WGSL shader source into `ShaderModule`
4. Create vertex/fragment pipeline with instanced rendering
5. Allocate GPU buffers for uniforms, clip instances, and waveform peaks
6. Create bind group layout connecting buffers to shader bindings

**Render Loop (per frame):**
1. Update `ViewportUniforms` from current `Viewport` state
2. Upload visible `ClipInstance` array to GPU
3. Upload waveform peak data for visible clips
4. Create render pass with `wgpu::CommandEncoder`
5. Draw clips via instanced rendering (`draw_indexed(0..6, 0..clip_count)`)
6. Submit command buffer to GPU queue

**WGSL Shader**: The vertex shader positions clip rectangles using instance data and viewport uniforms. The fragment shader renders clip backgrounds with rounded corners, waveform visualization, and selection highlights.

**Connections:**
- Receives `Viewport` from UI scroll/zoom state.
- Receives `ClipInstance` data built from `dream_models::AudioClip` list.
- Receives peak data from `dream_io::PeakCache`.
- Outputs to the WebGPU canvas surface (Layer 0 of the Hole-Punch architecture).

---

### 5.7 `dream_plugins` — Plugin Hosting Framework

**Path**: `core/dream_plugins/`  
**Role**: Foundation for hosting VST3, CLAP, and Audio Unit plugins.  
**Dependencies**: `uuid`, `serde`, `log`  
**Dependents**: `dream_graph` (future: nodes wrap `PluginInstance`)

#### `src/descriptor.rs` — Plugin Metadata

```rust
pub struct PluginDescriptor {
    pub id: Uuid,
    pub name: String,
    pub vendor: String,
    pub version: String,
    pub format: PluginFormat,
    pub category: PluginCategory,
    pub path: PathBuf,
    pub num_inputs: u32,
    pub num_outputs: u32,
    pub has_editor: bool,
    pub latency_samples: u32,
}
```

Each descriptor represents a discovered plugin on disk. It stores the plugin's reported latency for PDC calculations.

**`PluginCategory`**: `Instrument`, `Effect`, `Analyzer`, `Utility`, `Other`.

---

#### `src/format.rs` — Plugin Format Enum

```rust
pub enum PluginFormat {
    Vst3,
    Clap,
    AudioUnit,
    Internal,
}
```

Platform-specific extensions:
- **VST3**: `.vst3` bundles (macOS/Windows/Linux)
- **CLAP**: `.clap` bundles (cross-platform)
- **AU**: `.component` bundles (macOS only)
- **Internal**: Built-in Dream DAW processors

Each format provides a `scan_paths()` classmethod returning the standard system directories for plugin discovery.

---

#### `src/scanner.rs` — Plugin Scanner

```rust
pub struct PluginScanner;

impl PluginScanner {
    pub fn scan_all() -> Vec<PluginDescriptor>;
    pub fn scan_directory(path: &Path, format: PluginFormat) -> Vec<PluginDescriptor>;
    pub fn scan_file(path: &Path) -> Option<PluginDescriptor>;
}
```

Recursively walks standard plugin directories, filters by file extension, and extracts metadata. The scan runs on a background thread — results are sent to the UI via a channel.

**Standard Paths (macOS):**
- VST3: `/Library/Audio/Plug-Ins/VST3/`, `~/Library/Audio/Plug-Ins/VST3/`
- CLAP: `/Library/Audio/Plug-Ins/CLAP/`, `~/Library/Audio/Plug-Ins/CLAP/`
- AU: `/Library/Audio/Plug-Ins/Components/`, `~/Library/Audio/Plug-Ins/Components/`

---

#### `src/instance.rs` — Plugin Instance Trait

```rust
pub trait PluginInstance: Send {
    fn descriptor(&self) -> &PluginDescriptor;
    fn activate(&mut self, sample_rate: f64, max_block_size: usize) -> Result<(), PluginError>;
    fn deactivate(&mut self);
    fn process(&mut self, inputs: &[&[f32]], outputs: &mut [&mut [f32]], num_frames: usize);
    fn get_latency(&self) -> u32;
    fn get_parameter_count(&self) -> u32;
    fn get_parameter_value(&self, index: u32) -> f32;
    fn set_parameter_value(&mut self, index: u32, value: f32);
    fn get_parameter_name(&self, index: u32) -> String;
    fn has_editor(&self) -> bool;
}
```

This trait provides a **format-agnostic interface** for all plugin types. The `process()` method takes raw audio buffers — the plugin reads inputs and writes outputs. Future implementations will wrap format-specific APIs (VST3 COM interfaces, CLAP C API, AU Objective-C bridge).

**Design**: The `Send` bound allows moving plugin instances between threads. `process()` is designed to be called from the audio thread (the implementation must be RT-safe).

---

### 5.8 `dream_io` — Audio File I/O & Project Serialization

**Path**: `core/dream_io/`  
**Role**: All disk I/O operations — reading audio files, generating waveform peaks, writing WAV exports, and serializing project files.  
**Dependencies**: `symphonia`, `hound`, `serde_json`, `dream_models`  
**Dependents**: `dream_clip_engine`, `dream_renderer`, `desktop_host`

**⚠️ IMPORTANT**: All operations in this crate are **NOT real-time safe**. They must run on worker threads.

#### `src/audio_reader.rs` — Audio Decoder (362 lines)

**Key Types:**

```rust
pub struct AudioBuffer {
    pub channels: Vec<Vec<f32>>,   // De-interleaved f32 per channel
    pub sample_rate: u32,
    pub num_frames: usize,
}
```

**Key Methods:**

| Method | Purpose |
|--------|---------|
| `AudioReader::read(path)` | Decodes entire file → `AudioBuffer` |
| `AudioReader::read_metadata(path)` | Reads header only → `(sample_rate, channels, frames)` |
| `AudioBuffer::num_channels()` | Channel count |
| `AudioBuffer::duration_seconds()` | Duration in seconds |
| `AudioBuffer::channel(idx)` | Reference to channel data |
| `AudioBuffer::to_mono()` | Averages all channels → mono `Vec<f32>` |

**Supported Formats** (via `symphonia`): WAV, FLAC, OGG Vorbis, MP3, AIFF, AAC, ALAC.

**Decoding Flow:**
1. Opens file as `MediaSourceStream`
2. Probes format and creates appropriate decoder
3. Iterates over all packets, decoding into `SampleBuffer<f32>`
4. De-interleaves into per-channel `Vec<f32>`
5. Returns `AudioBuffer` with metadata

**Error Types**: `AudioReaderError` with variants: `FileNotFound`, `UnsupportedFormat`, `DecodeError`, `NoAudioTrack`.

**Tests** (6): Mono mixdown empty, mono passthrough, stereo-to-mono, duration calculation, nonexistent file error, error display formatting.

---

#### `src/peak_cache.rs` — Waveform Peak Generation (269 lines)

**Purpose**: Generates multi-resolution waveform peak data for efficient GPU rendering at any zoom level.

**Key Types:**

```rust
pub struct PeakPair {
    pub min: f32,
    pub max: f32,
}

pub struct PeakMipLevel {
    pub samples_per_peak: usize,
    pub peaks: Vec<PeakPair>,
}

pub struct WaveformPeaks {
    pub source_id: String,
    pub sample_rate: u32,
    pub total_samples: usize,
    pub levels: Vec<PeakMipLevel>,   // 4 mip levels
}
```

**Mip Levels**: `[256, 1024, 4096, 16384]` samples per peak. The renderer selects the level closest to the current `samples_per_pixel` to avoid aliasing while minimizing data transfer.

**Key Methods:**

| Method | Purpose |
|--------|---------|
| `PeakCache::generate(samples, id, sr)` | Generates all 4 mip levels |
| `PeakCache::compute_peaks(samples, spp)` | Single-level peak computation |
| `PeakCache::best_mip_level(spp)` | Selects optimal level for zoom |
| `PeakCache::extract_amplitudes(peaks, level)` | Flat f32 array for GPU upload |
| `PeakPair::amplitude()` | `max(abs(min), abs(max))` |

**Tests** (8): All mip levels generated, correct peak count, coarser = fewer, amplitude calculation, level selection, extraction length, empty input, serialization roundtrip.

**Connections:**
- Input: `AudioBuffer::to_mono()` from `AudioReader`.
- Output: `WaveformPeaks` → `dream_renderer::gpu_types::WaveformPeakBuffer`.

---

#### `src/wav_writer.rs` — WAV Export (256 lines)

**Purpose**: Writes audio data to WAV files using the `hound` crate.

**Key Methods:**

| Method | Purpose |
|--------|---------|
| `WavWriter::write_interleaved(path, samples, sr, ch, bits)` | Writes interleaved f32 → WAV |
| `WavWriter::write_channels(path, channels, sr, bits)` | Writes de-interleaved channels → WAV |

**Supported Bit Depths**: 16-bit (integer), 24-bit (integer), 32-bit (float).

**Conversion**: For 16/24-bit output, f32 samples are clamped to [-1.0, 1.0] and scaled to the integer range. For 32-bit, samples are written as-is.

**Error Handling**: `WavWriterError` with `WriteError` and `InvalidData` variants. Validates: non-empty channels, matching channel lengths, supported bit depth (rejects 8-bit, etc.).

**Tests** (6): Mono 16-bit, stereo 24-bit, 32-bit float, unsupported bit depth error, empty channels error, mismatched lengths error.

---

#### `src/project_file.rs` — Project Serialization (190 lines)

**Purpose**: Saves and loads Dream DAW project files as JSON.

**Key Type:**
```rust
pub struct ProjectFile;  // Unit struct — all methods are static
```

**Key Methods:**

| Method | Purpose |
|--------|---------|
| `ProjectFile::save(project, path)` | Serialize `Project` → pretty-printed JSON |
| `ProjectFile::load(path)` | Deserialize JSON → `Project` |
| `ProjectFile::validate(path)` | Parse without loading (returns bool) |

**File Format**: `.dream.json` for human-readable debug files. Future: `.dream` with zstd compression for production.

**Safety**: `save()` creates parent directories via `fs::create_dir_all()`. Both methods log operations via the `log` crate.

**Tests** (5): Save/load roundtrip (verifies all fields), validate good file, validate bad file, load nonexistent, error display.

**Connections:**
- Serializes/deserializes `dream_models::project::Project`.
- Called by `desktop_host` for menu Save/Open commands.

---

### 5.9 `dream_mixer` — Real-Time Mixer Engine

**Path**: `core/dream_mixer/`  
**Role**: Real-time audio mixing — gain, panning, metering, and bus summation.  
**Dependencies**: `dream_models`  
**Dependents**: `dream_engine` (future: mixer stage in audio callback)

**⚡ All functions are REAL-TIME SAFE** — no allocations, no locks, no I/O.

#### `src/gain.rs` — Volume Processing

**Key Functions:**
```rust
pub fn db_to_linear(db: f64) -> f64     // 10^(db/20)
pub fn linear_to_db(linear: f64) -> f64  // 20 * log10(linear)
pub fn apply_gain(buffer: &mut [f32], gain: f32)  // In-place multiplication
```

**Edge Cases**: `linear_to_db(0.0)` returns `-f64::INFINITY`. `db_to_linear(-inf)` returns `0.0`.

---

#### `src/pan.rs` — Stereo Panning

**Key Type:**
```rust
pub enum PanLaw {
    ConstantPower,  // -3dB at center (industry standard)
    Linear,         // -6dB at center
}
```

**Key Function:**
```rust
pub fn apply_pan(left: &mut [f32], right: &mut [f32], pan: f64, law: PanLaw)
```

**Constant-Power Pan Law**: Uses `cos(θ)` / `sin(θ)` where `θ = (pan + 1) * π/4`. This maintains constant perceived loudness as a source moves across the stereo field. At center (pan=0), both channels receive `cos(π/4) ≈ 0.707` (-3.01 dB).

---

#### `src/meter.rs` — VU Metering

**Key Type:**
```rust
pub struct VuMeter {
    pub peak: f32,       // Current peak level
    pub rms: f32,        // Current RMS level
    attack_coeff: f32,   // Ballistics: attack smoothing
    release_coeff: f32,  // Ballistics: release smoothing
}
```

**Key Methods:**
- `VuMeter::new(sample_rate)` — Initializes with standard ballistics (attack: 0.01ms, release: 300ms).
- `process_buffer(buffer)` — Updates peak and RMS from a buffer. Peak uses instantaneous max with exponential decay. RMS uses a running average.
- `reset()` — Zeroes both values.

**Ballistics**: The attack/release coefficients model the physical response of analog VU meters. Fast attack catches transients; slow release provides readable levels.

---

#### `src/bus.rs` — Summing Bus

**Key Type:**
```rust
pub struct SummingBus {
    buffer: Vec<f32>,
    channel_count: usize,
}
```

**Key Methods:**
- `SummingBus::new(buffer_size, channels)` — Allocates the summing buffer.
- `add(source, gain)` — Adds a source buffer to the bus with gain. Uses `buffer[i] += source[i] * gain`.
- `clear()` — Zeroes the buffer for the next processing cycle.
- `output()` — Returns the summed buffer.

**Design**: The bus pre-allocates its buffer on construction. `add()` and `clear()` are pure arithmetic — RT-safe.

**Connections:**
- Reads `Track::volume`, `Track::pan`, `Track::is_mute`, `Track::is_solo` from `dream_models`.
- VU meter values are sent to the frontend for the `TrackInspector` and `DeviceRack` VU displays.

---

### 5.10 `dream_transport` — Transport State Machine

**Path**: `core/dream_transport/`  
**Role**: Manages playback state, playhead position, and loop regions.  
**Dependencies**: `dream_models`  
**Dependents**: `dream_engine`, `dream_clip_engine`

#### `src/state.rs` — Transport State

```rust
pub enum TransportState {
    Stopped,
    Playing,
    Recording,
}

pub enum TransportCommand {
    Play,
    Stop,
    Record,
    Seek(i64),          // Jump to sample position
    SetLoop(bool),      // Enable/disable looping
    SetLoopRegion(i64, i64),  // Set loop start/end
}
```

The state machine transitions:
- `Stopped → Playing` (Play command)
- `Playing → Stopped` (Stop command)
- `Stopped → Recording` (Record command)
- `Recording → Stopped` (Stop command)
- Any state: `Seek` repositions the playhead

---

#### `src/playhead.rs` — Playhead

```rust
pub struct Playhead {
    position: i64,        // Current sample position
    is_playing: bool,     // Movement state
}
```

**Key Methods:**
- `advance(num_samples)` — Moves the playhead forward (called per audio buffer).
- `seek(position)` — Jumps to an absolute sample position.
- `get_position()` — Returns current position.

The playhead is sample-accurate — no floating-point drift over time.

---

#### `src/loop_region.rs` — Loop Region

```rust
pub struct LoopRegion {
    pub start: i64,      // Loop start (sample frames)
    pub end: i64,        // Loop end (sample frames)
    pub enabled: bool,
}
```

**Key Methods:**
- `contains(position)` — Tests if a position is within the loop.
- `wrap(position)` — Returns the wrapped position if looping is enabled and position exceeds the loop end. Uses modular arithmetic: `start + ((pos - start) % (end - start))`.

**Connections:**
- `dream_clip_engine::ClipScheduler` checks `LoopRegion` to handle loop boundaries.
- `TransportBar.tsx` displays and controls the loop region.

---

### 5.11 `dream_clip_engine` — Clip Playback Engine

**Path**: `core/dream_clip_engine/`  
**Role**: Determines which audio clips are active at the current playhead and reads their sample data for mixing.  
**Dependencies**: `dream_models`, `dream_dsp`  
**Dependents**: `dream_engine` (future: clip playback in audio callback)

**⚡ All reading is REAL-TIME SAFE** — uses pre-loaded data only, no disk I/O.

#### `src/scheduler.rs` — Clip Scheduler

```rust
pub struct ClipScheduler;

impl ClipScheduler {
    pub fn active_clips(
        clips: &[AudioClip],
        playhead: i64,
        buffer_size: usize,
    ) -> Vec<ActiveClip>;
}
```

**`ActiveClip`** contains:
- Reference to the original `AudioClip`
- `offset_in_clip` — Where in the clip's audio data to start reading
- `offset_in_buffer` — Where in the output buffer to start writing
- `frames_to_read` — How many frames to read this buffer

The scheduler handles partial overlaps — a clip might start mid-buffer, end mid-buffer, or both.

---

#### `src/reader.rs` — Clip Reader

```rust
pub struct ClipReader;

impl ClipReader {
    pub fn read_into_buffer(
        active: &ActiveClip,
        pool: &ClipPool,
        output: &mut [f32],
        fade_cache: &FadeCache,
    );
}
```

**Flow:**
1. Looks up the clip's pre-loaded audio data from `ClipPool`
2. Copies the relevant sample range to the output buffer
3. Applies Hann window micro-fades via `FadeCache` at clip boundaries
4. Handles boundary conditions (clip shorter than buffer, etc.)

**Connections:**
- Uses `dream_dsp::fades::FadeCache` for click-free boundaries.
- Reads from `ClipPool` (shared `Arc<Vec<f32>>` audio data).

---

#### `src/pool.rs` — Clip Pool

```rust
pub struct ClipPool {
    entries: HashMap<String, Arc<Vec<f32>>>,  // source_path → shared audio data
}
```

**Key Methods:**
- `insert(path, data)` — Stores pre-loaded audio. Uses `Arc` for zero-copy sharing.
- `get(path)` — Returns `Option<Arc<Vec<f32>>>`. The `Arc::clone()` is O(1).
- `remove(path)` — Removes a clip's data (when no longer referenced).
- `contains(path)` — Checks if a clip is loaded.

**Design**: Audio files are loaded once (by `dream_io::AudioReader`) and shared via `Arc`. Multiple clips referencing the same file share the same memory. This is critical for memory efficiency with large projects.

---

### 5.12 `dream_automation` — Automation System

**Path**: `core/dream_automation/`  
**Role**: Implements automation curves, recording modes, and parameter lanes for time-varying parameter control.  
**Dependencies**: `serde`, `uuid`  
**Dependents**: `dream_mixer` (future: automated volume/pan), `dream_plugins` (future: automated plugin params)

#### `src/curve.rs` — Automation Curve (234 lines)

**Key Types:**

```rust
pub struct AutomationPoint {
    pub position: f64,      // Time position (in beats or samples)
    pub value: f64,         // Parameter value (0.0 – 1.0 normalized)
    pub curve_type: CurveType,
}

pub enum CurveType {
    Step,         // Instant jump (no interpolation)
    Linear,       // Straight line between points
    Smooth,       // Hermite spline (S-curve)
    Exponential,  // Exponential curve for natural fader feel
}

pub struct AutomationCurve {
    points: Vec<AutomationPoint>,  // Sorted by position
}
```

**Key Methods:**

| Method | Purpose |
|--------|---------|
| `add_point(point)` | Inserts and auto-sorts by position; deduplicates |
| `remove_point(position)` | Removes point at position |
| `evaluate(position)` | Returns interpolated value at any position |
| `point_count()` | Number of breakpoints |
| `clear()` | Removes all points |

**Interpolation Algorithms:**
- **Step**: Returns the value of the previous point.
- **Linear**: `lerp(a, b, t)` where `t = (pos - a.pos) / (b.pos - a.pos)`.
- **Smooth (Hermite)**: `3t² - 2t³` — smooth S-curve with zero derivative at endpoints.
- **Exponential**: `a + (b - a) * (1 - e^(-k*t)) / (1 - e^(-k))` — natural fader response.

**Real-Time Safety**: `evaluate()` uses binary search (`O(log n)`) on the sorted points. No allocations during evaluation.

---

#### `src/mode.rs` — Automation Modes (234 lines)

**Key Type:**
```rust
pub enum AutomationMode {
    Off,     // Automation ignored
    Read,    // Automation plays back, overrides manual control
    Write,   // Everything is recorded (destructive)
    Touch,   // Records only while fader is touched; releases back to read
    Latch,   // Like Touch, but holds the last value after release
}
```

**Recording State Logic:**

| Mode | While Touching | After Release |
|------|---------------|---------------|
| Off | Manual control | Manual control |
| Read | Curve value | Curve value |
| Write | Records new value | Records new value |
| Touch | Records new value | Returns to curve |
| Latch | Records new value | Holds last recorded |

**Key Methods:**
- `is_recording(mode, is_touched)` — Returns whether new automation should be written.
- `should_read(mode, is_touched)` — Returns whether the curve value should override manual.

---

#### `src/lane.rs` — Automation Lane (234 lines)

**Key Types:**

```rust
pub enum AutomationTarget {
    Volume,
    Pan,
    PluginParam { plugin_id: Uuid, param_index: u32 },
    SendLevel { send_index: usize },
}

pub struct AutomationLane {
    pub id: Uuid,
    pub target: AutomationTarget,
    pub curve: AutomationCurve,
    pub mode: AutomationMode,
    pub is_touched: bool,      // Set by UI fader interaction
}
```

**Key Methods:**

| Method | Purpose |
|--------|---------|
| `evaluate(position)` | Returns `Option<f64>` — None when manual control is active |
| `set_touched(bool)` | Called by UI when fader is grabbed/released |
| `set_mode(mode)` | Changes the automation mode |
| `add_point(point)` | Delegates to `AutomationCurve::add_point()` |

**Mode-Aware Evaluation**: `evaluate()` returns `None` in cases where the user has manual control:
- **Off**: Always `None`
- **Write**: Always `None` (UI writes directly)
- **Touch while touched**: `None` (recording)
- **Latch while touched**: `None` (recording)
- Otherwise: `Some(curve.evaluate(position))`

**Connections:**
- `AutomationTarget::Volume` → `dream_mixer::apply_gain()`
- `AutomationTarget::Pan` → `dream_mixer::apply_pan()`
- `AutomationTarget::PluginParam` → `dream_plugins::PluginInstance::set_parameter_value()`

---

## 6. Desktop Host (Tauri v2)

**Path**: `apps/desktop_host/`  
**Role**: Native desktop application shell wrapping the Rust engine and React frontend.  
**Dependencies**: `tauri`, `tauri-plugin-shell`, `dream_models`, `dream_ipc`, `dream_engine`

### `Cargo.toml` — Desktop Host Dependencies

```toml
[dependencies]
app_lib = { path = ".", features = ["custom-protocol"] }
dream_models = { path = "../../core/dream_models" }
dream_ipc = { path = "../../core/dream_ipc" }
dream_engine = { path = "../../core/dream_engine" }
tauri = { workspace = true, features = ["custom-protocol"] }
tauri-plugin-shell = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
```

### `src/lib.rs` — Application Core (190 lines)

**State Management:**
```rust
struct AudioEngineHandle {
    command_tx: Mutex<Producer<EngineCommand>>,
    clock: Arc<MasterClock>,
    is_playing: Mutex<bool>,
    frequency: Mutex<f32>,
    sample_rate: f64,
}
```

The `AudioEngineHandle` is managed by Tauri's state system. It holds the command producer (UI → audio thread), the shared clock, and cached state for IPC queries.

**IPC Command Handlers:**

| Tauri Command | Rust Function | Action |
|--------------|---------------|--------|
| `play` | `play(handle)` | Sends `EngineCommand::Play` via ring buffer |
| `stop` | `stop(handle)` | Sends `EngineCommand::Stop` via ring buffer |
| `set_frequency` | `set_frequency(handle, freq)` | Sends `EngineCommand::SetFrequency(freq)` |
| `get_state` | `get_state(handle)` | Reads `MasterClock` → builds `PlaybackState` |

**Initialization Flow (`run()`):**
1. Creates `rtrb` ring buffer (capacity: 256 commands)
2. Creates `Arc<MasterClock>` shared between threads
3. Wraps producer + clock in `AudioEngineHandle`
4. Starts the audio thread via `dream_engine::start_audio_thread(consumer, clock.clone())`
5. Builds Tauri app with state and IPC handlers
6. Runs the event loop

### `src/main.rs` — Entry Point (18 lines)

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    app_lib::run();
}
```

The `windows_subsystem = "windows"` attribute hides the console window in release builds on Windows.

### `build.rs` — Build Script (4 lines)

```rust
fn main() {
    tauri_build::build();
}
```

Compiles Tauri's native bindings and assets.

### `tauri.conf.json` — Application Configuration

```json
{
    "productName": "Dream DAW",
    "version": "0.1.0",
    "identifier": "com.dream-daw.desktop",
    "build": {
        "frontendDist": "../../frontend/ui_app/dist",
        "devUrl": "http://localhost:5173",
        "beforeDevCommand": "pnpm -F ui_app run dev",
        "beforeBuildCommand": "pnpm -F ui_app run build"
    },
    "app": {
        "windows": [{
            "title": "Dream DAW",
            "width": 1440,
            "height": 900
        }],
        "security": {
            "csp": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com"
        }
    }
}
```

**Key Settings:**
- Default window: 1440×900 (professional DAW resolution)
- CSP allows Google Fonts for the Inter typeface
- `devUrl` points to Vite dev server at localhost:5173

---

## 7. Frontend (React + Vite + Tailwind CSS)

**Path**: `frontend/ui_app/`  
**Role**: The user interface layer of Dream DAW, built with React 18 and TypeScript.

### 7.1 Entry Point & Configuration

#### `package.json`

**Dependencies:**
- `react`, `react-dom` — UI framework
- `@tauri-apps/api` — Tauri IPC bridge to Rust

**Dev Dependencies:**
- `vite` — Build tool
- `tailwindcss` v4 — Utility-first CSS
- `typescript` — Type safety
- `@vitejs/plugin-react` — React Fast Refresh

**Scripts:**
- `dev` — Starts Vite dev server (port 5173)
- `build` — Production build (outputs to `dist/`)
- `preview` — Preview production build locally

#### `main.tsx` — React Entry Point (11 lines)

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './global.css'
import { Workspace } from '@/pages/Workspace'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Workspace />
  </StrictMode>,
)
```

Mounts the `<Workspace />` component into the `#root` div. `StrictMode` enables development-only checks.

#### `pages/Workspace.tsx` — Single Page (10 lines)

```tsx
export const Workspace = () => {
    return <DawShell />;
};
```

Trivial wrapper — delegates all layout to `DawShell`. Exists because of the page-based routing architecture (future: multiple pages for settings, plugin browser, etc.).

---

### 7.2 Design System (CSS Layers)

The design system is organized as 4 CSS layers imported in dependency order:

```css
@import "./app/styles/reset.css";       /* 1. Global resets */
@import "./app/styles/tokens.css";      /* 2. Design tokens */
@import "./app/styles/glass.css";       /* 3. Glassmorphism + animations */
@import "./app/styles/plugin-rack.css"; /* 4. Device node components */
```

#### `tokens.css` — Design Tokens (446 lines)

**Source**: Ported 1:1 from `DreamTheme.swift` (681 lines). Contains 170+ CSS custom properties.

**Token Categories:**

| Category | Count | Examples |
|----------|-------|---------|
| Spacing | 20 | `--space-0` through `--space-24` (4px base) |
| DAW Layout | 20 | `--daw-transport-height: 32px`, `--daw-sidebar-width: 240px` |
| Z-Indices | 6 | `--z-canvas: 0` through `--z-tooltip: 2000` |
| Typography | 16 | Font families, sizes (8px–24px), weights, line heights |
| Border Radii | 7 | `--radius-xs: 2px` through `--radius-full: 9999px` |
| Blur & Effects | 4 | `--blur-sm: 4px` through `--blur-xl: 40px` |
| Shadows | 5 | `--shadow-sm` through `--shadow-panel` |
| Transitions | 6 | `--transition-fast: 0.15s`, `--animation-premium: 0.4s` |
| Opacity | 4 | `--opacity-disabled: 0.5` through `--opacity-hover: 0.9` |

**Dark Theme** (default, 200+ color tokens):
- 12 background levels (`--color-bg-base: #141414` → `--color-bg-active: #3a3a3a`)
- 5 text colors (`--color-text-primary: #e0e0e0` → `--color-text-inverse: #0d0d0d`)
- Accent: Blue (`--color-accent-primary: #4a9eff`)
- 5 semantic status colors (success/warning/error/info/record)
- 3 DAW button colors (mute=amber, solo=blue, arm=red)
- 4 border variants (subtle, default, highlight, selected)
- 4 VU meter states (bg, normal=green, hot=yellow, clip=red)
- 7 effect type tints (eq=blue, compressor=orange, delay=green, reverb=purple, etc.)
- 5 browser category colors (audio=gold, midi=blue, plugin=purple, preset=green)
- 4 knob/fader colors
- 7 piano roll colors
- 4 glass/HUD colors
- 4 overlay opacities
- 2 gradients

**Light Theme** (alternative, overrides ~60 color tokens): Inverts the grayscale and adjusts accent colors for light backgrounds.

---

#### `glass.css` — Glassmorphism & Animations (304 lines)

**Glass Panels:**
- `.glass-panel` — Frosted glass with `backdrop-filter: blur(12px)` and subtle border
- `.glass-pill` — Transport bar: full-width, elevated background, bottom divider
- `.glass-divider` — 1px vertical separator between transport sections

**Button Styles:**
- `.btn-ghost` — Transparent icon button with hover highlight
- `.btn-control` — Small Ableton-style control button (used in transport)

**Animations (6 keyframes):**
- `fade-in` — Opacity 0→1 with 8px upward slide
- `scale-in` — Scale 0.96→1.0
- `slide-in-right` — 16px horizontal slide
- `pulse-glow` — Red pulsing glow (record button)
- `shimmer` — Loading shimmer effect
- `meter-pulse` — Opacity breathing (idle meters)

**Stagger System**: `.stagger-children > *:nth-child(n)` adds incremental 30ms delays for up to 8 children.

**Utility Classes**: `.scrollbar-hide`, `.progress-shimmer`, `.glow-accent`, `.glow-success`, `.glow-record`.

---

#### `reset.css` — Global Resets (105 lines)

- Universal box-sizing to `border-box`
- Root element: full viewport, no overflow, no overscroll
- Element resets: links (no decoration), buttons (no default styles), inputs (no outlines)
- Focus override: `outline: none !important` (DAWs don't use tab navigation)
- Custom scrollbars: 6px thin, transparent track, overlay-colored thumb
- Firefox scrollbar: `scrollbar-width: thin`

---

#### `plugin-rack.css` — Device Node Styling (323 lines)

Styles for the `DeviceRack` widget's plugin cards:

- `.device-node` — Card container: 200px wide, dark background, subtle border, cursor:pointer
- `.device-node::before` — 3px color stripe at top (effect-type colored via `data-effect` attribute)
- `.device-node[data-effect="eq"]::before` — Blue stripe (`--color-effect-eq`)
- `.device-node[data-effect="compressor"]::before` — Orange stripe
- `.device-node[data-effect="reverb"]::before` — Purple stripe
- `.device-node-header` — 28px header with title and bypass LED
- `.device-bypass-led` — 7px green circle with glow (success=active, gray=bypassed)
- `.device-node-body` — Parameter knobs area
- `.device-knob` — Knob container (dial + value + label)
- `.device-knob-dial` — 28px circle with arc border
- `.device-meter` — 3px horizontal VU bar with gradient fill
- `.device-port` — 8px circular audio/MIDI/sidechain connection points
- `.device-wire` — Connection line between devices with arrow
- `.device-add-slot` — Dashed-border "Add Device" button

---

#### `global.css` — Tailwind v4 Theme Bridge (173 lines)

Imports all 4 CSS layers and bridges CSS custom properties to Tailwind utility classes via `@theme`:

```css
@import "tailwindcss";
@import "./app/styles/reset.css";
@import "./app/styles/tokens.css";
@import "./app/styles/glass.css";
@import "./app/styles/plugin-rack.css";

@theme {
   --color-bg-base: var(--color-bg-base);
   --color-bg-app: var(--color-bg-app);
   /* ... 100+ more bindings ... */
}
```

This enables using Tailwind classes like `bg-bg-app`, `text-text-primary`, etc. throughout React components.

**Base Rules**: Sets `html, body, #root` to full viewport with dark background, no overflow, font antialiasing, and disabled text selection.

---

### 7.3 Layout Architecture — DawShell (117 lines)

**File**: `app/layouts/DawShell.tsx`  
**Purpose**: The master layout component implementing the "Hole-Punch Architecture."

**Visual Layout:**
```
┌─────────────────────────────────────────────────┐
│                  TransportBar                    │  ← 32px
├──────────┬────────────────────────┬─────────────┤
│          │                        │             │
│  Asset   │   WebGPU Timeline      │   Track     │
│ Browser  │   (Hole-Punch)         │  Inspector  │
│          │                        │             │
├──────────┴────────────────────────┴─────────────┤
│                  DeviceRack                      │  ← 30vh
├─────────────────────────────────────────────────┤
│                  StatusBar                       │  ← 20px
└─────────────────────────────────────────────────┘
```

**Two-Layer Architecture:**

| Layer | Z-Index | Purpose | Pointer Events |
|-------|---------|---------|---------------|
| Layer 0 | z-0 | WebGPU Timeline Canvas (Rust/WASM @ 144Hz) | Receives all clicks in the transparent zone |
| Layer 1 | z-10 | React UI Overlay | `pointer-events: none` by default |

**The Hole-Punch**: The center region (`<div className="flex-1 bg-transparent pointer-events-none" />`) is fully transparent with no pointer events. Clicks "punch through" to the WebGPU canvas below. Glass panels (sidebar, transport, device rack) re-enable `pointer-events: auto`.

**Component Hierarchy:**
```
DawShell
├── Layer 0: #webgpu-timeline-canvas (placeholder with "DREAM DAW" watermark)
└── Layer 1: UI Overlay (pointer-events-none)
    ├── <header> TransportBar (z-50)
    ├── <main>
    │   ├── <aside> AssetBrowser (z-40, left sidebar)
    │   ├── <div> HOLE PUNCH (transparent, no events)
    │   └── <aside> TrackInspector (z-40, right sidebar)
    ├── <footer> DeviceRack (z-40, bottom panel)
    └── <div> StatusBar (z-50)
```

---

### 7.4 Widgets

#### `TransportBar.tsx` (346 lines)

**Purpose**: Full Ableton-style top control bar. Ported from `TransportBarView.swift`.

**Layout**: `[Tap | BPM | TimeSig | Quantize] | [◀ ▶ ■ ● Rec] | [Loop] | [Key ♪ | Tonic | Mode] | [Position] ... [MIDI] [CPU]`

**State Management:**
- `isPlaying`, `isRecording`, `isLooping` — Transport state booleans
- `bpm` (128.0 default), `bpmText`, `bpmEditing` — Tempo with inline editing
- `timeSigNum/Den` (4/4) — Time signature
- `quantizeIdx` — Cycles through: 1/4, 1/8, 1/16, 1/32, 1/4T, 1/8T, 1/16T, OFF
- `keyEnabled`, `keyTonic`, `keyMode` — Key signature with 12 tonics × 6 modes
- `position` {bar, beat, sub} — Playhead position display
- `cpuPercent` — CPU load indicator

**Tap Tempo Algorithm**: Stores up to 8 timestamps. On each tap, calculates the average interval. BPM = 60000 / avgMs. Range clamped to [20, 999]. Resets if gap > 3 seconds.

**Sub-Components:**
- `Section` — Flex row with gap and padding
- `Divider` — 1px vertical separator (`.glass-divider`)
- `ControlButton` — Small button with mono font (`.btn-control`)
- `TransportBtn` — 24×24 icon button with active state glow

---

#### `AssetBrowser.tsx` (421 lines)

**Purpose**: Left sidebar file browser with hierarchical categories. Ported from `BrowserSidebarView.swift` (1639 lines).

**Layout (top → bottom):**
1. **Search field** — Cmd+F focus shortcut, filters items by name
2. **Category tree** — 3 collapsible sections: Collections, Library, Places
3. **Filter toolbar** — Source (All/Library/Samples/Plugins), Format (All/WAV/AIFF/MP3/FLAC), Audio (All/Loops/OneShot/Drums/Vocals)
4. **Results list** — Items with type dot (color-coded) + name + metadata
5. **Preview footer** — Item count + preview toggle

**Categories** (16 items):
- Collections: Favorites
- Library: All, Samples, Sounds, Drums, Instruments, Audio Effects, Plug-Ins, Clips, Templates
- Places: User Library, Current Project, Add Folder…

**Demo Data**: 12 sample items (kicks, snares, hihats, pads, vocals), 2 instruments, 5 effects.

**Sub-Components:**
- `TypeDot` — 6px colored circle (audio=gold, instrument=blue, effect=purple)
- `FilterPill` — Cycling filter button with active highlight

---

#### `DeviceRack.tsx` (448 lines)

**Purpose**: Bottom panel showing the plugin signal chain. Ported from `BottomPanelView.swift` (1094 lines).

**Layout**: `[Header Bar] → [IN meter] → [Device 1] → [Device 2] → ... → [OUT meter] → [+ Add]`

**Demo Chain**: EQ Eight → Compressor → Plate Reverb. Each device has typed parameters and VU levels.

**Device Node Rendering:**
- 3px colored top stripe based on effect type (via `data-effect` CSS attribute)
- Header: bypass LED (green dot) + name + settings icon
- Body: SVG knob dials with 270° arcs, normalized value indicators
- Footer: 3px horizontal VU meter with color thresholds

**KnobDisplay Component**: Renders SVG knob with:
- Inactive arc (full 270°, gray)
- Active arc (135° to current angle, accent color)
- Center dot and indicator dot
- Value label (auto-formatted based on magnitude)
- Parameter name

**MeterBar Component**: Vertical signal meter with color states: normal (green), hot (yellow), clip (red).

---

#### `TrackInspector.tsx` (377 lines)

**Purpose**: Right sidebar with track list and mixer controls. Ported from `TrackHeaderView.swift` (1337 lines) and `MixerView.swift`.

**Layout (top → bottom):**
1. **Inspector Header** — Selected track name, type, volume/pan display, sends, I/O routing
2. **Track List** — Scrollable list of all tracks

**Demo Tracks** (9): DRUMS (group), Kick, Snare, Hihat, BASS (group), Bass, MIDI 7, MIDI 8, Master. Each has color, volume (dB), pan, mute/solo/arm flags, VU level, routing.

**Track Row Layout:**
`[3px Color Stripe | Name] [MIDI badge?] [S button] [Enable # button] [VU stereo bars]`

**Features:**
- Color-coded 3px vertical strip per track (matching Ableton)
- Group tracks have bold names
- Solo button (blue when active)
- Enable/mute button (green when active, shows track number)
- Stereo VU meters (two 4px-wide vertical bars)
- Track selection highlights background
- Muted tracks have reduced opacity (0.45)

---

#### `StatusBar.tsx` (139 lines)

**Purpose**: Bottom informational bar. Ported from `StatusBarView.swift` (142 lines).

**Layout**: `[Arrangement] [Position: 1.1.24] [End: 48.1.00] [Length: 2:28.430] ... [▶/■] [9 tracks] [44100 Hz] [Main ▾]`

**Props** (with defaults): position, projectEnd, duration, trackCount, sampleRate, isPlaying.

**Sub-Components:**
- `StatusLabel` — Tertiary color, regular weight
- `StatusValue` — Secondary color, mono font, medium weight
- `StatusText` — Secondary color, medium weight
- `StatusGroup` — Inline flex container

---

## 8. Cross-Cutting Concerns

### 8.1 Real-Time Safety Contract

Every module that runs in the audio callback thread (`dream_engine`, `dream_mixer`, `dream_clip_engine`, `dream_dsp::fades`) adheres to:

| Rule | Rationale |
|------|-----------|
| **No heap allocation** | `malloc` acquires a global lock → priority inversion |
| **No mutex/lock** | Contention causes audio dropouts |
| **No I/O** | Disk/network latency is unbounded |
| **No panic** | Stack unwinding is expensive and non-deterministic |
| **Bounded execution** | Audio buffers must be processed in < buffer_period |

### 8.2 Thread Architecture

```
┌─────────────┐    rtrb (SPSC)    ┌──────────────────┐
│  UI Thread   │ ──────────────→  │  Audio Callback   │
│  (Tauri)     │                  │  (cpal stream)     │
│              │ ←── MasterClock  │                    │
│              │   (AtomicI64)    │                    │
└──────┬───────┘                  └──────────────────┘
       │
       │  Tauri IPC (JSON)
       │
┌──────▼───────┐
│  React UI    │
│  (Webview)   │
└──────────────┘
```

- **UI Thread** → Audio Thread: `EngineCommand` via `rtrb` ring buffer (lock-free)
- **Audio Thread** → UI Thread: `MasterClock` via `AtomicI64` (relaxed ordering)
- **UI Thread** → React: Tauri IPC commands (`play`, `stop`, `set_frequency`, `get_state`)

### 8.3 Type Sharing (Rust ↔ TypeScript)

`ts-rs` generates TypeScript interfaces from Rust structs:

```rust
#[derive(TS)]
#[ts(export)]
pub struct PlaybackState { ... }
```

Generates: `frontend/ui_app/src/bindings/PlaybackState.ts`

This ensures end-to-end type safety between the Rust engine and React UI.

### 8.4 Serialization Strategy

| Context | Format | Crate |
|---------|--------|-------|
| Project files | JSON (pretty-printed) | `serde_json` |
| Tauri IPC | JSON | `serde_json` |
| Peak cache | Binary (serde-compatible) | `serde` |
| GPU upload | Raw bytes (`Pod + Zeroable`) | `bytemuck` |

### 8.5 Error Handling Pattern

Each crate defines its own error enum:
- `dream_io::AudioReaderError` — `FileNotFound`, `UnsupportedFormat`, `DecodeError`, `NoAudioTrack`
- `dream_io::WavWriterError` — `WriteError`, `InvalidData`
- `dream_io::ProjectFileError` — `IoError`, `SerializationError`
- `dream_graph::GraphError` — `CycleDetected`, `NodeNotFound`, `DuplicateNode`
- `dream_plugins::PluginError` — Various plugin loading/processing errors

All implement `Display` and `std::error::Error` for idiomatic error propagation.

---

## 9. Dependency Graph

```
dream_models ─────────────────────────────────────────────────────
    │                                                              
    ├──→ dream_ipc ──→ dream_engine ──→ desktop_host              
    │                                                              
    ├──→ dream_graph (dag + rcu + pdc)                             
    │                                                              
    ├──→ dream_dsp ──→ dream_clip_engine                          
    │                                                              
    ├──→ dream_renderer (gpu_types + viewport + timeline)         
    │                                                              
    ├──→ dream_plugins (scanner + instance trait)                  
    │                                                              
    ├──→ dream_io (reader + peaks + writer + project)             
    │                                                              
    ├──→ dream_mixer (gain + pan + meter + bus)                   
    │                                                              
    ├──→ dream_transport (state + playhead + loop)                
    │                                                              
    └──→ dream_automation (curve + mode + lane)                   
                                                                   
desktop_host ──→ frontend/ui_app (via Tauri IPC)                  
```

All crates depend on `dream_models` as the SSOT. No circular dependencies exist. The dependency direction always flows from data models outward to domain-specific logic.

---

## 10. Design Principles

### 10.1 Enterprise Architecture Principles

1. **Single Source of Truth (SSOT)** — `dream_models` is the canonical authority for all data types. No module re-invents `Track`, `AudioClip`, or `AbsoluteTime`.

2. **Crate-Level Separation of Concerns** — Each crate has a single, clear responsibility. The `dream_io` crate handles ALL file I/O. The `dream_mixer` handles ALL mixing. No responsibilities leak across boundaries.

3. **Real-Time / Non-Real-Time Boundary** — The codebase has an explicit, documented boundary between RT-safe and non-RT code. Modules like `dream_dsp::fades` and `dream_mixer` are guaranteed RT-safe. Modules like `dream_io` and `dream_dsp::resampler` are explicitly marked as non-RT.

4. **Zero-Copy Data Sharing** — Audio data is loaded once and shared via `Arc<Vec<f32>>` (see `ClipPool`). Graph snapshots are shared via `Arc<ExecutionPlan>` (see `LiveGraph`). No unnecessary data copying.

5. **Lock-Free Communication** — The UI → audio thread path uses `rtrb` SPSC queues. The audio → UI path uses `AtomicI64`. The graph update path uses `arc-swap` RCU. No mutex contention on the audio thread.

### 10.2 Frontend Design Principles

1. **Hole-Punch Architecture** — WebGPU canvas (Layer 0) renders at native frequency. React UI (Layer 1) floats above with surgical `pointer-events` control. This eliminates the performance penalty of rendering waveforms in the DOM.

2. **Design Token Hierarchy** — 170+ CSS custom properties from `DreamTheme.swift` ensure pixel-perfect parity with the native Swift prototype. Tailwind v4 `@theme` bridges tokens to utility classes.

3. **Widget Isolation** — Each widget (TransportBar, AssetBrowser, etc.) is self-contained in its own directory. Widgets manage their own state and render independently.

4. **Dark-First Design** — The dark theme is the default (as is standard for DAWs). A light theme exists as an override. All color tokens are defined in both themes.

5. **Ableton-Inspired UX** — Layout proportions, control behaviors (tap tempo, cycling selectors, VU meter ballistics), and visual feedback patterns are ported from Ableton Live's design language.

---

*This document was generated by analyzing every source file in the Dream DAW monorepo. Total files documented: 50+ source files across 13 Rust crates, 1 desktop application, and 13 frontend files.*
