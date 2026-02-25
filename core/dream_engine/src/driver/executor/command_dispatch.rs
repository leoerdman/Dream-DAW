use super::super::*;

#[derive(Clone, Copy)]
pub(super) enum DeferredEffectChainCmd {
    Add {
        track_index: u16,
        slot_index: u8,
        effect_type: u8,
    },
    Remove {
        track_index: u16,
        slot_index: u8,
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

pub(super) fn apply_single_topology_mutation(
    deferred_topology: &mut VecDeque<DeferredEffectChainCmd>,
    master_device_chain: &mut InsertEffectsChain,
    render_ctx: &mut RenderContext,
    master_track_index: u16,
) {
    let Some(topology_cmd) = deferred_topology.pop_front() else {
        return;
    };
    match topology_cmd {
        DeferredEffectChainCmd::Add {
            track_index,
            slot_index,
            effect_type,
        } => {
            let idx = track_index as usize;
            if track_index == master_track_index {
                if let Some(etype) = BuiltinEffectType::from_u8(effect_type) {
                    master_device_chain.add_effect(slot_index as usize, etype);
                }
            } else if idx < render_ctx.track_slots.len()
                && let Some(etype) = BuiltinEffectType::from_u8(effect_type)
            {
                render_ctx.track_slots[idx]
                    .device_chain
                    .add_effect(slot_index as usize, etype);
            }
        }
        DeferredEffectChainCmd::Remove {
            track_index,
            slot_index,
        } => {
            let idx = track_index as usize;
            if track_index == master_track_index {
                master_device_chain.remove_effect(slot_index as usize);
            } else if idx < render_ctx.track_slots.len() {
                render_ctx.track_slots[idx]
                    .device_chain
                    .remove_effect(slot_index as usize);
            }
        }
    }
}
