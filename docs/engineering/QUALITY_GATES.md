# Dream DAW Quality Gates

This repository uses a hard quality gate to protect realtime audio stability and release quality.

## Local gate command

```bash
bash scripts/quality_gate.sh
```

## Gate stages

1. Sync Rust-generated TS bindings into frontend type directories.
2. `cargo check --workspace`.
3. `cargo clippy` for critical runtime crates with `-D warnings`.
4. `cargo test --workspace --lib`.
5. Frontend lint.
6. Frontend production build.

## Policy

- No merge to mainline without a green gate.
- Any warning in critical audio/host crates is treated as failure.
- Frontend must be buildable from clean checkout.
- Binding sync is mandatory before frontend checks.
