# Dream DAW — Swift UI Archive: Comprehensive Analysis

> This document maps every pattern, component, and task from the original Swift codebase (~35k LOC, 89 source files) to the current Rust + React + Tauri architecture. It serves as the single reference for migrating proven patterns and identifying remaining work.

---

## Table of Contents

1. [Archive Overview](#1-archive-overview)
2. [Module-by-Module Inventory](#2-module-by-module-inventory)
3. [Gold Patterns — Engine](#3-gold-patterns--engine)
4. [Gold Patterns — Models](#4-gold-patterns--models)
5. [Gold Patterns — UI / Rendering](#5-gold-patterns--ui--rendering)
6. [Design System Extraction](#6-design-system-extraction)
7. [Migration Status Matrix](#7-migration-status-matrix)
8. [Remaining Tasks & Roadmap Mapping](#8-remaining-tasks--roadmap-mapping)

---

## 1. Archive Overview

| Metric | Value |
|---|---|
| **Total LOC** | ~35,000 |
| **Modules** | 4 (`DreamDAWEngine`, `DreamDAWModels`, `DreamDAWUI`, `DreamDAW`) |
| **Engine Files** | 32 Swift files (~12k LOC) |
| **Model Files** | 13 Swift files (~3k LOC) |
| **UI Files** | 39 Swift files (~15k LOC) |
| **External Dependencies** | ZERO (pure Swift + system frameworks) |
| **macOS Target** | v14.0+ |
| **GPU Backend** | Metal (MSL shaders, instanced rendering) |
| **Audio Backend** | AVAudioEngine + CoreAudio |
| **Test Suites** | `DreamDAWEngineTests`, `DreamDAWModelsTests` |
| **Audit Documents** | 6 files (~650k bytes of technical analysis) |

---

## 2. Module-by-Module Inventory

### 2.1 DreamDAWEngine (32 files)

| File | LOC | Purpose | Rust Equivalent |
|---|---|---|---|
| `AudioEngine.swift` | 285 | AVAudioEngine wrapper, lifecycle, node management | `dream_engine::driver` |
| `PlaybackOrchestrator.swift` | 193 | Shadow State pattern, atomic snapshot swap | `dream_graph::rcu` (LiveGraph) |
| `PlaybackScheduler.swift` | 844 | Clip stitching, Int64 tiling, AoT loop pre-scheduling | `dream_clip_engine::scheduler` |
| `TrackMixer.swift` | 1013 | Per-track signal chain (player → EQ → mixer → master) | `dream_mixer` |
| `TransportController.swift` | 343 | CVDisplayLink playhead, PulseMap sync, loop handling | `dream_transport` |
| `SPSCRingBuffer.swift` | 168 | Lock-free, ARC-free generic ring buffer | `dream_ipc` (rtrb) |
| `QuantumDSP.swift` | 135 | Hann micro-fades, vDSP vectorized | `dream_dsp::fades` |
| `PDCEngine.swift` | 71 | Plugin Delay Compensation, routing tree traversal | `dream_graph::pdc` |
| `AudioLevelMeter.swift` | 421 | Lock-free metering (RMS/Peak/FFT), pre-captured refs | `dream_mixer` (metering) |
| `WaveformCache.swift` | 525 | Multi-resolution waveform caching, LRU + disk persist | `dream_io::peaks` |
| `PluginHost.swift` | 179 | AU/VST plugin instantiation, fuzzy matching, GUI hosting | `dream_plugins` |
| `RenderEngine.swift` | 596 | Offline bounce to WAV, resampling, equal-power pan | `dream_io::writer` |
| `AudioBufferPool.swift` | ~200 | Pre-allocated buffer pool for RT | `dream_engine` (pre-alloc) |
| `AudioCommand.swift` | ~100 | Command enum for RT boundary crossing | `dream_ipc::EngineCommand` |
| `AudioDeviceEnumerator.swift` | ~150 | Hardware device listing | `dream_engine` (cpal) |
| `ArrangementOrchestrator.swift` | ~200 | Arrangement-level coordination | `dream_clip_engine` |
| `ArrangementProtocols.swift` | ~80 | Protocol definitions for arrangement ops | `dream_models` (traits) |
| `EngineDiagnosticService.swift` | ~150 | Runtime diagnostics, logging | Logging infra |
| `MachThreadConfigurator.swift` | ~100 | Mach RT thread priority elevation | OS-level (handled by cpal) |
| `ParametricEQ.swift` | ~200 | 8-band parametric EQ implementation | Future plugin |
| `PerformanceBenchmark.swift` | ~120 | Audio performance benchmarking | Test harness |
| `PlayheadInterpolator.swift` | ~80 | Sub-frame playhead smoothing | `dream_transport` |
| `PluginAuditService.swift` | ~100 | Plugin health checking | `dream_plugins::scanner` |
| `ProjectFileManager.swift` | ~250 | Save/Load/Auto-save, JSON serialization | `dream_io::project` |
| `SamplerInstrument.swift` | ~300 | Sample-based instrument player | Future `dream_plugins` |
| `SharedEngine.swift` | ~100 | DI container for engine subsystems | Tauri state management |
| `SimpleSynthInstrument.swift` | ~150 | Basic sine/saw synthesizer | Future `dream_plugins` |
| `StressTestService.swift` | ~100 | Automated stress testing | Test harness |
| `TileEngine.swift` | ~200 | Timeline tile-based rendering | `dream_renderer::timeline` |
| `UserConfigurationService.swift` | ~100 | User preferences persistence | Frontend settings |

### 2.2 DreamDAWModels (13 files)

| File | LOC | Purpose | Rust Equivalent |
|---|---|---|---|
| `Project.swift` | 455 | Root model, tracks array, tempo, time sig, key sig | `dream_models::project::Project` |
| `Track.swift` | 276 | Track with volume/pan/mute/solo, effects chain, routing | `dream_models::project::Track` |
| `AudioClip.swift` | 227 | Clip positioning, trim, warp markers, stretch factor | `dream_models::project::Clip` |
| `MidiClip.swift` | ~150 | MIDI events, notes, position/duration | Future `dream_models` |
| `AudioEffect.swift` | ~120 | Effect config (EQ, Delay, Reverb, VST) | `dream_models::project::PluginSlot` |
| `AbsoluteTime.swift` | 110 | Int64 sample-frame SSOT, arithmetic, bridge to beats | `dream_models::time::AbsoluteTime` |
| `PulseMap.swift` | 175 | Tempo map, binary search, beat↔sample conversion | `dream_models::pulse_map::PulseMap` |
| `TimePosition.swift` | ~60 | Beat-based position (legacy, UI-only) | `dream_models` (display) |
| `AppSettings.swift` | ~100 | User preferences model | Frontend state |
| `AppVersion.swift` | ~30 | Version tracking | `tauri.conf.json` |
| `MagneticGrid.swift` | ~100 | Snap-to-grid logic (beat fractions) | Future `dream_models` |
| `QuadTree.swift` | ~200 | Spatial indexing for clip hit-testing | Future optimization |
| `SpatialHashGrid.swift` | ~150 | Alternative spatial indexing | Future optimization |

### 2.3 DreamDAWUI (39 files)

| File | LOC | Purpose | React Equivalent |
|---|---|---|---|
| `ArrangementViewController.swift` | 1250 | Master controller, manual layout, all coordinators | `Workspace.tsx` |
| `DreamTheme.swift` | 681 | 100+ token design system, ThemeManager, protocol | `tokens.css` + `glass.css` |
| `MetalTimelineRenderer.swift` | 442 | GPU clip/MIDI instancing, waveform overlay | `dream_renderer` (wgpu) |
| `MetalCanvasRenderer.swift` | ~300 | Base Metal renderer class | `dream_renderer` base |
| `InteractionStateMachine.swift` | 422 | Phantom drag/trim/split/stretch state machine | Future `Workspace` logic |
| `ViewportMatrix.swift` | 203 | Sample-based zoom/scroll, anchor zoom | `dream_renderer::viewport` |
| `TrackLayoutEngine.swift` | ~200 | Track Y-position calculation, visibility | Arrangement layout |
| `TrackHeaderView.swift` | ~350 | Track header (name, arm, mute, solo, color) | `TrackInspector.tsx` |
| `TransportBarView.swift` | ~200 | Play/Stop/Record, BPM, time display | `TransportBar.tsx` |
| `MixerView.swift` | 176 | Channel strips (volume fader, pan, M/S) | `DeviceRack.tsx` |
| `TimelineCanvasView.swift` | ~250 | NSView host for Metal canvas | `Workspace.tsx` canvas |
| `TimelineRulerView.swift` | ~200 | Beat/bar ruler with time signature | Ruler component |
| `TimelineInteractionCoordinator.swift` | ~300 | Mouse event → state machine bridge | Event handlers |
| `ArrangementRendererCoordinator.swift` | ~200 | Render loop coordinator | RAF loop |
| `WaveformRenderer.swift` | ~250 | CPU fallback waveform drawing | Canvas 2D fallback |
| `WaveformMetalRenderer.swift` | ~200 | GPU waveform path rendering | `dream_renderer` |
| `PianoRollView.swift` | ~300 | MIDI note editor view | Future component |
| `PianoRollMetalRenderer.swift` | ~250 | GPU piano roll rendering | Future `dream_renderer` |
| `KnobView.swift` | ~150 | Rotary knob control | Future component |
| `AbletonGainFaderView.swift` | ~200 | Ableton-style vertical fader | Future component |
| `SignalMeterView.swift` | ~150 | VU/Peak meter visualization | Future component |
| `EQEightView.swift` | ~200 | 8-band EQ frequency response curve | Future component |
| `MiniEQCurveView.swift` | ~100 | Compact EQ curve for track header | Future component |
| `PluginSlotView.swift` | ~150 | Plugin slot with drag/drop | Future component |
| `MasterLaneView.swift` | ~150 | Master track lane | Future component |
| `BrowserSidebarView.swift` | ~250 | File browser / asset sidebar | `AssetBrowser.tsx` |
| `BottomPanelView.swift` | ~200 | Bottom panel (mixer/device rack) | `DeviceRack.tsx` |
| `StatusBarView.swift` | ~150 | Status bar (CPU, memory, etc.) | `StatusBar.tsx` |
| `SplashScreenView.swift` | ~200 | Splash screen with animation | Future component |
| `SplashScreenController.swift` | ~150 | Splash screen lifecycle | Future component |
| `MainWindowController.swift` | ~250 | Window management, toolbar | Tauri window config |
| `SettingsWindowController.swift` | ~200 | Settings/preferences window | Future component |
| `LoadingOverlayView.swift` | ~100 | Loading state overlay | UI component |
| `RenderDialogView.swift` | ~200 | Offline render dialog | Future component |
| `SamplerView.swift` | ~200 | Sampler instrument UI | Future component |
| `ClampedClipView.swift` | ~100 | Clip view with bounds clamping | Canvas rendering |
| `DragForwardingScrollView.swift` | ~80 | Scroll view with drag event forwarding | Scroll handling |
| `EditCursor.swift` | ~80 | Edit cursor (insertion point) | Future component |

---

## 3. Gold Patterns — Engine

### 3.1 Shadow State Pattern (PlaybackOrchestrator)

**Swift Implementation:**
```swift
// UI thread creates frozen snapshot → atomic swap → audio thread reads
public final class PlaybackOrchestrator {
    private var _activeSnapshot: ProjectRenderSnapshot?
    private var snapshotLock = os_unfair_lock_s()
    
    public func commitChanges(from project: Project) -> Int {
        let newSnapshot = ProjectRenderSnapshot(from: project, generation: generationCounter)
        os_unfair_lock_lock(&snapshotLock)
        _activeSnapshot = newSnapshot
        os_unfair_lock_unlock(&snapshotLock)
    }
}
```

**Rust Equivalent:** `dream_graph::rcu::LiveGraph` using `arc-swap::ArcSwap<ExecutionPlan>`:
```rust
pub struct LiveGraph {
    inner: ArcSwap<ExecutionPlan>,
}
impl LiveGraph {
    pub fn swap_graph(&self, plan: ExecutionPlan) { self.inner.store(Arc::new(plan)); }
    pub fn load(&self) -> arc_swap::Guard<Arc<ExecutionPlan>> { self.inner.load() }
}
```

**Status:** ✅ Migrated (semantically equivalent, `arc-swap` is superior to `os_unfair_lock`)

---

### 3.2 SPSC Ring Buffer (SPSCRingBuffer)

**Swift Implementation:** Raw pointer (`UnsafeMutableRawPointer`) with manual stride-based access. ARC-free by construction — no Optional wrappers. Atomic indices with acquire/release semantics.

**Rust Equivalent:** `rtrb::RingBuffer` — proven mature crate with identical semantics.

**Status:** ✅ Migrated

---

### 3.3 Micro-Fades (QuantumDSP)

**Swift Implementation:** Pre-computed half-Hann window curves, `vDSP_vmul` SIMD-accelerated, 2ms fade (~88 samples at 44.1kHz).

**Rust Equivalent:** `dream_dsp::fades` with `FadeCache` pre-computed curves. Uses scalar multiplication (no SIMD yet).

**Status:** ✅ Migrated (scalar). ⚡ **Optimization opportunity:** Add SIMD via `std::simd` or `packed_simd`.

---

### 3.4 Plugin Delay Compensation (PDCEngine)

**Swift Implementation:** Traverses routing tree, accumulates latency per track (instrument + effects), follows `outputDestinationID` routing chain with circular-reference safety.

**Rust Equivalent:** `dream_graph::pdc` with `petgraph` topological traversal, longest-path algorithm.

**Status:** ✅ Migrated (graph-based approach is superior to the Swift tree-walk)

---

### 3.5 Clip Scheduling (PlaybackScheduler — 844 LOC)

**Swift Pattern:** Int64 tiling — fills every gap with silence buffers. Sample-locked scheduling via PulseMap. Ahead-of-Time (AoT) loop pre-scheduling with `DispatchSourceTimer`. Mach RT thread elevation.

**Rust Equivalent:** `dream_clip_engine::scheduler` handles clip scheduling.

**Status:** ✅ Core migrated. ⚠️ **Missing:** AoT loop pre-scheduling, silence-fill tiling.

---

### 3.6 Track Mixer (TrackMixer — 1013 LOC)

**Swift Pattern:** Full signal chain per track:
```
AVAudioPlayerNode → PDC Delay → TimePitch → Input Mixer → ParametricEQ → Insert Slots → Output Mixer → Group Bus / Master
```
Features: 32-step volume ramping (anti-zipper), solo logic, instrument hosting (synth/sampler/VST), pre-allocated insert slots.

**Rust Equivalent:** `dream_mixer` handles gain/pan/metering.

**Status:** ⚠️ Partial. **Missing:** Effect chain, insert slots, TimePitch node, solo logic, volume ramping.

---

### 3.7 Audio Level Metering (AudioLevelMeter — 421 LOC)

**Swift Pattern:** `LockFreeLevel` using raw `UInt32` bit patterns for atomic float storage. `LockFreeFFT` for spectrum analysis. Pre-captured references for zero-allocation audio thread access. Separate tap points (pre/post effects).

**Rust Equivalent:** `dream_mixer` has basic metering.

**Status:** ⚠️ Partial. **Missing:** FFT spectrum, pre-captured refs pattern, multi-tap-point support, per-band analysis.

---

### 3.8 Waveform Cache (WaveformCache — 525 LOC)

**Swift Pattern:** Multi-resolution peak computation with LRU eviction. Disk persistence (JSON serialization). Multi-band frequency analysis (Low 20-300Hz, Mid 300-4kHz, High 4kHz+). Background processing queue.

**Rust Equivalent:** `dream_io::peaks` handles peak pre-computation.

**Status:** ⚠️ Partial. **Missing:** LRU eviction, disk persistence, multi-band frequency analysis.

---

### 3.9 Offline Render Engine (RenderEngine — 596 LOC)

**Swift Pattern:** Full offline bounce with: resampling (linear interpolation), equal-power panning law, MIDI-to-audio synthesis, solo-aware rendering, progress callbacks. Studio-standard config: 48kHz/24-bit.

**Rust Equivalent:** `dream_io::writer` handles WAV writing.

**Status:** ⚠️ Partial. **Missing:** Full offline bounce pipeline, mixing, resampling, MIDI synthesis, progress tracking.

---

### 3.10 Plugin Host (PluginHost — 179 LOC)

**Swift Pattern:** AU component manager with fuzzy matching (scored: path=400, name=260, normalized=220, contains=140, bundle ID=300). Out-of-process loading. GUI hosting via `requestViewController`.

**Rust Equivalent:** `dream_plugins` has scanner and descriptor types.

**Status:** ⚠️ Partial. **Missing:** Actual plugin instantiation, fuzzy matching, GUI hosting.

---

## 4. Gold Patterns — Models

### 4.1 AbsoluteTime (Int64 Sample-Frame SSOT)

**Swift:** `public let sampleFrame: Int64` — supports >13M hours at 96kHz. Musical time derived on-demand via PulseMap. Bridge to legacy `TimePosition`.

**Rust:** `dream_models::time::AbsoluteTime` — identical design.

**Status:** ✅ Migrated

---

### 4.2 PulseMap (Tempo Map)

**Swift:** `TempoEvent` array with binary search O(log N). Supports variable tempo. `beat→sample` and `sample→beat` conversions. Fast path for constant tempo O(1).

**Rust:** `dream_models::pulse_map::PulseMap` — identical design with `TempoEvent` and binary search.

**Status:** ✅ Migrated

---

### 4.3 Project Model

**Swift Fields Not Yet in Rust:**
- `timeSignature: TimeSignature` (numerator/denominator)
- `keySignatureEnabled`, `keySignatureTonic`, `keySignatureMode`  
- `selectedClipIDs: Set<UUID>`, `primarySelectedClipID`
- `editCursorPosition: TimePosition`
- `viewZoomScale`, `viewScrollPosition`, `viewBrowserWidth`
- `trackPanelStates`
- `isDirty` (unsaved changes flag)
- `createGroup(from:)`, `ungroupTrack(_:)` methods

**Status:** ⚠️ Most core fields migrated, but selection state, view state, and grouping operations are missing.

---

### 4.4 Track Model

**Swift Fields Not Yet in Rust:**
- `midiClips: [MidiClip]`
- `instrument: InstrumentConfig?`
- `effects: [AudioEffectConfig]`
- `parentTrackID: UUID?`, `outputDestinationID: UUID?`, `childTrackIDs: [UUID]`
- `isExpanded: Bool` (group folding)
- `effectiveVolume` (cumulative with Utility effect gain)

**Status:** ⚠️ Core fields (volume, pan, mute, solo) migrated. Routing, effects chain, MIDI, and grouping missing.

---

### 4.5 AudioClip Model

**Swift Fields Not Yet in Rust:**
- `absolutePosition: AbsoluteTime`, `absoluteDuration: AbsoluteTime` (dual representation)
- `isWarped`, `warpMarkers: [WarpMarker]`, `stretchFactor`
- `trimStartOffset: TimePosition`
- `gain: Float`, `isSelected: Bool`, `colorOverride: TrackColor?`
- `sourceDurationSeconds: Double`
- `applyTrim()`, `applyWarp()` mutation methods

**Status:** ⚠️ Position/duration migrated. Warping, trim offset, clip-level gain, and selection missing.

---

## 5. Gold Patterns — UI / Rendering

### 5.1 Design System (DreamTheme — 681 LOC, 100+ tokens)

**Architecture:** Protocol-based (`ThemeProtocol`) with `ThemeManager` singleton. `DreamTheme` enum as static facade. Every UI component reads tokens — zero hardcoded values.

**Token Categories:**

| Category | Count | Examples |
|---|---|---|
| Backgrounds | 7 | `bgBase`, `bgPrimary`, `bgSecondary`, `bgSurface`, `bgHeader`, `bgSidebar`, `bgOverlay` |
| Text | 5 | `textPrimary`, `textSecondary`, `textDimmed`, `textBright`, `textOnAccent` |
| Accent | 3 | `accentBlue`, `accentBlueDimmed`, `accentHighlight` |
| Semantic | 4 | `success`, `warning`, `danger`, `info` |
| Structure | 5 | `divider`, `dividerLight`, `gridLine`, `gridLineMajor`, `playhead` |
| Interaction | 5 | `selectionBorder`, `selectionFill`, `clipHighlight`, `dropTarget`, `clipHover` |
| Meters | 4 | `meterGreen`, `meterYellow`, `meterOrange`, `meterRed` |
| Effects | 6 | `effectEQ`, `effectCompressor`, `effectDelay`, `effectReverb`, `effectChorus`, `effectUtility` |
| Track Colors | 16 | Ableton-style palette (coral → slate) |
| Piano Roll | 6 | `pianoWhiteKey`, `pianoBlackKey`, `pianoGridLine`, `pianoCLine` |
| Fonts | 5 | `fontSizeMicro` (7), `fontSizeSmall` (9), `fontSizeMedium` (11), `fontSizeLarge` (13), `fontSizeTitle` (16) |
| Dimensions | 15+ | `radiusSmall` (2), `radiusCard` (4), `trackHeight` (80), `rulerHeight` (24), `headerWidth` (200) |
| Glass | 4 | `glassMaterial`, `glassBlending`, `glassColor`, `glassBorder` |

**Rust/React Equivalent:** `tokens.css` has partial coverage. `glass.css` has glassmorphism.

**Status:** ⚠️ Partially migrated. Missing: effect tints, meter gradient breakpoints, piano roll palette, complete dimension tokens.

---

### 5.2 InteractionStateMachine (422 LOC)

**Swift Pattern:** Pure state machine with states: `idle → pendingDrag → dragging / trimming / splitting / slicing / stretching / marqueeSelecting`. Phantom overlay data (stack-allocated) passed to Metal renderer. 4px gesture disambiguation threshold. Zero model mutations during drag — single atomic commit on mouseUp.

**Key Types:**
```swift
enum InteractionState {
    case idle
    case pendingDrag(clipIDs: Set<UUID>, ...)
    case dragging(clipIDs: Set<UUID>, phantomDeltaSamples: Int64, deltaTrackIndex: Int)
    case trimming(clipID: UUID, edge: TrimEdge, originalBounds: ClipBounds, deltaSamples: Int64)
    case splitting(clipID: UUID, splitSampleFrame: Int64)
    case slicing(sampleFrame: Int64, trackIndexRange: ClosedRange<Int>)
    case stretching(clipID: UUID, edge: TrimEdge, originalBounds: ClipBounds, rate: Double)
    case marqueeSelecting(...)
}
```

**Status:** ❌ Not yet migrated. **Critical for UX.**

---

### 5.3 ViewportMatrix (203 LOC)

**Swift Pattern:** Sample-based coordinate system. `visibleStartSample` + `samplesPerPixel`. Anchor zoom keeps sample under cursor stationary. Zoom limits: 0.01 SPP (sub-sample) to 44100×3600 SPP (1px/hour). Legacy bridge for `pixelsPerBeat` migration.

**Rust Equivalent:** `dream_renderer::viewport::Viewport` — similar concept.

**Status:** ✅ Migrated (core concept). Minor delta: Legacy bridge code not needed.

---

### 5.4 Metal Timeline Renderer (442 LOC)

**Swift Pattern:** Instanced rendering — up to 10,000 clips in a single draw call. `ClipInstance` struct uploaded per-frame. Dual pipeline (clip waveforms + MIDI note overlays). Waveform data overlay via buffer upload. Visible-range culling.

**Rust Equivalent:** `dream_renderer::timeline::TimelineRenderer` with wgpu.

**Status:** ✅ Core migrated (wgpu instanced rendering).

---

## 6. Design System Extraction

### 6.1 Track Color Palette (16 colors — Ableton style)

| Index | Name | Hex |
|---|---|---|
| 0 | Coral | `#F05C4D` |
| 1 | Orange | `#FF8A1A` |
| 2 | Gold | `#FFBF33` |
| 3 | Yellow | `#FFE14D` |
| 4 | Lime | `#A3D94D` |
| 5 | Green | `#4DC775` |
| 6 | Teal | `#4DC7B0` |
| 7 | Cyan | `#4DC7CC` |
| 8 | Sky | `#4DA6E3` |
| 9 | Blue | `#4D7AE3` |
| 10 | Indigo | `#6B5CE3` |
| 11 | Purple | `#9B59D9` |
| 12 | Magenta | `#D94DA6` |
| 13 | Pink | `#E36B96` |
| 14 | Rose | `#E66673` |
| 15 | Slate | `#8C949E` |

### 6.2 Dimension Constants

```
Track Height:           80px
Ruler Height:           24px  
Header Width:           200px
Transport Height:       32px
Status Bar Height:      22px
Browser Width (default): 220px
Scrollbar Size:         8px
Playhead Width:         1.5px
Divider Width:          1px
Bottom Panel Min Height: 200px
Color Stripe Width:     3px
Browser Row Height:     22px
Radius Small:           2px
Radius Card:            4px
Control Padding H:      4px
Section Padding H:      8px
Icon Micro:             6px
Icon Small:             9px
Default Pixels/Beat:    60px
Insert Slot Count:      8 (pre-allocated per track)
```

### 6.3 Font Scale

```
Micro:   7pt  — indicator text
Small:   9pt  — toolbar, track headers
Medium:  11pt — body text, labels
Large:   13pt — section headers
Title:   16pt — window titles
```

---

## 7. Migration Status Matrix

### Legend: ✅ Migrated | ⚠️ Partial | ❌ Not Started

| Component | Swift Source | Rust/React Target | Status |
|---|---|---|---|
| **Engine Core** | `AudioEngine` | `dream_engine::driver` | ✅ |
| **Shadow State / RCU** | `PlaybackOrchestrator` | `dream_graph::rcu` | ✅ |
| **Ring Buffer** | `SPSCRingBuffer` | `dream_ipc` (rtrb) | ✅ |
| **Micro-Fades** | `QuantumDSP` | `dream_dsp::fades` | ✅ |
| **PDC** | `PDCEngine` | `dream_graph::pdc` | ✅ |
| **AbsoluteTime** | `AbsoluteTime` | `dream_models::time` | ✅ |
| **PulseMap** | `PulseMap` | `dream_models::pulse_map` | ✅ |
| **Viewport** | `ViewportMatrix` | `dream_renderer::viewport` | ✅ |
| **GPU Rendering** | `MetalTimelineRenderer` | `dream_renderer::timeline` | ✅ |
| **Transport** | `TransportController` | `dream_transport` | ✅ |
| **Automation** | N/A (not in Swift) | `dream_automation` | ✅ (new) |
| **Audio Graph DAG** | N/A (tree-based) | `dream_graph::dag` | ✅ (new, superior) |
| **Clip Scheduling** | `PlaybackScheduler` | `dream_clip_engine` | ⚠️ Core only |
| **Track Mixer** | `TrackMixer` | `dream_mixer` | ⚠️ Gain/Pan only |
| **Metering** | `AudioLevelMeter` | `dream_mixer` | ⚠️ Basic only |
| **Waveform Cache** | `WaveformCache` | `dream_io::peaks` | ⚠️ Core only |
| **Offline Render** | `RenderEngine` | `dream_io::writer` | ⚠️ WAV only |
| **Plugin Host** | `PluginHost` | `dream_plugins` | ⚠️ Scanner only |
| **Interaction SM** | `InteractionStateMachine` | — | ❌ |
| **MIDI Support** | `MidiClip`, scheduler | — | ❌ |
| **EQ / Effects** | `ParametricEQ`, effects chain | — | ❌ |
| **Instruments** | `SamplerInstrument`, `SimpleSynth` | — | ❌ |
| **Piano Roll** | `PianoRollView`, Metal | — | ❌ |
| **Warp/Stretch** | `AudioClip.applyWarp()` | — | ❌ |
| **Group Tracks** | `Track.childTrackIDs` | — | ❌ |
| **Magnetic Grid** | `MagneticGrid` | — | ❌ |
| **File Manager** | `ProjectFileManager` | — | ❌ |
| **Settings** | `UserConfigurationService` | — | ❌ |

---

## 8. Remaining Tasks & Roadmap Mapping

### Priority 1: Core Audio Pipeline Completion

1. **Effect Chain Integration** — Port the `TrackMixer` signal chain pattern (Player → PDC → TimePitch → EQ → Insert Slots → Output Mixer) into `dream_mixer`.
2. **Silence-Fill Tiling** — Port the `PlaybackScheduler` gap-filling logic into `dream_clip_engine`.
3. **AoT Loop Pre-Scheduling** — Implement ahead-of-time loop re-scheduling from `PlaybackScheduler`.
4. **Volume Ramping** — Implement 32-step anti-zipper ramping from `TrackMixer.smoothSetVolume()`.

### Priority 2: UI Interaction Gold

5. **InteractionStateMachine** — Port the phantom drag/trim/split/stretch state machine (422 LOC). Critical for professional editing UX.
6. **Magnetic Grid** — Port snap-to-grid logic from `MagneticGrid.swift`.
7. **Edit Cursor** — Implement the insertion-point cursor from `EditCursor.swift`.

### Priority 3: Extended Metering & Visualization

8. **FFT Spectrum Analysis** — Port `LockFreeFFT` from `AudioLevelMeter` for spectrum visualization.
9. **Multi-Band Waveforms** — Port the 3-band (low/mid/high) analysis from `WaveformCache`.
10. **VU/Peak Meter Views** — Port `SignalMeterView` for visual metering.

### Priority 4: MIDI & Instruments

11. **MIDI Clip Model** — Create `MidiClip`, `MidiNote` types in `dream_models`.
12. **MIDI Scheduling** — Port MIDI clip scheduling from `PlaybackScheduler` into `dream_clip_engine`.
13. **Piano Roll Renderer** — Port `PianoRollMetalRenderer` to wgpu `dream_renderer`.
14. **Sampler Instrument** — Port `SamplerInstrument` to Rust.
15. **Synth Instrument** — Port `SimpleSynthInstrument` to Rust.

### Priority 5: Plugin Ecosystem

16. **Plugin Instantiation** — Full plugin loading (AU/VST matching from `PluginHost`).
17. **Plugin GUI Hosting** — Native plugin window management.
18. **ParametricEQ** — 8-band EQ implementation.

### Priority 6: Project Management

19. **Project File Manager** — Save/Load/Auto-save with JSON serialization.
20. **Offline Bounce** — Full `RenderEngine` pipeline (mixing, resampling, panning, MIDI synthesis).
21. **User Configuration** — Preferences persistence.
22. **Undo/Redo Stack** — Atomic undo from InteractionStateMachine `commitInteraction()`.

### Priority 7: Advanced Features

23. **Group Tracks** — Track hierarchy / routing from `Track.childTrackIDs`.
24. **Time Warping** — `AudioClip.applyWarp()` with stretch factor.
25. **Key Signature** — Musical key awareness from `Project`.
26. **Time Signature** — Variable time signatures from `TimeSignature`.
27. **Spatial Indexing** — `QuadTree` / `SpatialHashGrid` for large-project clip hit-testing.

---

> **Document generated from exhaustive analysis of the Swift UI Archive (89+ source files). All code patterns, token values, and architectural decisions are extracted as-is from the original Swift implementation.**
