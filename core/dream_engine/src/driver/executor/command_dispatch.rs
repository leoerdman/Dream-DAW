use super::super::*;
use dream_dsp::device_slot::DeviceProcessor;

// ═══════════════════════════════════════════════════════════════════════════
// Deferred Topology Commands
// ═══════════════════════════════════════════════════════════════════════════
//
// Topology mutations (add/remove/reorder devices) are deferred to the start
// of the NEXT audio callback to avoid mid-buffer discontinuities.
// These commands can hold non-Copy data (Box<dyn DeviceProcessor>).
//
// ═══════════════════════════════════════════════════════════════════════════

#[allow(dead_code)]
pub(super) enum DeferredDeviceChainCmd {
    /// Add a built-in DSP effect.
    AddInternal {
        track_index: u16,
        slot_index: u8,
        effect_type: u8,
    },
    /// Add a pre-constructed device (internal or external).
    /// Used when the device is created on the UI thread and passed to the
    /// audio thread (e.g., ExternalDeviceSlot wrapping a PluginInstanceArc).
    AddDevice {
        track_index: u16,
        slot_index: u8,
        device: Box<dyn DeviceProcessor>,
    },
    /// Remove a device by slot index.
    Remove {
        track_index: u16,
        slot_index: u8,
    },
    /// Reorder a device within its chain (atomic move).
    Reorder {
        track_index: u16,
        from_slot: u8,
        to_slot: u8,
    },
}

#[allow(clippy::too_many_arguments)]
pub(super) fn apply_pending_track_mixer_state(
    render_ctx: &mut RenderContext,
    pending_track_volume: &[Option<f32>; MAX_TRACKS],
    pending_track_pan: &[Option<f32>; MAX_TRACKS],
    pending_track_disabled: &[Option<bool>; MAX_TRACKS],
    pending_track_solo: &[Option<bool>; MAX_TRACKS],
    track_disabled: &mut [bool; MAX_TRACKS],
    track_soloed: &mut [bool; MAX_TRACKS],
    any_solo: &mut bool,
    routing_snapshot: &Arc<SharedRoutingSnapshot>,
) {
    for i in 0..render_ctx.track_slots.len().min(MAX_TRACKS) {
        if let Some(v) = pending_track_volume[i] {
            render_ctx.track_slots[i].strip.set_volume(v);
        }
        if let Some(p) = pending_track_pan[i] {
            render_ctx.track_slots[i].strip.set_pan(p);
        }
        if let Some(m) = pending_track_disabled[i] {
            track_disabled[i] = m;
        }
        if let Some(s) = pending_track_solo[i] {
            track_soloed[i] = s;
        }
    }

    let has_pending_solo_or_disable = pending_track_solo
        .iter()
        .take(render_ctx.track_slots.len())
        .any(|v| v.is_some())
        || pending_track_disabled
            .iter()
            .take(render_ctx.track_slots.len())
            .any(|v| v.is_some());
    if !has_pending_solo_or_disable {
        return;
    }

    let active_track_count = render_ctx.track_slots.len().min(MAX_TRACKS);
    let mut effective_soloed = [false; MAX_TRACKS];
    effective_soloed[..MAX_TRACKS].copy_from_slice(&track_soloed[..MAX_TRACKS]);
    let routing_now = routing_snapshot.load();

    for (child_idx, is_track_soloed) in track_soloed.iter().enumerate().take(active_track_count) {
        if !*is_track_soloed {
            continue;
        }
        let mut visited = [0u64; 4];
        let mut current = child_idx;
        loop {
            let word = current / 64;
            let bit = current % 64;
            if word >= 4 || (visited[word] & (1u64 << bit)) != 0 {
                break;
            }
            visited[word] |= 1u64 << bit;
            match routing_now.get(current) {
                Some(Some(parent_idx)) if *parent_idx < active_track_count => {
                    effective_soloed[*parent_idx] = true;
                    current = *parent_idx;
                }
                _ => break,
            }
        }
    }

    for (descendant_idx, effective_soloed_flag) in effective_soloed
        .iter_mut()
        .enumerate()
        .take(active_track_count)
    {
        if *effective_soloed_flag {
            continue;
        }
        let mut visited = [0u64; 4];
        let mut current = descendant_idx;
        loop {
            let word = current / 64;
            let bit = current % 64;
            if word >= 4 || (visited[word] & (1u64 << bit)) != 0 {
                break;
            }
            visited[word] |= 1u64 << bit;
            match routing_now.get(current) {
                Some(Some(parent_idx)) if *parent_idx < active_track_count => {
                    if track_soloed[*parent_idx] {
                        *effective_soloed_flag = true;
                        break;
                    }
                    current = *parent_idx;
                }
                _ => break,
            }
        }
    }

    *any_solo = effective_soloed.iter().take(active_track_count).any(|s| *s);
    for i in 0..active_track_count {
        let enabled = !track_disabled[i] && (!*any_solo || effective_soloed[i]);
        render_ctx.track_slots[i].strip.set_output_enabled(enabled);
    }
}

/// Applies ALL pending topology mutations at the start of each buffer.
///
/// Previously this processed only ONE mutation per callback (A-3 bug).
/// Now it drains the entire queue, ensuring device chain state is always
/// fully synchronized by the time audio processing begins.
pub(super) fn apply_all_topology_mutations(
    deferred_topology: &mut VecDeque<DeferredDeviceChainCmd>,
    master_device_chain: &mut DeviceChain,
    render_ctx: &mut RenderContext,
    master_track_index: u16,
) {
    while let Some(topology_cmd) = deferred_topology.pop_front() {
        match topology_cmd {
            DeferredDeviceChainCmd::AddInternal {
                track_index,
                slot_index,
                effect_type,
            } => {
                let idx = track_index as usize;
                if track_index == master_track_index {
                    if let Some(etype) = BuiltinEffectType::from_u8(effect_type) {
                        master_device_chain.add_builtin_effect(slot_index as usize, etype);
                    }
                } else if idx < render_ctx.track_slots.len()
                    && let Some(etype) = BuiltinEffectType::from_u8(effect_type)
                {
                    render_ctx.track_slots[idx]
                        .device_chain
                        .add_builtin_effect(slot_index as usize, etype);
                }
            }
            DeferredDeviceChainCmd::AddDevice {
                track_index,
                slot_index,
                device,
            } => {
                let idx = track_index as usize;
                if track_index == master_track_index {
                    master_device_chain.add_device(slot_index as usize, device);
                } else if idx < render_ctx.track_slots.len() {
                    render_ctx.track_slots[idx]
                        .device_chain
                        .add_device(slot_index as usize, device);
                }
            }
            DeferredDeviceChainCmd::Remove {
                track_index,
                slot_index,
            } => {
                let idx = track_index as usize;
                if track_index == master_track_index {
                    master_device_chain.remove_device(slot_index as usize);
                } else if idx < render_ctx.track_slots.len() {
                    render_ctx.track_slots[idx]
                        .device_chain
                        .remove_device(slot_index as usize);
                }
            }
            DeferredDeviceChainCmd::Reorder {
                track_index,
                from_slot,
                to_slot,
            } => {
                let idx = track_index as usize;
                if track_index == master_track_index {
                    master_device_chain.reorder(from_slot as usize, to_slot as usize);
                } else if idx < render_ctx.track_slots.len() {
                    render_ctx.track_slots[idx]
                        .device_chain
                        .reorder(from_slot as usize, to_slot as usize);
                }
            }
        }
    }
}

/// Backward-compatible wrapper that applies a single mutation.
/// Used by callers that still expect the old behavior.
pub(super) fn apply_single_topology_mutation(
    deferred_topology: &mut VecDeque<DeferredDeviceChainCmd>,
    master_device_chain: &mut DeviceChain,
    render_ctx: &mut RenderContext,
    master_track_index: u16,
) {
    apply_all_topology_mutations(
        deferred_topology,
        master_device_chain,
        render_ctx,
        master_track_index,
    );
}
