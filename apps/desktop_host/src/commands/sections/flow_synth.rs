use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedFlowGraph {
    nodes: Vec<(u64, String, Vec<(String, String)>)>,
    connections: Vec<(u64, usize, u64, usize)>,
}

fn persist_flow_graph_on_node(node: &mut dream_models::project::DeviceNode, payload: &str) -> bool {
    match node {
        dream_models::project::DeviceNode::Single(slot) => {
            if slot.plugin_id == "internal://instrument/flow" {
                slot.external_state_blob = Some(payload.to_string());
                slot.external_state_blob_kind = Some("flow_graph_v1".to_string());
                return true;
            }
            false
        }
        dream_models::project::DeviceNode::Rack(rack) => {
            for chain in &mut rack.chains {
                for child in &mut chain.devices {
                    if persist_flow_graph_on_node(child, payload) {
                        return true;
                    }
                }
            }
            false
        }
    }
}

fn persist_flow_graph_on_track(track: &mut dream_models::project::Track, payload: &str) -> bool {
    if let Some(instrument) = &mut track.instrument
        && persist_flow_graph_on_node(instrument, payload) {
            return true;
        }
    for effect in &mut track.effects {
        if persist_flow_graph_on_node(effect, payload) {
            return true;
        }
    }
    false
}

fn resolve_flow_track_index(project: &dream_models::project::Project, requested: u16) -> u16 {
    let track_count = project.tracks.len();
    if track_count == 0 {
        return 0;
    }
    (requested as usize).min(track_count.saturating_sub(1)) as u16
}

#[tauri::command]
fn set_flow_enabled_cmd(
    track_index: u16,
    enabled: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let resolved_track_index = {
        let project = project_state
            .project
            .lock()
            .map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
        resolve_flow_track_index(&project, track_index)
    };

    push_command(
        &handle,
        EngineCommand::SetFlowEnabled {
            track_index: resolved_track_index,
            enabled,
        },
    )?;
    Ok(())
}

#[tauri::command]
fn sync_flow_graph_cmd(
    track_index: u16,
    nodes: Vec<(u64, String, Vec<(String, String)>)>,
    connections: Vec<(u64, usize, u64, usize)>,
    handle: tauri::State<'_, AudioEngineHandle>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
) -> Result<(), String> {
    // Hard caps to avoid pathological payloads from UI.
    if nodes.len() > 256 {
        return Err("Flow graph has too many nodes (max 256).".to_string());
    }
    if connections.len() > 1024 {
        return Err("Flow graph has too many connections (max 1024).".to_string());
    }

    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let resolved_track_index = {
        let project = project_state
            .project
            .lock()
            .map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
        resolve_flow_track_index(&project, track_index)
    };

    let payload = PersistedFlowGraph {
        nodes: nodes.clone(),
        connections: connections.clone(),
    };
    push_command(
        &handle,
        EngineCommand::SyncFlowGraph {
            track_index: resolved_track_index,
            nodes,
            connections,
        },
    )?;
    let payload_json = serde_json::to_string(&payload)
        .map_err(|e| format!("Failed to serialize Flow graph: {e}"))?;
    {
        let mut project = project_state
            .project
            .lock()
            .map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
        if let Some(track) = project.tracks.get_mut(resolved_track_index as usize) {
            let persisted = persist_flow_graph_on_track(track, &payload_json);
            if !persisted {
                log::warn!(
                    "[FlowSynth] sync_flow_graph_cmd: no Flow slot found on track index={} for persistence",
                    resolved_track_index
                );
            }
        }
    }
    Ok(())
}
