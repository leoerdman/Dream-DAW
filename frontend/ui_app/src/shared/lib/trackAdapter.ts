// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Track Adapter (SSOT Bridge)
// ═══════════════════════════════════════════════════════════════════════════
//
// Pure functions that convert ts-rs generated types (from Rust SSOT) into
// the UI-friendly `ProjectTrack` shape consumed by React components.
//
// This eliminates large inline payload assertions in project hydration paths
// and prevents drift between the Rust model and the TypeScript UI layer.
//
// ═══════════════════════════════════════════════════════════════════════════

import type { TrackColor } from '@bindings/TrackColor';
import type { DeviceNode } from '@bindings/DeviceNode';
import type { SampleRackConfig } from '@bindings/SampleRackConfig';

// ── Track color palette (matches Rust TrackColor enum hex values) ─────────

const toHexColor = (r: number, g: number, b: number): string =>
    `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

const TRACK_COLORS: Record<TrackColor, string> = {
    Coral: toHexColor(240, 92, 77),
    Orange: toHexColor(255, 138, 26),
    Gold: toHexColor(255, 191, 51),
    Yellow: toHexColor(255, 225, 77),
    Lime: toHexColor(163, 217, 77),
    Green: toHexColor(77, 199, 117),
    Teal: toHexColor(77, 199, 176),
    Cyan: toHexColor(77, 199, 204),
    Sky: toHexColor(77, 166, 227),
    Blue: toHexColor(77, 122, 227),
    Indigo: toHexColor(107, 92, 227),
    Purple: toHexColor(155, 89, 217),
    Magenta: toHexColor(217, 77, 166),
    Pink: toHexColor(227, 107, 150),
    Rose: toHexColor(230, 102, 115),
    Slate: toHexColor(140, 148, 158),
};

const DEFAULT_TRACK_COLOR = toHexColor(102, 119, 136);

/**
 * Resolve a track color to a hex string.
 * Handles: TrackColor enum names, raw hex strings, and fallback.
 */
export function resolveTrackColor(color: unknown): string {
    if (typeof color === 'string') {
        if (color.startsWith('#')) return color;
        return TRACK_COLORS[color as TrackColor] ?? DEFAULT_TRACK_COLOR;
    }
    return DEFAULT_TRACK_COLOR;
}

// ── Flat effect/instrument shape for UI consumption ──────────────────────

export interface FlatPluginSlot {
    id: string;
    name: string;
    plugin_id: string;
    is_bypassed: boolean;
    supports_sidechain_input?: boolean;
    sidechain_source_track_id?: string | null;
}

/**
 * Flatten a DeviceNode (tagged union: Single | Rack) into a flat plugin slot.
 * For rack types, returns null (racks are rendered separately).
 */
function flattenDeviceNode(node: DeviceNode): FlatPluginSlot | null {
    if (node.type === 'Single') {
        return {
            id: node.id ?? '',
            name: node.name ?? '',
            plugin_id: node.plugin_id ?? '',
            is_bypassed: Boolean(node.is_bypassed ?? false),
            supports_sidechain_input: node.supports_sidechain_input ?? undefined,
            sidechain_source_track_id: node.sidechain_source_track_id ?? null,
        };
    }
    return null;
}

// ── Sampler shape for UI (subset of SamplerConfig for backward compat) ──

export interface SamplerState {
    sample_path: string;
    root_note: number;
    volume: number;
    attack: number;
    decay: number;
    sustain: number;
    release: number;
    osc2_waveform?: number;
    osc_mix?: number;
    detune_cents?: number;
    sub_level?: number;
}

// ── ProjectTrack: the UI-friendly shape ──────────────────────────────────

export interface ProjectTrack {
    id: string;
    name: string;
    track_type: string;
    color: string;
    volume: number;
    pan: number;
    send_a: number;
    send_b: number;
    is_mute: boolean;
    is_solo: boolean;
    is_armed: boolean;
    height: number;
    output: string;
    input: string;
    parent_track_id?: string | null;
    child_track_ids?: string[];
    is_expanded?: boolean;
    effects: FlatPluginSlot[];
    instrument: FlatPluginSlot | null;
    sampler: SamplerState | null;
    sample_rack?: SampleRackConfig | null;
    automation_lanes: Array<{
        param_id: string;
        points: Array<{
            beat: number;
            value: number;
            curve_type?: string;
            tension?: number;
        }>;
    }>;
}

// ── Backend response shape (project payload from backend snapshot) ───────
//
// NOTE: This is intentionally loose — the backend JSON may not exactly match
// the ts-rs types due to Tauri serialization quirks (missing fields, bigint→number
// coercion, etc.). We validate at the boundary rather than trusting the shape.

type RawBackendTrack = Record<string, unknown> & {
    id: string;
    name: string;
    track_type?: string;
    color?: unknown;
    color_hex?: string | null;
    volume?: number;
    pan?: number;
    is_mute?: boolean;
    is_solo?: boolean;
    is_armed?: boolean;
    height?: number;
    output_destination_id?: string | null;
    input_source_id?: string | null;
    parent_track_id?: string | null;
    child_track_ids?: string[];
    is_expanded?: boolean;
    effects?: DeviceNode[];
    instrument?: DeviceNode | null;
    sampler?: SamplerState | null;
    sample_rack?: SampleRackConfig | null;
    automation_lanes?: Array<{
        param_id: string;
        points: Array<{
            beat: number;
            value: number;
            curve_type?: string;
            tension?: number;
        }>;
    }>;
};

/**
 * Convert a raw backend track response into a UI-friendly ProjectTrack.
 *
 * This is the single boundary where Rust model → TS UI conversion happens.
 * All field coercion, default values, and enum→hex resolution live here.
 */
export function adaptTrack(raw: RawBackendTrack): ProjectTrack {
    const color = raw.color_hex || resolveTrackColor(raw.color);

    // Flatten effects: DeviceNode[] → FlatPluginSlot[]
    const effects: FlatPluginSlot[] = [];
    for (const node of raw.effects ?? []) {
        const flat = flattenDeviceNode(node as DeviceNode);
        if (flat) effects.push(flat);
    }

    // Flatten instrument
    const instrument = raw.instrument
        ? flattenDeviceNode(raw.instrument as DeviceNode)
        : null;

    const automationLanes = Array.isArray(raw.automation_lanes) ? raw.automation_lanes : [];
    const readSend = (paramId: 'send.A' | 'send.B'): number => {
        const lane = automationLanes.find((l) => (l?.param_id ?? '').toLowerCase() === paramId.toLowerCase());
        if (!lane || !Array.isArray(lane.points) || lane.points.length === 0) return 0;
        const last = lane.points[lane.points.length - 1];
        const v = Number(last?.value ?? 0);
        if (!Number.isFinite(v)) return 0;
        return Math.max(0, Math.min(1, v));
    };

    return {
        id: raw.id,
        name: raw.name,
        track_type: raw.track_type || 'Audio',
        color,
        volume: raw.volume ?? 1.0,
        pan: raw.pan ?? 0.0,
        send_a: readSend('send.A'),
        send_b: readSend('send.B'),
        is_mute: Boolean(raw.is_mute ?? false),
        is_solo: Boolean(raw.is_solo ?? false),
        is_armed: Boolean(raw.is_armed ?? false),
        height: Number(raw.height ?? 80),
        output:
            (raw.output_destination_id && raw.output_destination_id.length > 0
                ? raw.output_destination_id
                : (raw.output as string | undefined)) || 'master',
        input:
            (raw.input_source_id && raw.input_source_id.length > 0
                ? raw.input_source_id
                : (raw.input as string | undefined)) || 'none',
        parent_track_id: raw.parent_track_id ?? null,
        child_track_ids: raw.child_track_ids ?? [],
        is_expanded: Boolean(raw.is_expanded ?? true),
        effects,
        instrument,
        sampler: raw.sampler ?? null,
        sample_rack: raw.sample_rack ?? null,
        automation_lanes: automationLanes,
    };
}
