# Dream DAW Quality Gates

This repository uses a hard quality gate to protect realtime audio stability and release quality.

## Local gate command

```bash
bash scripts/quality_gate.sh
```

By default gates write build artifacts to `/tmp` via `CARGO_TARGET_DIR` to avoid
polluting workspace and to reduce disk-pressure failures in long hardening runs.

## Gate stages

1. Sync Rust-generated TS bindings into frontend type directories.
2. `cargo check --workspace`.
3. `cargo clippy` for critical runtime crates with policy-deny lints:
   `clippy::unwrap_used`, `clippy::expect_used`, `clippy::todo`, `clippy::dbg_macro`.
4. `cargo test --workspace --lib`.
5. Frontend TypeScript `tsc --noEmit`.
6. Frontend production build.
7. Optional headless fuzz gate (`scripts/headless_fuzz_gate.sh`).
8. Optional sanitizer gate (`scripts/sanitizer_gate.sh`).

## Hardening modes

Enable extra gates locally/CI by setting env vars before running the main gate:

```bash
DREAM_ENABLE_HEADLESS_FUZZ=1 bash scripts/quality_gate.sh
DREAM_ENABLE_SANITIZERS=1 bash scripts/quality_gate.sh
```

## Policy

- No merge to mainline without a green gate.
- Policy-deny clippy findings in critical audio/host crates are treated as failure.
- Frontend must pass `tsc --noEmit` and be buildable from clean checkout.
- Frontend lint currently runs in advisory mode during lint-debt burn-down.
- Binding sync is mandatory before frontend checks.
