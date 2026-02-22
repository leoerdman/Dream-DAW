# Architecture Audit — February 2026

## Scope
Dream DAW codebase standardization toward enterprise maintainability and SSOT.

## Critical Findings
1. Backend command-layer monoliths: oversized `desktop_host` command files.
2. Frontend monolith widgets: oversized React components (`DeviceRack`, `TrackInspector`, `AssetBrowser`, `PianoRoll`).
3. Type SSOT drift risk: previously duplicated generated model bindings.
4. Delivery risk: insufficient CI quality gates for fast regression detection.

## Completed in this pass
1. Type SSOT hardening:
- Removed duplicate generated type trees:
  - `core/dream_models/bindings`
  - `frontend/ui_app/src/shared/types`
- Kept a single source:
  - `frontend/shared_bindings`
- Updated TS resolution:
  - alias `@bindings/*` in `frontend/ui_app/tsconfig.app.json`
  - alias `@bindings` in `frontend/ui_app/vite.config.ts`
- Migrated UI imports to `@bindings`.

2. Binding generation pipeline unification:
- `core/dream_models/src/lib.rs` export test now writes directly to `frontend/shared_bindings`.
- `scripts/sync_bindings.sh` now regenerates only SSOT bindings (with stale-file cleanup).

3. Compile/runtime integrity fixes discovered during audit:
- Fixed transport context type mismatches (`u8 -> i32`) in:
  - `core/dream_engine/src/driver.rs`
  - `core/dream_engine/src/offline_bounce.rs`

## Verified
1. `bash scripts/sync_bindings.sh` — pass.
2. `pnpm -C frontend/ui_app exec tsc --noEmit` — pass.
3. `cargo check -p desktop_host --offline` — pass.

## Phase-Next (Execution Order)
1. Backend monolith extraction:
- Move ALS/domain-heavy logic out of Tauri command sections into core crates.
- Keep Tauri command handlers as thin IPC facades.

2. Frontend monolith decomposition:
- Split `DeviceRack` first into widget components + `useDeviceRack` hook.
- Add render-boundary memoization (`React.memo`) at slot/chain level.

3. CI hardening:
- Add workflow for `cargo check/test`, `clippy`, and frontend `tsc`.

4. Audio-chain validation matrix:
- Add deterministic route-chain regression tests (track/group/master, internal/external, bypass, mute/solo).
