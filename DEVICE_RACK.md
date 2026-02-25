# Dream DAW — Unified Device Rack Architecture

> **SSOT Manifest** — This document is the canonical specification for all audio
> device processing in Dream DAW. Every runtime slot, project model node, and
> frontend component MUST conform to this contract.

## Core Principle

**Every device in the signal chain is a `DeviceSlot`.**

Internal DSP effects, external VST3/CLAP/AU plugins, instruments, analyzers —
they all occupy the same type of slot, processed in the same loop, with the same
interface. Classification (internal vs. external, effect vs. instrument) is
metadata — not architecture.

```
┌────────────────────────────────────────────────────────────────┐
│                        DeviceRack                              │
│                                                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │DeviceSlot│→ │DeviceSlot│→ │DeviceSlot│→ │DeviceSlot│→ OUT  │
│  │ Internal │  │ External │  │ Internal │  │ External │       │
│  │   (EQ)   │  │ (Pro-Q3) │  │  (Comp)  │  │  (OTT)  │       │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘      │
│                                                                │
│  Processing: slot[0].process() → slot[1].process() → ...      │
│  One loop. One interface. Zero branching by device type.       │
└────────────────────────────────────────────────────────────────┘
```

---

## Architecture

### 1. The Unified Trait

```rust
/// dream_dsp::device_slot::DeviceProcessor
///
/// Every device on the audio thread implements this trait.
/// Internal effects, external plugins, instruments — all of them.
pub trait DeviceProcessor: Send {
    /// Process stereo audio in-place with optional sidechain.
    ///
    /// MIDI events are passed for instruments and MIDI-reactive effects.
    /// Effects that don't use MIDI simply ignore the slice.
    ///
    /// Returns `ProcessResult::Processed` on success, or
    /// `ProcessResult::Skipped` if an external plugin's mutex was contended.
    fn process(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        sidechain_left: Option<&[f32]>,
        sidechain_right: Option<&[f32]>,
        context: &ProcessContext,
    ) -> ProcessResult;

    /// Set a parameter by index. O(1), RT-safe.
    fn set_param(&mut self, index: u32, value: f64);

    /// Reset internal state (transport seek, loop boundary).
    fn reset(&mut self);

    /// Report latency in samples (for PDC).
    fn latency_samples(&self) -> usize;

    /// Device classification metadata.
    fn device_kind(&self) -> DeviceKind;
}
```

### 2. Device Kinds (Metadata, Not Architecture)

```rust
pub enum DeviceKind {
    /// Built-in DSP effect (EQ, Compressor, Delay, etc.)
    InternalEffect(BuiltinEffectType),
    /// External plugin (VST3, CLAP, AU)
    ExternalPlugin { instance_id: Uuid },
    /// Built-in instrument (Sampler, EssenceSynth, SampleRack)
    InternalInstrument,
    /// External instrument plugin (Serum, Vital, etc.)
    ExternalInstrument { instance_id: Uuid },
}
```

`DeviceKind` is used for:
- UI rendering (show native vs. plugin editor)
- State persistence (serialize internal params vs. external state blob)
- Diagnostics (log which device type caused an issue)

It is **never** used for branching in the audio callback.

### 3. Two Concrete Implementations

```rust
/// Wraps a DspProcessor (internal effect) as a DeviceProcessor.
struct InternalDeviceSlot {
    processor: Box<dyn DspProcessor>,  // SmoothedProcessor wrapping raw DSP
    effect_type: BuiltinEffectType,
    is_bypassed: bool,
}

/// Wraps a PluginInstanceArc (external plugin) as a DeviceProcessor.
struct ExternalDeviceSlot {
    instance: PluginInstanceArc,     // Arc<parking_lot::Mutex<Box<dyn PluginInstance>>>
    instance_id: Uuid,
    is_instrument: bool,
    is_bypassed: bool,
    // Scratch buffers owned per-slot for RT safety
    input_bufs: [Vec<f32>; 2],
    output_bufs: [Vec<f32>; 2],
}
```

### 4. The Device Chain (Replaces `InsertEffectsChain`)

```rust
pub struct DeviceChain {
    slots: Vec<Box<dyn DeviceProcessor>>,
    sample_rate: f32,
}

impl DeviceChain {
    /// Process all non-bypassed devices in serial order.
    /// One loop. No branching by device type.
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], ctx: &ProcessContext) {
        for slot in &mut self.slots {
            slot.process(left, right, None, None, ctx);
        }
    }

    /// Process with per-slot sidechain routing.
    pub fn process_with_sidechains(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        sidechain_bufs: &[(Option<&[f32]>, Option<&[f32]>)],
        ctx: &ProcessContext,
    ) {
        for (i, slot) in self.slots.iter_mut().enumerate() {
            let (sc_l, sc_r) = sidechain_bufs.get(i)
                .copied()
                .unwrap_or((None, None));
            slot.process(left, right, sc_l, sc_r, ctx);
        }
    }

    pub fn add_device(&mut self, index: usize, device: Box<dyn DeviceProcessor>) -> bool;
    pub fn remove_device(&mut self, index: usize) -> bool;
    pub fn reorder(&mut self, from: usize, to: usize) -> bool;
    pub fn set_bypass(&mut self, index: usize, bypassed: bool);
}
```

---

## Data Flow

```
                    UI Thread                          Audio Thread
                    ════════                           ════════════

┌─────────────┐     EngineCommand::AddDevice      ┌──────────────────┐
│ Project Model│ ──────────────────────────────→   │   DeviceChain    │
│ DeviceNode[] │     (carries device kind +        │ Vec<Box<dyn      │
│              │      instance_id or effect_type)  │  DeviceProcessor>│
└──────┬───────┘                                   └────────┬─────────┘
       │                                                    │
       │  rebuild_sidechain_snapshot()                      │ process()
       │  (only sidechain routing map)                      │ one loop
       ▼                                                    ▼
┌──────────────┐   ArcSwap                         ┌───────────────┐
│ Sidechain    │ ─────────────────────────────→     │ Audio Callback │
│ Snapshot     │                                   │ (no branching) │
└──────────────┘                                   └───────────────┘
```

### What Gets Eliminated

| Before | After |
|--------|-------|
| `ExternalFxRuntimeSlot` (5 fields, mixed internal/external) | **Removed** — devices live directly in `DeviceChain` |
| `SharedExternalFxSnapshot` + `rebuild_external_fx_snapshot` | **Removed** — topology changes go through `EngineCommand` |
| 3-path audio callback (empty / internal-only / mixed) | **1 path** — `device_chain.process()` |
| `internal_slot_index` tracking in snapshot | **Removed** — no dual indexing |
| `resolve_master_runtime_slots()` tail-entry hack | **Removed** — master has its own `DeviceChain` |

---

## Command Protocol

```rust
pub enum EngineCommand {
    /// Add any device at a given slot position.
    AddDevice {
        track_index: u16,        // u16::MAX = master
        slot_index: u8,
        device: DevicePayload,   // enum: Internal(BuiltinEffectType) | External(PluginInstanceArc, Uuid)
    },

    /// Remove a device by slot index.
    RemoveDevice {
        track_index: u16,
        slot_index: u8,
    },

    /// Reorder a device within its chain (drag-and-drop).
    ReorderDevice {
        track_index: u16,
        from_slot: u8,
        to_slot: u8,
    },

    /// Set bypass on any device.
    BypassDevice {
        track_index: u16,
        slot_index: u8,
        bypassed: bool,
    },

    /// Set parameter on any device.
    SetDeviceParam {
        track_index: u16,
        slot_index: u8,
        param_index: u32,
        value: f64,
    },
}
```

---

## Naming Convention (Standardized)

| Concept | Name | Location |
|---------|------|----------|
| Trait for all devices | `DeviceProcessor` | `dream_dsp::device_slot` |
| Internal effect wrapper | `InternalDeviceSlot` | `dream_dsp::device_slot` |
| External plugin wrapper | `ExternalDeviceSlot` | `dream_dsp::device_slot` |
| Serial processing chain | `DeviceChain` | `dream_dsp::device_chain` |
| Classification enum | `DeviceKind` | `dream_dsp::device_slot` |
| Per-track runtime slot | `TrackSlot.device_chain` | `dream_engine::render_callback` |
| Master chain | `master_device_chain` | `audio_thread_runner.rs` |
| Project model node | `DeviceNode::Single / Rack` | `dream_models::project` |
| UI alias list | `INTERNAL_EFFECT_PLUGINS` | `internalEffectPlugins.ts` |
| Alias resolver | `builtin_effect_type_from_plugin_id()` | `dream_models::project` |

---

## Real-Time Safety Contract

1. **`InternalDeviceSlot.process()`** — guaranteed O(N), zero-alloc, zero-lock
2. **`ExternalDeviceSlot.process()`** — uses `try_lock()` on `parking_lot::Mutex`
   - Success → process plugin audio
   - Contention → return `ProcessResult::Skipped` (passthrough)
   - **Never blocks the audio thread**
3. **`DeviceChain.process()`** — iterates `Vec` in order, O(N × slots)
4. **Parameter changes** — enqueued via lock-free `rtrb` ring buffer
5. **Topology changes** — deferred to start of next callback via `DeferredTopologyCmd`

---

## Migration Path

| Phase | Scope | Risk |
|-------|-------|------|
| **Phase 1** | Create `DeviceProcessor` trait + `InternalDeviceSlot` + `ExternalDeviceSlot` | None — additive |
| **Phase 2** | Refactor `DeviceChain` to use `Vec<Box<dyn DeviceProcessor>>` | Medium — touches audio thread |
| **Phase 3** | Simplify audio callback to single process loop | High — core RT path |
| **Phase 4** | Remove `ExternalFxRuntimeSlot`, `SharedExternalFxSnapshot` | Medium — removes dead code |
| **Phase 5** | Add `ReorderDevice` command + PDC foundation | Low — additive |

---

## Non-Goals (Explicit Scope Boundaries)

- **Parallel rack rendering** — future work, separate from this refactor
- **Plugin state undo/redo** — orthogonal to device chain architecture
- **CLAP/AU format support** — `PluginInstance` trait already abstracts this
- **Wet/dry mix** — can be added per-`DeviceProcessor` later

---

*Last updated: 2026-02-26*
*Author: Dream DAW Engineering*
