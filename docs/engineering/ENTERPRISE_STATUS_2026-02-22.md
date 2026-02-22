# Enterprise Refactor Status — 2026-02-22

## Executive Summary
- Overall completion toward the 5-phase enterprise doctrine: **~58%**.
- Current build state: `cargo check -p desktop_host` **passes**.
- Immediate critical gap: monolithic files still exceed target file-size limits by a large margin.
- New enterprise control in CI: **Architecture Budget Report** is now generated and attached for every push/PR.

## Phase-by-Phase Status

### Phase 1 — Backend Decoupling: **62%**
Completed:
- `core/dream_importers` exists and contains modular ALS import pipeline (`parser`, `automation`, `clip_parser`, `markers`, `file_resolver`, `routing`, `plugin_mapper`, etc.).
- Multiple importer responsibilities already moved out of Tauri command file.

Remaining:
- `apps/desktop_host/src/commands/sections/project_management.rs` still **5285 LOC**.
- `apps/desktop_host/src/commands/sections/plugins_routing.rs` still **3304 LOC**.
- `apps/desktop_host/src/commands/sections/clip_mutators.rs` still **3072 LOC**.
- `apps/desktop_host/src/lib.rs` still **4884 LOC**.

### Phase 2 — Frontend Atomization: **45%**
Completed:
- `TrackInspector` was partially split to `ui/*` and `model/*`.
- `DeviceRack` has subfolders (`ui`, `model`) and partial extraction.

Remaining:
- `frontend/ui_app/src/widgets/DeviceRack/DeviceRack.tsx` still **2445 LOC**.
- `frontend/ui_app/src/widgets/AssetBrowser/AssetBrowser.tsx` still **3129 LOC**.
- `frontend/ui_app/src/widgets/PianoRoll/PianoRoll.tsx` still **2035 LOC**.
- `frontend/ui_app/src/shared/api/assistantService.ts` still **2827 LOC**.
- `frontend/ui_app/src/shared/stores/useEngineStore.ts` still **1192 LOC**.

### Phase 3 — Strict SSOT Types: **85%**
Completed:
- Canonical bindings dir: `frontend/shared_bindings`.
- Alias configured: `@bindings/*` in `frontend/ui_app/tsconfig.app.json`.
- Deprecated `frontend/ui_app/src/shared/types` is absent.
- Added CI gate: `scripts/ssot_guard.sh` (wired in `.github/workflows/ci.yml`).

Remaining:
- Keep enforcing guard across all branches and generated artifacts.

### Phase 4 — Sandbox Hardening: **55%**
Completed:
- `sandbox_host.rs`, `shared_memory.rs`, `sandbox_instance.rs`, daemon IPC are present and integrated.

Remaining:
- Formalized crash-recovery policy + explicit DAW UI event contract still incomplete in audited state.
- End-to-end lock-free ringbuffer proof and perf gate not finalized.

### Phase 5 — CI + Audio Null Testing: **70%**
Completed:
- CI workflow exists with fmt/clippy/test/tsc.
- Audio null-test infrastructure exists in `core/dream_engine/tests/audio_null.rs`.
- Added SSOT guard step into CI.
- Added architecture budget reporting in CI (`scripts/architecture_budget.sh`) with artifact + job summary.

Remaining:
- Clippy policy is not yet full `--workspace -- -D warnings` due existing warnings.
- Golden-reference null test requires fixture policy and release pipeline integration.

## Architecture Budget Snapshot (from `scripts/architecture_budget.sh`)
Current enforced reporting thresholds:
- Rust file limit: `1000` LOC
- TS/TSX file limit: `300` LOC

Top over-budget Rust files:
- `core/dream_plugins/src/vst3_host.rs` — 5664 LOC
- `apps/desktop_host/src/commands/sections/project_management.rs` — 4914 LOC
- `apps/desktop_host/src/lib.rs` — 4879 LOC
- `core/dream_engine/src/driver.rs` — 3833 LOC
- `apps/desktop_host/src/commands/sections/plugins_routing.rs` — 3304 LOC

Top over-budget TS/TSX files:
- `frontend/ui_app/src/widgets/AssetBrowser/AssetBrowser.tsx` — 3129 LOC
- `frontend/ui_app/src/app/layouts/DawShell.tsx` — 2516 LOC
- `frontend/ui_app/src/widgets/PianoRoll/PianoRoll.tsx` — 2035 LOC
- `frontend/ui_app/src/shared/lib/TimelineEngine.ts` — 1947 LOC
- `frontend/ui_app/src/widgets/DeviceRack/ui/PluginGuiSurface.tsx` — 1905 LOC

## Recently Completed in This Iteration
- Unified ALS color index extraction into importer SSOT API.
- Unified color mapping behavior for tracks/clips/markers/scenes.
- Added importer-level regression tests for color parsing and scene/marker color forms.
- Added env-gated ALS regression test for `Again V117` track colors.
- Added CI-level SSOT guard and removed duplicate local `core/dream_models/bindings` directory.

## Next 3 High-Impact Steps (Execution Order)
1. Split `project_management.rs` into importer entrypoint + thin Tauri facade until file is under 1000 LOC.
2. Split `DeviceRack.tsx` and `AssetBrowser.tsx` into memoized subcomponents/hooks with strict selectors.
3. Raise CI clippy gate to workspace-wide strict mode after warning burn-down.
