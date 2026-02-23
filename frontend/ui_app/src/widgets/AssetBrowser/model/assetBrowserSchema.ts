import {
    INTERNAL_EFFECT_PLUGINS,
    INTERNAL_INSTRUMENT_PLUGINS,
} from '@/shared/lib/internalPlugins';
import type { BrowserGlyphName } from '@/widgets/AssetBrowser/ui/AssetBrowserPrimitives';

export interface BrowserCategory {
    id: string;
    title: string;
    icon: BrowserGlyphName;
    kind: 'section' | 'leaf';
    markerColor?: string;
    folderPath?: string;
    removable?: boolean;
}

export interface BrowserItem {
    id: string;
    name: string;
    type: 'audio' | 'instrument' | 'audioEffect' | 'midiEffect' | 'plugin' | 'folder' | 'project' | 'preset' | 'other';
    format?: string;
    meta?: string;
    favorite?: boolean;
    path?: string;
    isDirectory?: boolean;
    slotHint?: 'instrument' | 'effect' | 'auto';
    durationSeconds?: number;
    sizeBytes?: number;
    pluginSource?: 'internal' | 'vst2' | 'vst3' | 'au' | 'external';
    _depth?: number;
    _expanded?: boolean;
    _loading?: boolean;
}

export type PluginGroupedRow =
    | { kind: 'header'; id: string; title: string; count: number }
    | { kind: 'item'; id: string; item: BrowserItem };

export const STATIC_CATEGORIES: BrowserCategory[] = [
    { id: 'sec-collections', title: 'Browser', icon: 'search', kind: 'section' },
    { id: 'collection-red', title: 'Collection', icon: 'star', markerColor: 'var(--token-color-hex-ef4444)', kind: 'leaf' },
    { id: 'collection-yellow', title: 'Collection', icon: 'star', markerColor: 'var(--token-color-hex-f59e0b)', kind: 'leaf' },
    { id: 'collection-green', title: 'Collection', icon: 'star', markerColor: 'var(--token-color-hex-22c55e)', kind: 'leaf' },
    { id: 'sec-library', title: 'Library', icon: 'folder-tree', kind: 'section' },
    { id: 'all', title: 'All', icon: 'grid', kind: 'leaf' },
    { id: 'samples', title: 'Samples', icon: 'wave-bars', kind: 'leaf' },
    { id: 'drums', title: 'Drums', icon: 'drum', kind: 'leaf' },
    { id: 'instruments', title: 'Instruments', icon: 'piano', kind: 'leaf' },
    { id: 'plugins', title: 'Plug-Ins', icon: 'plug', kind: 'leaf' },
    { id: 'audioEffects', title: 'Audio Eff…', icon: 'sliders', kind: 'leaf' },
];

export const SOURCE_FILTERS = ['Source: All', 'Source: Library', 'Source: Samples', 'Source: Plug-ins'] as const;
export const FORMAT_FILTERS = ['Format: All', 'WAV', 'AIFF', 'MP3', 'FLAC'] as const;
export const AUDIO_FILTERS = ['Audio: All', 'Loops', 'One Shot', 'Drums', 'Vocals'] as const;
export const SORT_FILTERS = ['Sort: Name ↑', 'Sort: Name ↓', 'Sort: Size ↑', 'Sort: Size ↓'] as const;
export const SIZE_FILTERS = ['Filter: All', '< 1 MB', '≥ 1 MB'] as const;

export const INTERNAL_INSTRUMENT_ITEMS: BrowserItem[] = INTERNAL_INSTRUMENT_PLUGINS.map((plugin) => ({
    id: `internal-inst-${plugin.name.toLowerCase().replace(/\s+/g, '-')}`,
    name: plugin.name,
    type: 'plugin',
    meta: `Internal Instrument ${plugin.tags.join(' ')}`,
    path: plugin.id,
    slotHint: plugin.slotHint,
    pluginSource: 'internal' as const,
}));

export const INTERNAL_EFFECT_ITEMS: BrowserItem[] = INTERNAL_EFFECT_PLUGINS.map((plugin) => ({
    id: `internal-fx-${plugin.name.toLowerCase().replace(/\s+/g, '-')}`,
    name: plugin.name,
    type: 'plugin',
    meta: `Internal Audio FX ${plugin.tags.join(' ')}`,
    path: plugin.id,
    slotHint: plugin.slotHint,
    pluginSource: 'internal' as const,
}));

export const PLUGIN_SOURCE_ORDER: Array<NonNullable<BrowserItem['pluginSource']>> = [
    'internal', 'vst3', 'vst2', 'au', 'external',
];

export const PLUGIN_SOURCE_LABEL: Record<NonNullable<BrowserItem['pluginSource']>, string> = {
    internal: 'Internal',
    vst3: 'VST3',
    vst2: 'VST2',
    au: 'Audio Unit',
    external: 'External',
};
