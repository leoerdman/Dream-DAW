// ═══════════════════════════════════════════════════════════════════════

#[derive(Debug, Serialize, Deserialize)]
struct TrackManagementDeltaResponse {
    deltas: Vec<dream_models::delta::ProjectDelta>,
}

include!("track_crud/add_delete_commands.rs");
include!("track_crud/naming_layout_commands.rs");
