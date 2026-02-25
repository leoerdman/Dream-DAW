import type { PeakPair } from '@/shared/api/engine';
import { safeStorage } from '@/shared/lib/safeStorage';

export type CollectionId = 'collection-red' | 'collection-yellow' | 'collection-green';
export type BrowserItemType = 'audio' | 'instrument' | 'audioEffect' | 'midiEffect' | 'plugin' | 'folder' | 'project' | 'preset' | 'other';
export type PluginSource = 'internal' | 'vst2' | 'vst3' | 'au' | 'clap' | 'external';
export type BrowserItemLike = {
    id: string;
    name: string;
    type: BrowserItemType;
    format?: string;
    meta?: string;
    path?: string;
    pluginSource?: PluginSource;
};

export const COLLECTION_IDS = ['collection-red', 'collection-yellow', 'collection-green'] as const;
export const COLLECTION_LABELS_DEFAULT: Record<CollectionId, string> = {
    'collection-red': 'Red',
    'collection-yellow': 'Yellow',
    'collection-green': 'Green',
};
export const COLLECTION_ICONS: Record<CollectionId, string> = {
    'collection-red': '🔴',
    'collection-yellow': '🟡',
    'collection-green': '🟢',
};

const COLLECTION_STORAGE_KEY = 'dream-daw-browser-collections';
const COLLECTION_LABELS_STORAGE_KEY = 'dream-daw-browser-collection-labels';

export function loadCollections(): Record<CollectionId, Set<string>> {
    try {
        const raw = safeStorage.getItem(COLLECTION_STORAGE_KEY);
        if (!raw) return { 'collection-red': new Set(), 'collection-yellow': new Set(), 'collection-green': new Set() };
        const parsed = JSON.parse(raw) as Record<string, string[]>;
        return {
            'collection-red': new Set(parsed['collection-red'] ?? []),
            'collection-yellow': new Set(parsed['collection-yellow'] ?? []),
            'collection-green': new Set(parsed['collection-green'] ?? []),
        };
    } catch {
        return { 'collection-red': new Set(), 'collection-yellow': new Set(), 'collection-green': new Set() };
    }
}

export function saveCollections(collections: Record<CollectionId, Set<string>>): void {
    const serializable: Record<string, string[]> = {};
    for (const id of COLLECTION_IDS) {
        serializable[id] = Array.from(collections[id]);
    }
    safeStorage.setItem(COLLECTION_STORAGE_KEY, JSON.stringify(serializable));
}

export function loadCollectionLabels(): Record<string, string> {
    try {
        const raw = safeStorage.getItem(COLLECTION_LABELS_STORAGE_KEY);
        if (!raw) return {
            'collection-red': 'Red',
            'collection-yellow': 'Yellow',
            'collection-green': 'Green',
        };
        return JSON.parse(raw) as Record<string, string>;
    } catch {
        return {
            'collection-red': 'Red',
            'collection-yellow': 'Yellow',
            'collection-green': 'Green',
        };
    }
}

export function saveCollectionLabels(labels: Record<string, string>): void {
    safeStorage.setItem(COLLECTION_LABELS_STORAGE_KEY, JSON.stringify(labels));
}

export function detectPluginSource(raw: string): PluginSource {
    const norm = raw.toLowerCase();
    if (norm.includes('internal://')) return 'internal';
    // BUG-93 FIX: check vst3 BEFORE vst2 to avoid false matches
    if (/\.vst3(?:\b|$)/.test(norm) || /\bvst3\b/.test(norm)) return 'vst3';
    if (/\.component(?:\b|$)/.test(norm) || /\baudio\s*unit\b/.test(norm)) return 'au';
    if (/\.clap(?:\b|$)/.test(norm) || /\bclap\b/.test(norm)) return 'clap';
    if (/\.vst(?:\b|$)/.test(norm) || /\bvst2?\b/.test(norm)) return 'vst2';
    return 'external';
}

export function isLikelyInstrumentPlugin(item: BrowserItemLike): boolean {
    const text = `${item.name} ${item.meta ?? ''} ${item.format ?? ''}`.toLowerCase();
    return /\b(synth|serum|piano|sampler|kontakt|instrument|organ|rompler|drum\s*machine|electric\s*piano|strings|brass|woodwind|choir)\b/.test(text);
}

export function isLikelyDrumAudio(item: BrowserItemLike): boolean {
    const text = item.name.toLowerCase();
    // BUG-92 FIX: removed standalone \bhat\b which matches 'chat', 'what', 'that'
    return /\b(kick|snare|clap|hihat|hi-hat|hi_hat|drum|perc|cymbal|tom|rim)\b/.test(text);
}

export function fileTypeToItemType(ft: string): BrowserItemType {
    switch (ft) {
        case 'audio': return 'audio';
        case 'plugin': return 'plugin';
        case 'project': return 'project';
        case 'preset': return 'preset';
        case 'folder': return 'folder';
        default: return 'other';
    }
}

export function selectBestPeakLevel(levels: { peaks: PeakPair[] }[]): PeakPair[] | null {
    // BUG-96 FIX: single pass, prefer highest LOD first, fallback to lowest
    for (let i = levels.length - 1; i >= 0; i -= 1) {
        const peaks = levels[i]?.peaks;
        if (peaks && peaks.length > 0) return peaks;
    }
    return null;
}

// BUG-30 FIX: cache compiled regex per search token
const regexCache = new Map<string, RegExp>();
function getCachedRegex(token: string): RegExp {
    let re = regexCache.get(token);
    if (!re) {
        if (regexCache.size > 200) regexCache.clear(); // prevent unbounded growth
        re = new RegExp(`(^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
        regexCache.set(token, re);
    }
    return re;
}

function singleTokenScore(t: string, token: string): number | null {
    if (t === token) return 0;
    if (t.startsWith(token)) return 1 + (t.length - token.length) * 0.02;

    const wordMatch = t.match(getCachedRegex(token));
    if (wordMatch) {
        const idx = wordMatch.index ?? 0;
        return 6 + idx * 0.2 + (t.length - token.length) * 0.02;
    }

    const idx = t.indexOf(token);
    if (idx >= 0) return 12 + idx * 0.35 + (t.length - token.length) * 0.03;

    let ti = 0;
    let qi = 0;
    let first = -1;
    let last = -1;
    while (ti < t.length && qi < token.length) {
        if (t[ti] === token[qi]) {
            if (first < 0) first = ti;
            last = ti;
            qi += 1;
        }
        ti += 1;
    }
    if (qi !== token.length) return null;
    const span = Math.max(1, last - first + 1);
    const gaps = span - token.length;
    return 40 + gaps * 1.8 + first * 0.3 + (t.length - token.length) * 0.04;
}

export function fuzzyScore(text: string, query: string): number | null {
    const t = text.toLowerCase();
    const q = query.toLowerCase().trim();
    if (!q) return 0;

    const tokens = q.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return 0;

    let totalScore = 0;
    for (const token of tokens) {
        const s = singleTokenScore(t, token);
        if (s === null) return null;
        totalScore += s;
    }
    return totalScore;
}
