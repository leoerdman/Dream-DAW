// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — CQRS Orchestrator
// ═══════════════════════════════════════════════════════════════════════════
//
// This crate is the SINGLE OWNER of all project business logic.
// It defines the Command/Query pattern that decouples business rules
// from the transport layer (Tauri, CLI, headless cloud render, etc.).
//
// Architecture:
//   Transport Layer (Tauri/CLI) → OrchestratorContext → Commands/Queries → Core Crates
//
// The transport layer is reduced to:
//   1. Deserialize arguments
//   2. Call orchestrator.execute(command)
//   3. Serialize response
//
// This enables:
//   - Headless DAW for cloud rendering (no Tauri)
//   - CLI bounce tool
//   - Unit testing without any GUI framework
//
// ═══════════════════════════════════════════════════════════════════════════

pub mod commands;
pub mod context;
pub mod error;

// Re-export for convenience
pub use context::OrchestratorContext;
pub use error::{OrchestratorError, OrchestratorResult};
