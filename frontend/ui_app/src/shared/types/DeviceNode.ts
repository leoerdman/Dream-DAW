// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Device Rack TypeScript Types
// ═══════════════════════════════════════════════════════════════════════════
//
// Mirrors the Rust data model from dream_models/src/project.rs.
// These types enable the frontend to work with the recursive device chain
// model (racks containing parallel chains of devices).
//
// ═══════════════════════════════════════════════════════════════════════════

import type { PluginSlot } from './PluginSlot';

// ── Rack Type ──────────────────────────────────────────────────────────

/** Type of device rack (mirrors Rust `RackType`). */
export type RackType = 'Instrument' | 'AudioEffect' | 'DrumRack' | 'MidiEffect';

// ── Zone Settings ──────────────────────────────────────────────────────

/** Zone settings for a rack chain — key, velocity, and chain selector ranges. */
export interface ZoneSettings {
    key_range_min: number;
    key_range_max: number;
    velocity_range_min: number;
    velocity_range_max: number;
    chain_selector_min: number;
    chain_selector_max: number;
}

// ── Macro Control ──────────────────────────────────────────────────────

/** Maps a macro control to a device parameter (mirrors Rust `MacroMapping`). */
export interface MacroMapping {
    device_id: string;
    param_id: string;
    min_value: number;
    max_value: number;
}

/** A single macro knob on a rack (mirrors Rust `MacroControl`). */
export interface MacroControl {
    index: number;
    name: string;
    value: number;
    default_value: number;
    mappings: MacroMapping[];
}

// ── Rack Chain ─────────────────────────────────────────────────────────

/** A parallel chain inside a rack (mirrors Rust `RackChain`). */
export interface RackChain {
    id: string;
    name: string;
    devices: DeviceNode[];
    zone_settings?: ZoneSettings;
    is_solo: boolean;
    is_mute: boolean;
    volume: number;
    pan: number;
}

// ── Device Rack ────────────────────────────────────────────────────────

/** A device rack container with parallel chains (mirrors Rust `DeviceRack`). */
export interface DeviceRack {
    id: string;
    name: string;
    rack_type: RackType;
    chains: RackChain[];
    macro_controls: MacroControl[];
    is_bypassed: boolean;
    is_expanded: boolean;
}

// ── Device Node ────────────────────────────────────────────────────────

/** A single device (plugin) node in the chain. */
export interface DeviceNodeSingle {
    type: 'Single';
    /** PluginSlot data — id, name, plugin_id, is_bypassed, latency_frames. */
    id: string;
    name: string;
    plugin_id: string;
    is_bypassed: boolean;
    latency_frames: number;
}

/** A rack container node in the chain. */
export interface DeviceNodeRack {
    type: 'Rack';
    /** DeviceRack data. */
    id: string;
    name: string;
    rack_type: RackType;
    chains: RackChain[];
    macro_controls: MacroControl[];
    is_bypassed: boolean;
    is_expanded: boolean;
}

/** A node in the device chain — either a single plugin or a rack (mirrors Rust `DeviceNode`). */
export type DeviceNode = DeviceNodeSingle | DeviceNodeRack;

// ── Helpers ────────────────────────────────────────────────────────────

/** Type guard: check if a DeviceNode is a single plugin. */
export function isSingleDevice(node: DeviceNode): node is DeviceNodeSingle {
    return node.type === 'Single';
}

/** Type guard: check if a DeviceNode is a rack. */
export function isRackDevice(node: DeviceNode): node is DeviceNodeRack {
    return node.type === 'Rack';
}

/** Extract a flat PluginSlot from a DeviceNodeSingle. */
export function toPluginSlot(node: DeviceNodeSingle): PluginSlot {
    return {
        id: node.id,
        name: node.name,
        plugin_id: node.plugin_id,
        is_bypassed: node.is_bypassed,
        latency_frames: node.latency_frames,
    };
}

/** Recursively collect all PluginSlots from a DeviceNode tree. */
export function collectPluginSlots(nodes: DeviceNode[]): PluginSlot[] {
    const result: PluginSlot[] = [];
    for (const node of nodes) {
        if (isSingleDevice(node)) {
            result.push(toPluginSlot(node));
        } else {
            for (const chain of node.chains) {
                result.push(...collectPluginSlots(chain.devices));
            }
        }
    }
    return result;
}
