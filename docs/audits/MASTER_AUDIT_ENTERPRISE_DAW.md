# Dream DAW — Master Enterprise Audit

Date: 2026-02-14
Scope: `core/*`, `apps/desktop_host`, `frontend/ui_app`

## Executive Summary

The codebase already has a strong pro-audio foundation: lock-free command queue (`rtrb`), atomic snapshots (`ArcSwap`), modular Rust crates, and a production-grade frontend separation.

The next x3-x10 improvement comes from hardening contracts and deterministic behavior, not from adding more UI features.

## Priority Matrix

### P0 — Must Fix (Release Safety)

1. Plugin isolation boundary
- Risk: single plugin failure can still compromise host stability.
- Target: run VST host in isolated process + recoverable IPC bridge.

2. Realtime invariants as enforceable policy
- Risk: regressions can reintroduce allocations/locks/panics in hot path.
- Target: CI gate + static checks + explicit allowlists for RT-critical code.

3. Project persistence determinism
- Risk: open/save mismatch after tempo/routing/clip edits.
- Target: versioned schema + migrations + corruption/recovery path.

4. Tempo/timebase consistency guarantees
- Risk: clip playback mismatch under BPM/grid changes.
- Target: single source of truth for beat<->frame mapping (runtime + persistence).

### P1 — High Value (Scalability/Performance)

1. Large-session performance envelope
- Benchmark profiles: 64/128 tracks, dense MIDI, plugin chains, live record.
- KPI: stable audio callback budget and UI frame pacing.

2. Golden audio tests
- Snapshot-based render verification for export/playback/loop/automation.

3. Backend command decomposition maturation
- Keep modular command sections and remove dead/backup artifacts continuously.

4. Observability for production incidents
- Structured logs, crash context, and command/event trace slices.

### P2 — Product Polish (Power-user Quality)

1. Automation + editing edge-case consistency
- Shift/alt gestures, merge/split semantics, batch note editing correctness.

2. Routing UX introspection
- Explain graph path/latency per track visually for debugging chains.

3. Plugin UX parity
- Better inline/native GUI lifecycle and robust reopen behavior.

## Current Findings (from code sweep)

1. `expect` in host lifecycle existed in `apps/desktop_host/src/lib.rs`.
- Status: fixed in this wave (graceful fail + logging).

2. Unsafe-in-unsafe-fn warnings in VST host (`core/dream_plugins/src/vst3_host.rs`).
- Status: fixed in this wave.

3. Quality gate was missing strict warning policy.
- Status: fixed in this wave (`scripts/quality_gate.sh`, CI workflow).

4. TS binding bridge drift risk between Rust-generated files and frontend usage.
- Status: fixed in this wave via `scripts/sync_bindings.sh` + predev/prebuild hooks.

## Implemented Guardrails

- `scripts/quality_gate.sh` now enforces:
  - bindings sync
  - `cargo check --workspace`
  - `cargo clippy` (`-D warnings`) on critical crates
  - `cargo test --workspace --lib`
  - frontend lint with `--max-warnings=0`
  - frontend build

- CI workflow:
  - `.github/workflows/quality-gate.yml`

- Engineering policy doc:
  - `docs/engineering/QUALITY_GATES.md`

## 30-Day Acceleration Plan

Week 1:
- Define RT policy file (allowlist of justified unsafe/lock usage).
- Add perf baseline scenarios and publish metrics artifacts per PR.

Week 2:
- Implement plugin host process boundary prototype (single plugin process).
- Add watchdog restart + state resync path.

Week 3:
- Project schema versioning and migration tests.
- Add save/load determinism tests around tempo + MIDI + sampler state.

Week 4:
- Golden audio snapshots for playback/export parity.
- Failure-injection tests (plugin crash, I/O error, cancelled export).

## Definition of “Enterprise Ready” for This DAW

1. No host crash from plugin failure.
2. Deterministic save/load roundtrip for project state.
3. Quality gate green is mandatory for merge.
4. Realtime callback remains lock-free and allocation-free by policy.
5. Benchmark regression budget enforced in CI.
