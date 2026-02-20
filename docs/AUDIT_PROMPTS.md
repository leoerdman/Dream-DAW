# Dream DAW — Полный набор промптов для глубокого аудита

> **Инструкция:** Копируй любой блок ниже целиком и вставляй в новый чат.
> Каждый блок — самостоятельный промпт для поиска 100 багов в конкретной области.
> После поиска — автоматически исправляй все без подтверждения.

---

## ═══════════════════════════════════════════════════════════════
## 1. 🎛️ AUDIO ENGINE CORE (driver.rs + render_callback.rs)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй полностью весь код AUDIO ENGINE:
- core/dream_engine/src/driver.rs (главный аудио драйвер, RT callback)
- core/dream_engine/src/render_callback.rs (RenderContext, clip scheduling, fades)

Найди 100 багов в этих файлах. Фокус:
- Real-time safety violations (аллокации, блокировки, паники в RT thread)
- Memory ordering (Relaxed vs Release/Acquire на всех атомиках)
- Race conditions между UI и RT потоками
- ArcSwap / RCU правильность использования
- Denormal protection полнота
- Clip scheduling edge cases (loop wrap, seek, boundary crossing)
- Fade application correctness (crossfade, clip start/end fades)
- Channel count assumptions (mono, stereo, surround)
- Master gain / pan smoothing artifacts
- Command queue overflow и backpressure
- Metering accuracy и lock-free correctness
- Buffer size assumptions и edge cases
- Sample rate changes и cascading effects
- Transport state transitions (play→stop→seek→loop)
- Per-track vs global state management

Каждый баг:
- Точный файл и строка кода
- Фрагмент проблемного кода
- Описание проблемы и её импакт
- Предложение как исправить
- Приоритет (P0 Critical / P1 High / P2 Medium / P3 Low)

После того как найдешь все баги — сразу приступай к решению ВСЕХ багов без моего согласия и подтверждения. Запусти cargo check и cargo test после всех исправлений.
```

---

## ═══════════════════════════════════════════════════════════════
## 2. 📊 AUDIO GRAPH & PDC (dag.rs + pdc.rs + rcu.rs + renderer.rs)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй полностью модуль AUDIO GRAPH:
- core/dream_graph/src/dag.rs (GraphBuilder, AudioDag, nodes, edges, cycles)
- core/dream_graph/src/pdc.rs (Plugin Delay Compensation алгоритм)
- core/dream_graph/src/rcu.rs (Read-Copy-Update pattern для графа)
- core/dream_graph/src/renderer.rs (параллельный рендер графа)

Найди 100 багов. Фокус:
- Cycle detection correctness (DAG invariant violations)
- PDC calculation accuracy (reverse longest path algorithm)
- Per-edge compensation delays (правильность фазового выравнивания)
- GraphBuilder clone overhead при каждом add_edge
- RCU publish ordering (store vs generation increment sequence)
- Parallel renderer work stealing и scheduling fairness
- Topology change atomicity (add/remove node while rendering)
- Edge cases: single-node graph, disconnected nodes, self-loops
- Memory leaks при частой перестройке графа
- Stale references после RCU swap
- Parallelism metrics accuracy
- Graph rendering order determinism
- Latency reporting с учётом multi-path routing
- Sidechain routing correctness в графе
- Send/bus routing и summing correctness

Каждый баг подробно: файл, строка, код, проблема, импакт, fix, приоритет.
После нахождения — СРАЗУ исправляй все 100 багов. Cargo check + cargo test.
```

---

## ═══════════════════════════════════════════════════════════════
## 3. 🎹 CLIP ENGINE & SCHEDULING (scheduler.rs + midi_scheduler.rs + pool.rs + disk_streamer.rs)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй полностью модуль CLIP ENGINE:
- core/dream_clip_engine/src/scheduler.rs (ClipScheduler, LoopRegion)
- core/dream_clip_engine/src/midi_scheduler.rs (MidiScheduler)
- core/dream_clip_engine/src/pool.rs (ClipPool management)
- core/dream_clip_engine/src/disk_streamer.rs (DiskStreamer, async read)
- core/dream_clip_engine/src/reader.rs (clip reader)

Найди 100 багов. Фокус:
- Loop wrap scheduling (клипы пересекающие loop boundary)
- i64 overflow при длинных сессиях (26+ часов at 96kHz)
- MIDI event ordering (NoteOff before NoteOn at same frame)
- Clip overlap resolution и trim logic
- Pool miss handling (silent gaps vs glitches)
- DiskStreamer chunk eviction policy
- Interpolation quality при pitch shift / time stretch
- Buffer boundary alignment (clip start не кратен buffer size)
- Looped clip с offset != 0
- Zero-length clips и empty regions handling
- MIDI velocity curve application
- Clip gain vs track gain interaction
- Pre-roll calculation для seamless loop transitions
- Sample rate conversion при загрузке clip из другого SR
- Multi-channel clip handling (mono→stereo, 5.1→stereo)

Каждый баг: файл, строка, код, описание, импакт, fix, приоритет.
СРАЗУ исправляй все без подтверждения. Cargo check + cargo test.
```

---

## ═══════════════════════════════════════════════════════════════
## 4. 🎚️ DSP PROCESSORS (compressor, reverb, EQ, delay, flanger, biquad, SVF)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй полностью все DSP процессоры:
- core/dream_dsp/src/processors/compressor.rs
- core/dream_dsp/src/processors/reverb.rs
- core/dream_dsp/src/processors/eq.rs
- core/dream_dsp/src/processors/delay.rs
- core/dream_dsp/src/processors/flanger.rs
- core/dream_dsp/src/biquad.rs
- core/dream_dsp/src/svf.rs
- core/dream_dsp/src/device_chain.rs
- core/dream_dsp/src/fades.rs
- core/dream_dsp/src/resampler.rs
- core/dream_dsp/src/spectrum_analyzer.rs
- core/dream_dsp/src/dsp_processor.rs

Найди 100 багов. Фокус:
- Filter coefficient calculations (biquad, SVF, HPF, LPF, BPF)
- Denormal accumulation в feedback paths (reverb, delay, flanger)
- Sample rate dependent behaviour (коэффициенты при смене SR)
- Compressor attack/release time constant formulas
- RMS vs peak detection accuracy
- Auto-makeup gain calculation
- Sidechain HPF coefficient (LP vs HP formula confusion)
- Reverb comb filter tuning (Freeverb параметры)
- Delay feedback clamping и runaway prevention
- EQ band interaction и frequency overlap
- Resampler quality (linear vs cubic vs sinc)
- Spectrum analyzer FFT windowing и bin accuracy
- Device chain slot management (add/remove/bypass)
- Fade curve shapes (linear, equal-power, S-curve)
- Soft clipping function accuracy и NaN propagation
- Stereo width preservation через all processors
- CPU efficiency (SIMD opportunities, branch prediction)

Каждый баг: файл, строка, код, описание, импакт, fix, приоритет (P0-P3).
СРАЗУ исправляй все без подтверждения. Cargo check + cargo test.
```

---

## ═══════════════════════════════════════════════════════════════
## 5. 🔌 PLUGIN SYSTEM (scanner, host, VST3, CLAP, AU)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй полностью модуль PLUGINS:
- core/dream_plugins/src/scanner.rs (plugin discovery, deduplication)
- core/dream_plugins/src/host.rs (plugin hosting, lifecycle)
- core/dream_plugins/src/vst3/ (VST3 wrapper)
- core/dream_plugins/src/clap/ (CLAP wrapper)
- core/dream_plugins/src/sandbox.rs (process isolation)
- apps/plugin_host_daemon/ (out-of-process plugin host)

Найди 100 багов. Фокус:
- Plugin lifecycle: open → activate → process → deactivate → close
- Double-terminate crashes при быстром close/reopen
- Thread safety для macOS plugin UI (main thread requirement)
- Sidechain bus routing и channel mapping
- Parameter automation thread safety (UI vs audio thread)
- Plugin state save/restore (preset persistence)
- Sandbox process management (kill before unload race)
- Plugin format priority (VST3 > CLAP > AU > VST2 dedup)
- Category detection accuracy (instrument vs effect vs analyzer)
- Scan timeout handling (hung plugins during scan)
- Memory management (use-after-free, dangling pointers)
- Plugin latency reporting и PDC integration
- MIDI event delivery to external plugins
- Plugin UI window lifecycle (open/close/resize)
- Spec violations (VST3 IAudioProcessor contract)

Каждый баг: файл, строка, код, описание, импакт, fix, приоритет (P0-P3).
СРАЗУ исправляй все без подтверждения. Cargo check + cargo test.
```

---

## ═══════════════════════════════════════════════════════════════
## 6. 🚂 TRANSPORT & PLAYHEAD (playhead.rs, state.rs, loop_region.rs)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй полностью модуль TRANSPORT:
- core/dream_transport/src/playhead.rs (Playhead, position tracking)
- core/dream_transport/src/state.rs (TransportState machine)
- core/dream_transport/src/loop_region.rs (loop start/end)

Найди 100 багов. Фокус:
- Playhead sample-accurate position tracking
- Bar/beat/tick calculation correctness
- Division by zero guards (beats_per_bar, sample_rate, bpm)
- Loop wrap edge cases (loop length < buffer size)
- Seek + loop interaction
- Time signature changes mid-timeline
- BPM automation effects on position calculation
- Negative position handling
- Position overflow at extreme session lengths
- Transport state transitions и invariant preservation
- Recording start/stop position accuracy
- Punch-in/punch-out boundary precision
- Pre-count/metronome timing
- MIDI clock sync и external transport
- Tempo ramp / tempo automation integration
- Sub-sample accuracy для MIDI scheduling

Каждый баг: файл, строка, код, описание, импакт, fix, приоритет (P0-P3).
СРАЗУ исправляй все без подтверждения. Cargo check + cargo test.
```

---

## ═══════════════════════════════════════════════════════════════
## 7. 🎵 MIXER & ROUTING (channel_strip, bus, gain, pan, solo, meter)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй полностью модуль MIXER:
- core/dream_mixer/src/channel_strip.rs (per-track processing chain)
- core/dream_mixer/src/bus.rs (aux sends, returns, summing)
- core/dream_mixer/src/gain.rs (gain staging)
- core/dream_mixer/src/pan.rs (panning law)
- core/dream_mixer/src/solo.rs (solo/mute logic)
- core/dream_mixer/src/meter.rs (level metering)

Найди 100 багов. Фокус:
- Gain staging order (pre-fader vs post-fader)
- Pan law correctness (equal-power vs linear)
- Solo mode logic (exclusive solo, solo-in-place, AFL, PFL)
- Mute/solo interaction matrix
- Bus routing и feedback loops prevention
- Send level и pre/post fader routing
- Meter ballistics (attack, release, peak hold)
- Channel strip processing order (EQ → comp → send → pan → fader)
- Phase cancellation при summing
- Headroom management и clipping prevention
- Master bus processing chain
- Group/VCA fader linking
- Level-dependent noise gate accuracy
- Stereo balance vs pan distinction
- CPU efficiency при большом количестве tracks (256+)

Каждый баг: файл, строка, код, описание, импакт, fix, приоритет (P0-P3).
СРАЗУ исправляй все без подтверждения. Cargo check + cargo test.
```

---

## ═══════════════════════════════════════════════════════════════
## 8. 📁 I/O & FILE HANDLING (audio_reader, wav_writer, mp3_writer, project_file)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй полностью модуль I/O:
- core/dream_io/src/audio_reader.rs (symphonia-based decoding)
- core/dream_io/src/wav_writer.rs (WAV export)
- core/dream_io/src/mp3_writer.rs (MP3 encoding)
- core/dream_io/src/peak_cache.rs (waveform peak cache)
- core/dream_io/src/project_file.rs (project save/load)
- core/dream_io/src/project_manager.rs (project state management)

Найди 100 багов. Фокус:
- Audio file format support completeness
- WAV header correctness (4GB limit, chunk sizes)
- Sample rate conversion quality during import
- Bit depth handling (16/24/32/float)
- Multi-channel file support (mono/stereo/surround)
- Peak cache invalidation при file change
- Project file schema versioning и migration
- Corrupted file recovery
- File locking и concurrent access
- Memory management при large file loading
- Streaming vs full-load decision logic
- MP3 VBR/CBR encoding quality
- Metadata preservation (tags, markers, tempo)
- Path handling (spaces, unicode, symlinks)
- File descriptor leaks
- Temporary file cleanup
- Error reporting completeness

Каждый баг: файл, строка, код, описание, импакт, fix, приоритет (P0-P3).
СРАЗУ исправляй все без подтверждения. Cargo check + cargo test.
```

---

## ═══════════════════════════════════════════════════════════════
## 9. 🖥️ DESKTOP HOST (Tauri commands, IPC bridge, state management)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй полностью DESKTOP HOST:
- apps/desktop_host/src/lib.rs (главный файл, Tauri state, undo/redo)
- apps/desktop_host/src/commands/ (все Tauri команды)

Найди 100 багов. Фокус:
- Mutex deadlock potential (multiple lock acquisitions)
- Tauri state management thread safety
- Undo/redo stack correctness (state consistency)
- Command error handling (silent failures, unwrap-panic)
- Race conditions между concurrent Tauri commands
- ProjectHistory memory growth limits
- Dirty flag management (unsaved changes detection)
- Plugin host mutex contention с RT thread
- IPC bridge data serialization
- Command latency и blocking main thread
- State synchronization между Engine и UI
- File dialog error handling
- Clipboard integration correctness
- Recent projects management
- Auto-save implementation
- Project import/export (ALS, MIDI file)

Каждый баг: файл, строка, код, описание, импакт, fix, приоритет (P0-P3).
СРАЗУ исправляй все без подтверждения. Cargo check + cargo test.
```

---

## ═══════════════════════════════════════════════════════════════
## 10. 🎨 FRONTEND VISUAL / UI (DawShell, Timeline, Canvas, CSS)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй полностью FRONTEND UI:
- frontend/ui_app/src/app/layouts/DawShell.tsx (главный layout)
- frontend/ui_app/src/widgets/ (все виджеты: Timeline, Transport, Mixer, Browser, Piano Roll)
- frontend/ui_app/src/shared/lib/CanvasClipRenderer.ts
- frontend/ui_app/src/shared/lib/TimelineEngine.ts
- frontend/ui_app/src/shared/lib/ViewportMachine.ts
- frontend/ui_app/src/shared/lib/WaveformCache.ts
- Все CSS файлы

Найди 100 багов. Фокус:
- Timeline rendering accuracy (pixel↔sample mapping)
- Canvas clip rendering performance (requestAnimationFrame)
- Waveform rendering quality и cache invalidation
- Viewport zoom/scroll smoothness
- Clip drag & drop visual feedback
- Selection state visual synchronization
- Piano roll note rendering accuracy
- Transport controls responsiveness
- Mixer fader visual↔audio sync
- Dark mode consistency
- Font rendering и readability
- Animation performance (jank, 60fps)
- Layout shifts при resize
- Z-index stacking order
- Hover/focus states accessibility
- Responsive design breakpoints
- Color contrast WCAG compliance
- Glassmorphism rendering performance
- Touch/trackpad gesture handling
- Retina/HiDPI rendering

Каждый баг: компонент, файл, строка, код, описание, импакт, fix, приоритет.
СРАЗУ исправляй все без подтверждения. Запусти tsc --noEmit после исправлений.
```

---

## ═══════════════════════════════════════════════════════════════
## 11. 📦 STATE MANAGEMENT (Zustand stores, React hooks, data flow)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй полностью STATE MANAGEMENT:
- frontend/ui_app/src/shared/stores/ (все Zustand stores)
- frontend/ui_app/src/shared/hooks/ (все кастомные hooks)
- frontend/ui_app/src/shared/api/engine.ts (Tauri IPC bridge)

Файлы stores:
- useEngineStore.ts, useTimelineStore.ts, useViewportStore.ts
- useAutomationStore.ts, useDragStore.ts, useGridStore.ts
- useSettingsStore.ts, useStatusStore.ts

Найди 100 багов. Фокус:
- Store state shape correctness и immutability
- Selector memoization (unnecessary re-renders)
- Race conditions между store updates и React render cycle
- Stale closure bugs в event handlers
- useEffect cleanup missing (memory leaks)
- useCallback/useMemo dependency correctness
- Store hydration и persistence
- Cross-store dependencies и circular updates
- Optimistic updates rollback
- Polling interval efficiency
- Error state propagation
- Store reset при new/open project
- Type safety (any casts, assertion violations)
- Event listener cleanup
- Batch update atomicity

Каждый баг: store/hook, файл, строка, код, описание, импакт, fix, приоритет.
СРАЗУ исправляй все без подтверждения. Запусти tsc --noEmit.
```

---

## ═══════════════════════════════════════════════════════════════
## 12. 🎹 SAMPLER ENGINE (sampler.rs, MIDI note handling)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй полностью SAMPLER:
- core/dream_engine/src/sampler.rs (SamplerEngine, ADSR, voices)

Найди 100 багов. Фокус:
- ADSR envelope correctness (attack, decay, sustain, release stages)
- Voice allocation и polyphony limits
- Note-on / note-off handling (stuck notes)
- Legato re-trigger behaviour (level reset issues)
- Pitch interpolation quality
- Loop modes (one-shot, forward, ping-pong)
- Sample playback precision
- Volume envelope timing accuracy
- Velocity curves и response mapping
- Key zone boundaries
- Voice stealing algorithm
- Anti-click crossfade on voice start/stop
- Multi-sample layer blending
- Release phase completion
- CPU load при high polyphony
- Sample rate mismatch handling

Каждый баг: файл, строка, код, описание, импакт, fix, приоритет (P0-P3).
СРАЗУ исправляй все без подтверждения. Cargo check + cargo test.
```

---

## ═══════════════════════════════════════════════════════════════
## 13. 📼 RECORDING (recording.rs, punch-in, WAV capture)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй полностью RECORDING:
- core/dream_engine/src/recording.rs

Найди 100 багов. Фокус:
- WAV file writing correctness (header, data chunk)
- 4GB WAV limit handling
- Sample rate mismatch detection
- Recording buffer overflow protection
- Disk write latency spikes
- Recording start/stop position accuracy
- Punch-in / punch-out precision
- Multi-track recording sync
- Input monitoring latency
- Arm/disarm state management
- Recording level metering
- File naming и conflict resolution
- Temporary file management
- Recording recovery after crash
- Bit depth conversion
- DC offset protection during recording

Каждый баг: файл, строка, код, описание, импакт, fix, приоритет (P0-P3).
СРАЗУ исправляй все без подтверждения. Cargo check + cargo test.
```

---

## ═══════════════════════════════════════════════════════════════
## 14. 🏗️ OFFLINE BOUNCE / EXPORT (offline_bounce.rs)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй полностью OFFLINE BOUNCE:
- core/dream_engine/src/offline_bounce.rs

Найди 100 багов. Фокус:
- Master gain application (realtime vs offline parity)
- Normalization algorithm correctness
- MIDI pre-render accuracy
- Cancel flag race conditions
- Progress reporting accuracy
- Tail rendering (reverb tail capture)
- Sample rate conversion quality
- MP3 vs WAV export path differences
- Clip pool coverage verification
- Memory usage при long exports
- Multi-format export (simultaneous stems)
- Bus routing offline rendering
- Plugin state during offline mode
- Print/harvest effects during bounce
- Dithering application
- True peak limiting

Каждый баг: файл, строка, код, описание, импакт, fix, приоритет (P0-P3).
СРАЗУ исправляй все без подтверждения. Cargo check + cargo test.
```

---

## ═══════════════════════════════════════════════════════════════
## 15. 📊 AUTOMATION (curve.rs, lane.rs, mode.rs)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй полностью AUTOMATION:
- core/dream_automation/src/curve.rs
- core/dream_automation/src/lane.rs
- core/dream_automation/src/mode.rs

Найди 100 багов. Фокус:
- Automation curve interpolation accuracy (linear, bezier, step)
- Sample-accurate parameter changes
- Automation read/write/touch/latch modes
- Cursor-based binary search correctness
- Loop wrap при automation playback
- Automation point snapping и quantization
- Recording automation в реальном времени
- Automation lane UI↔engine sync
- Parameter range validation и clamping
- Crossfade between write и playback modes
- Undo/redo для automation edits
- Automation trim и scale operations
- Default value handling при empty lane
- Multiple points at same frame
- Automation copy/paste across tracks

Каждый баг: файл, строка, код, описание, импакт, fix, приоритет (P0-P3).
СРАЗУ исправляй все без подтверждения. Cargo check + cargo test.
```

---

## ═══════════════════════════════════════════════════════════════
## 16. 🗂️ DATA MODELS / SSOT (project.rs, midi.rs, mutators.rs)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй полностью DATA MODELS:
- core/dream_models/src/project.rs (Project, Track, TimeSignature, etc.)
- core/dream_models/src/midi.rs (MIDI types, MidiNote, MidiClip)
- core/dream_models/src/mutators.rs (project state mutations)
- Все типы в core/dream_models/src/

Найди 100 багов. Фокус:
- Single Source of Truth violations (duplicate definitions)
- Serde serialization / deserialization correctness
- Default value correctness (TimeSignature, velocities, etc.)
- Validation missing (clamp ranges, invariant checks)
- Type conversions narrowing (f64→f32 precision loss)
- Clone heavy patterns (unnecessary deep copies)
- UUID collision potential
- enum variant exhaustiveness
- Name/ID confusion (string vs UUID)
- Optional field defaults (#[serde(default)])
- Backwards compatibility (schema evolution)
- Mutator atomicity (partial state updates)
- Track ordering invariants
- Plugin slot limits
- Clip reference integrity

Каждый баг: файл, строка, код, описание, импакт, fix, приоритет (P0-P3).
СРАЗУ исправляй все без подтверждения. Cargo check + cargo test.
```

---

## ═══════════════════════════════════════════════════════════════
## 17. 📡 IPC & METERING (metering.rs, ipc bridge)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй полностью IPC & METERING:
- core/dream_ipc/src/metering.rs (LockFreeLevel, MeterBank)
- core/dream_ipc/src/lib.rs (IPC types, commands)
- frontend/ui_app/src/shared/api/engine.ts (Tauri invoke bridge)
- frontend/shared_bindings/ (TypeScript ↔ Rust type bindings)

Найди 100 багов. Фокус:
- Atomic f32↔u32 bit-cast correctness (NaN bit patterns)
- Lock-free meter read/write ordering
- Peak decay algorithm accuracy
- RMS calculation precision (f32 vs f64 accumulator)
- MeterBank growth limits
- Tauri command type safety
- IPC serialization overhead
- Command batching efficiency
- Error propagation через IPC boundary
- TypeScript ↔ Rust type mismatches
- Optional field handling across boundary
- Event subscription и unsubscription lifecycle
- Meter floor handling (-∞ dB edge case)
- Polling rate vs visual update rate
- Thread safety при meter bank resize

Каждый баг: файл, строка, код, описание, импакт, fix, приоритет (P0-P3).
СРАЗУ исправляй все без подтверждения. Cargo check + tsc --noEmit.
```

---

## ═══════════════════════════════════════════════════════════════
## 18. 🖱️ TIMELINE INTERACTION (drag, drop, resize, split, duplicate)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй полностью TIMELINE INTERACTION:
- frontend/ui_app/src/shared/lib/TimelineEngine.ts
- frontend/ui_app/src/shared/lib/TimelineCommandBus.ts
- frontend/ui_app/src/shared/lib/ViewportMachine.ts
- frontend/ui_app/src/shared/lib/ViewportMatrix.ts
- frontend/ui_app/src/shared/lib/gridSnap.ts
- frontend/ui_app/src/shared/lib/dndMatrix.ts
- frontend/ui_app/src/shared/hooks/useBrowserDnDOrchestrator.ts
- frontend/ui_app/src/shared/hooks/useKeyboardShortcuts.ts
- apps/desktop_host/src/commands/sections/clip_mutators.rs

Найди 100 багов. Фокус:
- Clip drag visual↔data sync
- Snap to grid accuracy (various quantize values)
- Split clip boundary handling (remnants, zero-length)
- Duplicate clip overlap resolution
- Resize handles hit detection accuracy
- Multi-selection drag offset calculation
- Copy/paste position calculation
- Undo/redo for timeline operations
- Keyboard shortcut conflicts
- Drag threshold vs click detection
- Cross-track drag (valid targets)
- Viewport pan during drag
- Zoom level effect on precision
- Time↔pixel conversion accuracy
- Browser DnD file import placement

Каждый баг: файл, строка, код, описание, импакт, fix, приоритет.
СРАЗУ исправляй все без подтверждения. Cargo check + tsc --noEmit.
```

---

## ═══════════════════════════════════════════════════════════════
## 19. ⌨️ KEYBOARD SHORTCUTS & COMMANDS (useKeyboardShortcuts, command bus)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй полностью KEYBOARD SHORTCUTS:
- frontend/ui_app/src/shared/hooks/useKeyboardShortcuts.ts
- frontend/ui_app/src/shared/lib/TimelineCommandBus.ts

Найди 100 багов. Фокус:
- Shortcut conflicts между разными контекстами
- Context-aware Delete (text input vs clip vs MIDI note)
- Cmd+Z / Cmd+Shift+Z undo/redo reliability
- Cmd+S save shortcut blocking behaviour
- Space bar play/stop toggle state
- Cmd+E split clip precision
- Cmd+D duplicate clip placement
- Arrow key navigation (timeline vs mixer vs browser)
- Modifier key combination handling (Cmd+Shift+Alt)
- Focus management (which panel receives shortcuts)
- Text input field shortcut suppression
- macOS vs Windows key mapping
- Repeat key handling (hold vs press)
- Shortcut customization persistence
- Accessibility keyboard navigation

Каждый баг: файл, строка, код, описание, импакт, fix, приоритет (P0-P3).
СРАЗУ исправляй все без подтверждения. tsc --noEmit.
```

---

## ═══════════════════════════════════════════════════════════════
## 20. 🔄 UNDO/REDO & PROJECT HISTORY
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй полностью UNDO/REDO:
- apps/desktop_host/src/lib.rs — UndoState, ProjectHistory, push_undo
- Все Tauri commands которые вызывают push_undo

Найди 100 багов. Фокус:
- Undo stack depth limits и memory growth
- Structural sharing correctness (Arc reuse)
- State snapshot completeness (все поля captured?)
- Redo stack clearing при new mutation
- History event sequencing (monotonic seq)
- Multiple mutation coalescing (batch undo)
- Project dirty flag consistency
- Memory pressure при deep undo stack
- Plugin state in undo snapshots
- Automation data in snapshots
- Undo after file operations (save/load)
- Concurrent mutation во время undo/redo
- History serialization для project file
- Recovery after undo failure
- Performance impact больших snapshots

Каждый баг: файл, строка, код, описание, импакт, fix, приоритет (P0-P3).
СРАЗУ исправляй все без подтверждения. Cargo check + cargo test.
```

---

## ═══════════════════════════════════════════════════════════════
## 21. 🎯 CROSS-SYSTEM INTEGRATION (Engine↔UI, Rust↔TS, RT↔UI thread)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй ИНТЕГРАЦИЮ МЕЖДУ ПОДСИСТЕМАМИ:
- Engine ↔ Frontend data flow
- Rust ↔ TypeScript type bindings
- RT thread ↔ UI thread communication
- Plugin Host ↔ Engine state sync
- Project Model ↔ Engine state sync

Файлы для анализа:
- Все shared_bindings/
- frontend/ui_app/src/shared/api/engine.ts
- core/dream_ipc/src/lib.rs
- apps/desktop_host/src/lib.rs
- core/dream_engine/src/driver.rs (command queue)

Найди 100 багов. Фокус:
- Type mismatches между Rust и TypeScript
- State divergence между Engine и UI
- Command ordering guarantees (FIFO violation)
- Race conditions при rapid UI interaction
- Stale data display (UI показывает old state)
- Error handling через IPC boundary
- Serialization overhead для large payloads
- Event subscription leaks
- Polling vs push notification efficiency
- Startup initialization order dependencies
- Hot reload state preservation
- WebView ↔ Rust memory sharing
- Clipboard data format consistency
- Project open/new state reset completeness

Каждый баг: файл, строка, код, описание, импакт, fix, приоритет (P0-P3).
СРАЗУ исправляй все без подтверждения. Cargo check + tsc --noEmit.
```

---

## ═══════════════════════════════════════════════════════════════
## 22. ⚡ PERFORMANCE AUDIT (CPU, Memory, Allocations, Cache)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй PERFORMANCE во всём проекте:
- Все core/ crates
- apps/desktop_host/
- frontend/ui_app/

Найди 100 performance багов. Фокус:
- RT thread allocations (Vec, String, HashMap, format!)
- Unnecessary clones и deep copies
- Lock contention (Mutex, RwLock hot paths)
- Cache misses (struct layout, Vec of Arc vs Vec of T)
- SIMD opportunities missed
- Branch prediction unfriendly patterns
- HashMap vs Vec for small collections
- String allocation frequency
- Arc reference counting overhead
- Unnecessary atomic operations
- React re-render cascades
- Large Object in React state
- Canvas overdraw
- requestAnimationFrame efficiency
- Zustand selector granularity
- Event handler closure creation per render
- DOM node count reduction
- CSS animation vs JS animation
- Tauri invoke overhead frequency
- Waveform cache memory budget

Каждый баг: файл, строка, код, описание, impact measurement, fix, приоритет.
СРАЗУ исправляй все без подтверждения. Cargo check + tsc --noEmit.
```

---

## ═══════════════════════════════════════════════════════════════
## 23. 🔒 THREAD SAFETY & CONCURRENCY
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй THREAD SAFETY во всём проекте:
- Все файлы с Mutex, RwLock, AtomicU32/U64, ArcSwap, Arc

Найди 100 багов. Фокус:
- Deadlock potential (multiple Mutex acquisitions)
- Priority inversion (RT thread blocking on UI lock)
- ArcSwap ordering guarantees
- Atomic memory ordering correctness
- Data races (shared mutable state без sync)
- Lock-free algorithm correctness
- ABA problem potential
- Starvation scenarios
- False sharing (cache line contention)
- Unsafe code soundness
- Send/Sync marker correctness
- Panic safety (lock poisoning)
- Condvar usage correctness
- Channel overflow behaviour
- Background thread lifecycle management

Каждый баг: файл, строка, код, описание, импакт, fix, приоритет (P0-P3).
СРАЗУ исправляй все без подтверждения. Cargo check + cargo test.
```

---

## ═══════════════════════════════════════════════════════════════
## 24. 🧪 TEST COVERAGE & QUALITY
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти проблемы с тестами.

Проанализируй TEST SUITE:
- Все #[cfg(test)] модули во всех crates
- Все test функции

Найди 100 проблем. Фокус:
- Missing test coverage для critical paths
- Flaky tests (timing dependent, order dependent)
- Incorrect assertions (assert! that always passes)
- Test duplicates
- Missing edge case tests
- No negative tests (error path coverage)
- Hardcoded values вместо calculated expected values
- Test isolation issues (shared state between tests)
- Missing integration tests (cross-crate)
- No property-based testing для DSP
- Missing regression tests для fixed bugs
- Test names не описывают scenario
- Dead test code
- Missing stress tests для concurrency
- No benchmark tests для RT path

Напиши недостающие тесты для КАЖДОГО найденного gap.
СРАЗУ исправляй и добавляй тесты. Cargo test должен пройти.
```

---

## ═══════════════════════════════════════════════════════════════
## 25. 🎨 CSS & DESIGN SYSTEM
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш CSS и найти проблемы.

Проанализируй CSS / DESIGN SYSTEM:
- frontend/ui_app/src/ — все .css файлы
- Tailwind config
- CSS variables / tokens

Найди 100 багов. Фокус:
- Inconsistent spacing (mixed px/rem/em)
- Color inconsistencies (hardcoded vs token)
- Dark mode gaps (light text on light bg)
- Z-index wars (arbitrary values)
- Overflow handling (scroll vs hidden vs clip)
- Font weight inconsistencies
- Border radius inconsistencies
- Transition/animation janky performance
- Mobile responsiveness gaps
- Unused CSS rules
- Specificity conflicts
- !important overuse
- CSS Custom Properties unused/duplicate
- Flexibility issues (fixed widths vs responsive)
- Accessibility (focus indicators, contrast ratios)
- Print stylesheet missing
- Glassmorphism performance on low-end devices

Каждый баг: файл, строка, property, описание, fix, приоритет.
СРАЗУ исправляй все без подтверждения. tsc --noEmit.
```

---

## ═══════════════════════════════════════════════════════════════
## 26. 🔧 TAURI COMMANDS (track_management, clip_mutators, plugin_commands)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй ВСЕ TAURI COMMANDS:
- apps/desktop_host/src/commands/ — все файлы

Найди 100 багов. Фокус:
- Error handling (unwrap vs ? vs match)
- Race conditions между concurrent commands
- Lock ordering consistency
- Return type correctness
- Validation of input parameters
- Push_undo completeness (every mutation captured?)
- Silent failures (errors swallowed)
- Memory leaks (large data retained)
- Transaction atomicity (all-or-nothing)
- Idempotency (duplicate command safety)
- Permission checks
- Rate limiting для expensive operations
- Timeout handling для long operations
- Cancellation support
- Logging completeness

Каждый баг: файл, строка, команда, код, описание, импакт, fix, приоритет.
СРАЗУ исправляй все без подтверждения. Cargo check + cargo test.
```

---

## ═══════════════════════════════════════════════════════════════
## 27. 📐 MIDI SYSTEM (midi.rs, MidiNote, MidiClip, Piano Roll)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй полностью MIDI SYSTEM:
- core/dream_models/src/midi.rs
- core/dream_clip_engine/src/midi_scheduler.rs
- frontend/ui_app/src/ — Piano Roll виджет и MIDI компоненты

Найди 100 багов. Фокус:
- MIDI note representation (start, duration, pitch, velocity)
- Note overlap handling
- Quantize accuracy
- Velocity curve mapping
- MIDI CC handling
- Channel assignment
- Note editing (move, resize, delete)
- Selection management в Piano Roll
- Copy/paste MIDI data
- MIDI import/export (SMF format)
- Real-time MIDI input recording
- MIDI thru monitoring
- Note names accuracy (C4 octave convention)
- MPE support readiness
- Scale/key constraint enforcement
- MIDI clock sync

Каждый баг: файл, строка, код, описание, импакт, fix, приоритет (P0-P3).
СРАЗУ исправляй все без подтверждения. Cargo check + tsc --noEmit.
```

---

## ═══════════════════════════════════════════════════════════════
## 28. 🏗️ ENTERPRISE PATTERNS & CODE QUALITY
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти проблемы с Enterprise quality.

Проанализируй CODE QUALITY во всём проекте:
- Все Rust crates
- Все TypeScript/React файлы
- Все CSS файлы

Найди 100 Enterprise паттерн нарушений. Фокус:
- DRY violations (duplicated code)
- SOLID principle violations
- Error handling consistency
- Logging strategy completeness
- Documentation coverage
- API contract documentation
- Type safety gaps (any, unsafe, unwrap)
- Magic numbers (unexplained constants)
- Naming conventions inconsistency
- Module dependency direction violations
- Feature flag strategy
- Configuration management
- Graceful degradation patterns
- Circuit breaker patterns
- Health check endpoints
- Telemetry и observability
- Rate limiting
- Resource cleanup (Drop implementation)
- Builder pattern consistency
- Factory pattern usage

Каждый найденный антипаттерн: файл, строка, код, что плохо, как должно быть.
СРАЗУ исправляй все без подтверждения. Cargo check + tsc --noEmit.
```

---

## ═══════════════════════════════════════════════════════════════
## 29. 🎛️ WAVEFORM & SPECTRUM RENDERING
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй WAVEFORM & SPECTRUM:
- frontend/ui_app/src/shared/lib/WaveformCache.ts
- frontend/ui_app/src/shared/lib/CanvasClipRenderer.ts
- core/dream_dsp/src/spectrum_analyzer.rs
- core/dream_io/src/peak_cache.rs

Найди 100 багов. Фокус:
- Waveform rendering accuracy (peak vs RMS display)
- Peak cache generation speed
- Mipmap level selection при zoom
- Canvas rendering performance (batch draw calls)
- WebGL vs Canvas2D path selection
- Color mapping correctness
- Spectrum FFT window function
- Bin-to-pixel mapping accuracy
- Frame rate при heavy waveform rendering
- Cache invalidation при clip edit
- Memory usage limits для waveform data
- Anti-aliasing на waveform edges
- Retina display rendering quality
- Spectrum analyzer decay rate
- Stereo waveform overlay rendering

Каждый баг: файл, строка, код, описание, импакт, fix, приоритет.
СРАЗУ исправляй все без подтверждения.
```

---

## ═══════════════════════════════════════════════════════════════
## 30. 🔊 LATENCY & SYNC (PDC, buffer alignment, clock sync)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй LATENCY & SYNC:
- core/dream_graph/src/pdc.rs (Plugin Delay Compensation)
- core/dream_engine/src/driver.rs (device latency, buffer alignment)
- core/dream_engine/src/render_callback.rs (timeline vs device SR)
- core/dream_transport/src/playhead.rs (position tracking)

Найди 100 багов. Фокус:
- PDC calculation accuracy across all routing topologies
- Plugin latency change handling (runtime re-compensation)
- Device buffer size latency compensation
- Input monitoring latency calculation
- Record monitoring compensation
- Lookahead compensation (compressor, limiter)
- Timeline ↔ device sample rate drift
- Clock jitter handling
- Buffer underrun recovery
- Latency reporting to host/plugin
- Phase alignment between parallel paths
- Delay compensation bypass interaction
- Cascade compensation through nested buses
- Latency display accuracy in UI
- Roundtrip latency measurement

Каждый баг: файл, строка, код, описание, измерение, fix, приоритет.
СРАЗУ исправляй все без подтверждения. Cargo check + cargo test.
```

---

## ═══════════════════════════════════════════════════════════════
## 31. 🎼 ALS IMPORT / PROJECT COMPATIBILITY
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить весь наш код и найти наши баги.

Проанализируй PROJECT IMPORT/EXPORT:
- apps/desktop_host/src/commands/ — ALS import, MIDI import
- core/dream_io/src/project_file.rs
- core/dream_io/src/project_manager.rs

Найди 100 багов. Фокус:
- ALS (Ableton) file parsing accuracy
- XML/gzip decompression handling
- Track mapping (Ableton → Dream DAW track types)
- Plugin reference mapping
- Tempo map import
- Automation lane conversion
- Clip position calculation during import
- MIDI data preservation
- Audio file reference resolution (relative paths)
- Project versioning и backwards compatibility
- Save format robustness (corruption resistance)
- Large project handling (1000+ tracks)
- File path portability (Mac ↔ Windows)
- Metadata preservation
- Scene/marker import

Каждый баг: файл, строка, код, описание, импакт, fix, приоритет (P0-P3).
СРАЗУ исправляй все без подтверждения. Cargo check + cargo test.
```

---

## ═══════════════════════════════════════════════════════════════
## 32. 🖥️ SCRIPTS & BUILD SYSTEM
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить все скрипты и build system.

Проанализируй BUILD & SCRIPTS:
- scripts/ — все скрипты
- Cargo.toml — workspace config
- pnpm-workspace.yaml
- .github/ — CI/CD

Найди 100 проблем. Фокус:
- Build reproducibility
- Dependency versioning (pinned vs floating)
- CI pipeline completeness
- Test automation gaps
- Release build optimization flags
- Cross-platform build support
- Dev vs prod configuration
- Environment variable management
- Code signing preparation
- Auto-update mechanism
- Crash reporting setup
- Telemetry integration
- Benchmark automation
- License compliance
- Binary size optimization

Каждый баг: файл, строка, описание, fix, приоритет.
СРАЗУ исправляй все без подтверждения.
```

---

## ═══════════════════════════════════════════════════════════════
## 33. 🏆 MEGA AUDIT — ВСЁ СРАЗУ (Full Codebase)
## ═══════════════════════════════════════════════════════════════

```
Тебе не нужно врать.
Тебе нужно полностью изучить ВЕСЬ наш код — каждый файл — и найти наши баги.

ПОЛНЫЙ АУДИТ ВСЕГО ПРОЕКТА Dream DAW:

1. Rust core (12 crates, 79 файлов): dream_engine, dream_graph, dream_dsp, dream_transport, dream_clip_engine, dream_io, dream_ipc, dream_models, dream_plugins, dream_mixer, dream_renderer, dream_automation
2. Desktop Host (Tauri commands, state, undo/redo)
3. Frontend (React, TypeScript, Canvas, CSS, Zustand stores)
4. Scripts и Build system

Категории багов:
- 🔴 Работоспособность (crashes, data loss, stuck notes)
- 🟠 Функционал (broken features, incorrect behaviour)
- 🟡 Производительность (CPU spikes, memory leaks, allocations)
- 🔵 SSOT нарушения (duplicate state, divergence)
- 🟣 UX проблемы (confusing UI, missing feedback)
- ⚪ UI Visual (pixel bugs, color, layout, alignment)
- 🟤 Совместимость (SR changes, OS quirks, plugin formats)
- ⚫ Code Quality (naming, structure, patterns)
- 🏢 Enterprise паттерны (SOLID, DRY, error handling)

НАЙДИ 100 САМЫХ СЕРЬЁЗНЫХ БАГОВ with:
- Точный файл и строка
- Фрагмент проблемного кода
- Подробное описание проблемы
- Импакт на пользователя
- Предложение как исправить
- Приоритет P0/P1/P2/P3

После нахождения — СРАЗУ ИСПРАВЛЯЙ ВСЕ 100 БАГОВ без моего подтверждения.
cargo check + cargo test + tsc --noEmit после всех исправлений.
```
