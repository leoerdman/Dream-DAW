/* ═══════════════════════════════════════════════════════════════
   INTERNAL PLUGIN PAGE MANIFEST
   Defines the multi-page layout system for internal plugins.
   Each plugin can have multiple "pages" (tabs), allowing the
   main view to stay compact while settings live on a secondary page.

   External plugins (VST/AU) do NOT use this system — they have
   their own native UIs.
   ═════════════════════════════════════════════════════════════ */

/**
 * Single parameter control on a plugin page.
 * Determines HOW a parameter is rendered (knob vs fader).
 */
export interface PageParamEntry {
    /** Engine parameter name (case-insensitive match against device.params[].name) */
    name: string;
    /** Render mode: 'knob' (circular) or 'fader' (horizontal slider) */
    control: 'knob' | 'fader';
    /** Optional display label override (if omitted, uses param.name) */
    label?: string;
    /** For fader: explicit min/max override (e.g. Transpose: -24..+24) */
    faderMin?: number;
    faderMax?: number;
}

/**
 * A single page/tab within a plugin's UI.
 */
export interface PluginPage {
    /** Unique page identifier */
    id: string;
    /** Tab button text (shown in the tab switcher) */
    label: string;
    /** Parameters to show on this page, in order. Empty = show nothing. */
    params: PageParamEntry[];
}

/**
 * Complete page manifest for one internal plugin.
 * Plugins without a manifest render all params as a single-page knob grid.
 */
export interface PluginPageManifest {
    /** Ordered list of pages. First page = default. */
    pages: PluginPage[];
}

/* ─────────────────────────────────────────────────────────────
   SAMPLER PAGE MANIFEST
   Page 1 "Waveform": Core sound controls (Vol, ADSR)
   Page 2 "Settings": Transpose fader + filter + extras
   ───────────────────────────────────────────────────────────── */

export const SAMPLER_PAGE_MANIFEST: PluginPageManifest = {
    pages: [
        {
            id: 'waveform',
            label: 'Waveform',
            params: [
                { name: 'vol', control: 'knob', label: 'Vol' },
                { name: 'attack', control: 'knob', label: 'Attack' },
                { name: 'decay', control: 'knob', label: 'Decay' },
                { name: 'sustain', control: 'knob', label: 'Sustain' },
                { name: 'release', control: 'knob', label: 'Release' },
            ],
        },
        {
            id: 'settings',
            label: 'Settings',
            params: [
                { name: 'transpose', control: 'fader', label: 'Transpose', faderMin: -24, faderMax: 24 },
                { name: 'root', control: 'knob', label: 'Root' },
                { name: 'cutoff', control: 'knob', label: 'Cutoff' },
                { name: 'res', control: 'knob', label: 'Resonance' },
            ],
        },
    ],
};

/* ─────────────────────────────────────────────────────────────
   MANIFEST REGISTRY
   Maps pluginId → PluginPageManifest.
   Plugins NOT in this map render all params in a single knob grid.
   ───────────────────────────────────────────────────────────── */

export const INTERNAL_PLUGIN_PAGE_MANIFESTS: Record<string, PluginPageManifest> = {
    'internal://instrument/sampler': SAMPLER_PAGE_MANIFEST,
};

/**
 * Resolve the page manifest for a given plugin ID.
 * Returns null if the plugin has no multi-page layout defined.
 */
export function resolvePluginPageManifest(pluginId: string): PluginPageManifest | null {
    return INTERNAL_PLUGIN_PAGE_MANIFESTS[pluginId] ?? null;
}
