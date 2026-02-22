use std::collections::HashSet;

use dream_models::project::{DeviceNode, Project};
use uuid::Uuid;

pub fn bypass_plugin_slots_in_project(project: &mut Project, slot_ids: &HashSet<Uuid>) -> usize {
    fn bypass_in_node(node: &mut DeviceNode, slot_ids: &HashSet<Uuid>, changed: &mut usize) {
        for slot in node.collect_plugin_slots_mut() {
            if slot_ids.contains(&slot.id) && !slot.is_bypassed {
                slot.is_bypassed = true;
                *changed = changed.saturating_add(1);
            }
        }
    }

    let mut changed = 0usize;
    for track in &mut project.tracks {
        if let Some(inst) = track.instrument.as_mut() {
            bypass_in_node(inst, slot_ids, &mut changed);
        }
        for node in &mut track.effects {
            bypass_in_node(node, slot_ids, &mut changed);
        }
    }
    for node in &mut project.master_track.effects {
        bypass_in_node(node, slot_ids, &mut changed);
    }
    changed
}
