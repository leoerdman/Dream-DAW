// ═══════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Serialize)]
struct PdcDebugSnapshot {
    node_count: usize,
    edge_count: usize,
    node_pdc_nonzero: usize,
    edge_pdc_nonzero: usize,
    processing_order: Vec<String>,
    nodes: Vec<PdcNodeDebug>,
    edges: Vec<PdcEdgeDebug>,
    node_summary: String,
    edge_summary: String,
}

#[derive(Debug, Clone, Serialize)]
struct PdcNodeDebug {
    node_id: u64,
    name: String,
    kind: String,
    own_latency_samples: u32,
    node_delay_samples: u32,
}

#[derive(Debug, Clone, Serialize)]
struct PdcEdgeDebug {
    from_node_id: u64,
    to_node_id: u64,
    from_name: String,
    to_name: String,
    edge_delay_samples: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RtDebugSnapshotPayload {
    enabled: bool,
    callback_count: u64,
    command_count_total: u64,
    command_count_last: u64,
    command_count_max: u64,
    callback_duration_us_last: u64,
    callback_duration_us_max: u64,
    callback_frames_last: u64,
    plugin_host_lock_miss_total: u64,
    queue_full_reject_total: u64,
    deferred_topology_len_last: u64,
    topology_overflow_total: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioChainAuditSummary {
    track_count: usize,
    routing_edges: usize,
    group_track_count: usize,
    muted_track_count: usize,
    solo_track_count: usize,
    tracks_with_external_fx: usize,
    tracks_with_internal_fx: usize,
    total_missing_plugin_slots: usize,
    routing_cycles: usize,
    invalid_routing_edges: usize,
    sidechain_links: usize,
    external_snapshot_tracks: usize,
    external_snapshot_expected: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioChainNodeAudit {
    total_nodes: usize,
    internal_effects: usize,
    external_plugins: usize,
    missing_plugins: usize,
    bypassed_nodes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioTrackRouteAudit {
    track_index: usize,
    track_id: String,
    name: String,
    track_type: String,
    muted: bool,
    solo: bool,
    parent_track_index: Option<usize>,
    output_track_index: Option<usize>,
    routes_to_master: bool,
    receives_children: bool,
    sidechain_source_indices: Vec<usize>,
    instrument: AudioChainNodeAudit,
    effects: AudioChainNodeAudit,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioChainAuditPayload {
    summary: AudioChainAuditSummary,
    issues: Vec<String>,
    tracks: Vec<AudioTrackRouteAudit>,
    master: AudioTrackRouteAudit,
}

fn selected_audit_chain(
    rack: &dream_models::project::DeviceRack,
) -> Option<&dream_models::project::RackChain> {
    let has_solo = rack.chains.iter().any(|c| c.is_solo);
    if has_solo {
        rack.chains.iter().find(|c| c.is_solo && !c.is_mute)
    } else {
        rack.chains.iter().find(|c| !c.is_mute)
    }
}

fn audit_device_node(node: &DeviceNode, inherited_bypass: bool, out: &mut AudioChainNodeAudit) {
    out.total_nodes = out.total_nodes.saturating_add(1);
    match node {
        DeviceNode::Single(slot) => {
            let bypassed = inherited_bypass || slot.is_bypassed;
            if bypassed {
                out.bypassed_nodes = out.bypassed_nodes.saturating_add(1);
            }
            if slot.plugin_id.starts_with("internal://effect/") {
                out.internal_effects = out.internal_effects.saturating_add(1);
            } else if slot.plugin_id.starts_with("internal://") {
                // Keep non-effect internal plugins in total_nodes only.
            } else if slot.plugin_id.starts_with("missing://") {
                out.missing_plugins = out.missing_plugins.saturating_add(1);
            } else {
                out.external_plugins = out.external_plugins.saturating_add(1);
            }
        }
        DeviceNode::Rack(rack) => {
            let rack_bypassed = inherited_bypass || rack.is_bypassed;
            if rack_bypassed {
                out.bypassed_nodes = out.bypassed_nodes.saturating_add(1);
            }
            if let Some(chain) = selected_audit_chain(rack) {
                for child in &chain.devices {
                    audit_device_node(child, rack_bypassed, out);
                }
            }
        }
    }
}

fn collect_sidechain_indices(node: &DeviceNode, id_to_index: &std::collections::HashMap<Uuid, usize>, out: &mut Vec<usize>) {
    match node {
        DeviceNode::Single(slot) => {
            if let Some(source_id) = &slot.sidechain_source_track_id
                && let Ok(uuid) = Uuid::parse_str(source_id)
                && let Some(idx) = id_to_index.get(&uuid).copied()
            {
                out.push(idx);
            }
        }
        DeviceNode::Rack(rack) => {
            for chain in &rack.chains {
                for child in &chain.devices {
                    collect_sidechain_indices(child, id_to_index, out);
                }
            }
        }
    }
}

include!("state_queries_core.rs");
include!("state_queries_transport.rs");
include!("state_queries_debug.rs");
