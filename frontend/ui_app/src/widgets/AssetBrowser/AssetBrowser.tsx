import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { AudioFileEntry } from '@/shared/api/engine';

/**
 * AssetBrowser — Ableton-style two-pane vertical-split sidebar browser.
 *
 * Ported from BrowserSidebarView.swift (1639 lines).
 *
 * Layout (LEFT panel | RIGHT panel):
 *   ┌──────────────────────────────────────────┐
 *   │ 🔎 Search (Cmd+F)                        │
 *   ├────────────┬─────────────────────────────┤
 *   │ COLLECTIONS│ Source: All   Format: All   │
 *   │  ★ Fav…    │ Audio: All                  │
 *   │           │──────────────────────────────│
 *   │ LIBRARY    │  Kick_808_Deep.wav          │
 *   │  ≡ All     │  Snare_Tight_02.wav         │
 *   │  ♫ Samples │  HiHat_Closed_01.wav        │
 *   │  ♪ Sounds  │  Clap_Vinyl.wav             │
 *   │  ▪ Drums   │  Bass_Sub_02.wav            │
 *   │  🎹 Instr… │  Pad_Ambient_Dm.wav         │
 *   │  ✦ Audio…  │  Vocal_Chop_Rise.wav        │
 *   │  🧩 Plug…  │  ...                        │
 *   │  🎬 Clips  │                             │
 *   │  📄 Templ… │                             │
 *   │           │                             │
 *   │ PLACES     │                             │
 *   │  👤 User…  │                             │
 *   │  📋 Curr…  │                             │
 *   │  ＋ Add…   │                             │
 *   ├────────────┴─────────────────────────────┤
 *   │ 12 items          🎧 Preview             │
 *   └──────────────────────────────────────────┘
 *
 * The split mirrors Ableton Live's browser exactly:
 * - Left pane: category tree (Collections, Library, Places)
 * - Right pane: filter toolbar + scrollable file list
 */

// ── Types ──────────────────────────────────────────────────

interface BrowserCategory {
    id: string;
    title: string;
    icon: string;
    kind: 'section' | 'leaf';
}

interface BrowserItem {
    id: string;
    name: string;
    type: 'audio' | 'instrument' | 'audioEffect' | 'midiEffect' | 'plugin';
    format?: string;
    meta?: string;
    favorite?: boolean;
    /** Absolute path to file on disk (for drag-and-drop import). */
    path?: string;
}

// ── Static Data (matching BrowserSidebarView.swift) ────────

const CATEGORIES: BrowserCategory[] = [
    { id: 'sec-collections', title: 'Collections', icon: '★', kind: 'section' },
    { id: 'favorites', title: 'Favorites', icon: '★', kind: 'leaf' },

    { id: 'sec-library', title: 'Library', icon: '📁', kind: 'section' },
    { id: 'all', title: 'All', icon: '≡', kind: 'leaf' },
    { id: 'samples', title: 'Samples', icon: '♫', kind: 'leaf' },
    { id: 'sounds', title: 'Sounds', icon: '♪', kind: 'leaf' },
    { id: 'drums', title: 'Drums', icon: '▪', kind: 'leaf' },
    { id: 'instruments', title: 'Instruments', icon: '🎹', kind: 'leaf' },
    { id: 'audioEffects', title: 'Audio E…', icon: '✦', kind: 'leaf' },
    { id: 'midiEffects', title: 'MIDI Ef…', icon: '✧', kind: 'leaf' },
    { id: 'maxForLive', title: 'Max for…', icon: '∞', kind: 'leaf' },
    { id: 'plugins', title: 'Plug-Ins', icon: '🧩', kind: 'leaf' },
    { id: 'clips', title: 'Clips', icon: '🎬', kind: 'leaf' },
    { id: 'grooves', title: 'Grooves', icon: '∿', kind: 'leaf' },
    { id: 'templates', title: 'Templa…', icon: '📄', kind: 'leaf' },

    { id: 'sec-places', title: 'Places', icon: '💾', kind: 'section' },
    { id: 'packs', title: 'Packs', icon: '📦', kind: 'leaf' },
    { id: 'userLibrary', title: 'User Li…', icon: '👤', kind: 'leaf' },
    { id: 'currentProject', title: 'Current…', icon: '📋', kind: 'leaf' },
    { id: 'addFolder', title: 'Add Fol…', icon: '＋', kind: 'leaf' },
];

// Demo browser items
const DEMO_SAMPLES: BrowserItem[] = [
    { id: '1', name: 'Kick_808_Deep.wav', type: 'audio', format: 'WAV', meta: 'One Shot · 24bit · 44k' },
    { id: '2', name: 'Snare_Tight_02.wav', type: 'audio', format: 'WAV', meta: 'One Shot · 24bit · 44k' },
    { id: '3', name: 'HiHat_Closed_01.wav', type: 'audio', format: 'WAV', meta: 'One Shot · 16bit · 44k' },
    { id: '4', name: 'Clap_Vinyl.wav', type: 'audio', format: 'WAV', meta: 'One Shot · 24bit · 48k' },
    { id: '5', name: 'Bass_Sub_02.wav', type: 'audio', format: 'WAV', meta: 'Loop · 130 BPM · 4 bars' },
    { id: '6', name: 'Pad_Ambient_Dm.wav', type: 'audio', format: 'WAV', meta: 'Loop · 80 BPM · 8 bars' },
    { id: '7', name: 'Vocal_Chop_Rise.wav', type: 'audio', format: 'WAV', meta: 'One Shot · 24bit · 44k' },
    { id: '8', name: 'FX_Riser_04.wav', type: 'audio', format: 'WAV', meta: 'FX · 4 bars · 44k' },
    { id: '9', name: 'Perc_Shaker_Loop.wav', type: 'audio', format: 'WAV', meta: 'Loop · 130 BPM · 2 bars' },
    { id: '10', name: 'Synth_Lead_Am7.wav', type: 'audio', format: 'WAV', meta: 'Loop · 140 BPM · 4 bars' },
    { id: '11', name: 'Kick_Acoustic_01.wav', type: 'audio', format: 'WAV', meta: 'One Shot · 24bit · 48k' },
    { id: '12', name: 'Tom_Low_Room.wav', type: 'audio', format: 'WAV', meta: 'One Shot · 24bit · 48k' },
    { id: '13', name: 'BASS BUZZ ★★…', type: 'audio', format: 'WAV', meta: 'Loop · 174 BPM' },
    { id: '14', name: 'BASS BUZZ ★…', type: 'audio', format: 'WAV', meta: 'Loop · 174 BPM' },
    { id: '15', name: 'BREAK.wav', type: 'audio', format: 'WAV', meta: 'One Shot · 24bit' },
    { id: '16', name: 'Drums BUZZ.wav', type: 'audio', format: 'WAV', meta: 'Loop · 174 BPM' },
    { id: '17', name: 'Fill 174 BPM - 1.wav', type: 'audio', format: 'WAV', meta: 'Loop · 174 BPM' },
    { id: '18', name: 'FX Noise.wav', type: 'audio', format: 'WAV', meta: 'FX · 24bit' },
    { id: '19', name: 'FX-1.wav', type: 'audio', format: 'WAV', meta: 'FX · 24bit' },
    { id: '20', name: 'FX.wav', type: 'audio', format: 'WAV', meta: 'FX · 24bit' },
    { id: '21', name: 'HAT.wav', type: 'audio', format: 'WAV', meta: 'One Shot · 24bit' },
    { id: '22', name: 'INTRO SYNTH.wav', type: 'audio', format: 'WAV', meta: 'Loop · 174 BPM' },
    { id: '23', name: 'KICK.wav', type: 'audio', format: 'WAV', meta: 'One Shot · 24bit' },
    { id: '24', name: 'MISC BUZZ.wav', type: 'audio', format: 'WAV', meta: 'Loop · 174 BPM' },
    { id: '25', name: 'MISC BUZZ ★★…', type: 'audio', format: 'WAV', meta: 'Loop · 174 BPM' },
    { id: '26', name: 'OPEN HAT.wav', type: 'audio', format: 'WAV', meta: 'One Shot · 24bit' },
    { id: '27', name: 'PLuCK-1.wav', type: 'audio', format: 'WAV', meta: 'Loop · 174 BPM' },
    { id: '28', name: 'PLuCK.wav', type: 'audio', format: 'WAV', meta: 'Loop · 174 BPM' },
    { id: '29', name: 'SD.wav', type: 'audio', format: 'WAV', meta: 'One Shot · 24bit' },
    { id: '30', name: 'VOC 1.wav', type: 'audio', format: 'WAV', meta: 'Vocal · 24bit' },
    { id: '31', name: 'VOC 2.wav', type: 'audio', format: 'WAV', meta: 'Vocal · 24bit' },
    { id: '32', name: 'VOC 3.wav', type: 'audio', format: 'WAV', meta: 'Vocal · 24bit' },
    { id: '33', name: 'VOC FX.wav', type: 'audio', format: 'WAV', meta: 'Vocal FX · 24bit' },
];

const DEMO_INSTRUMENTS: BrowserItem[] = [
    { id: 'i1', name: 'Sampler', type: 'instrument', meta: 'Built-in' },
    { id: 'i2', name: 'Simple Sine Synth', type: 'instrument', meta: 'Built-in' },
];

const DEMO_FX: BrowserItem[] = [
    { id: 'fx1', name: 'EQ Eight', type: 'audioEffect', meta: 'Built-in' },
    { id: 'fx2', name: 'Compressor', type: 'audioEffect', meta: 'Built-in' },
    { id: 'fx3', name: 'Delay', type: 'audioEffect', meta: 'Built-in' },
    { id: 'fx4', name: 'Reverb', type: 'audioEffect', meta: 'Built-in' },
    { id: 'fx5', name: 'Utility', type: 'audioEffect', meta: 'Built-in' },
    { id: 'fx6', name: 'Plate Reverb', type: 'audioEffect', meta: 'Built-in' },
];

const SOURCE_FILTERS = ['Source: All', 'Source: Library', 'Source: Samples', 'Source: Plug-ins'] as const;
const FORMAT_FILTERS = ['Format: All', 'WAV', 'AIFF', 'MP3', 'FLAC'] as const;
const AUDIO_FILTERS = ['Audio: All', 'Loops', 'One Shot', 'Drums', 'Vocals'] as const;

// ── Component ──────────────────────────────────────────

export const AssetBrowser = () => {
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedCategoryId, setSelectedCategoryId] = useState('samples');
    const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
    const [sourceFilter, setSourceFilter] = useState(0);
    const [formatFilter, setFormatFilter] = useState(0);
    const [audioFilter, setAudioFilter] = useState(0);
    const [previewEnabled, setPreviewEnabled] = useState(true);
    const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

    const searchRef = useRef<HTMLInputElement>(null);

    // Keyboard shortcut
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                searchRef.current?.focus();
                searchRef.current?.select();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, []);

    const toggleSection = useCallback((id: string) => {
        setCollapsedSections(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    // ── Real file scanning (LAZY — only triggers when user views samples) ──
    const [realFiles, setRealFiles] = useState<AudioFileEntry[]>([]);
    const [scanLoading, setScanLoading] = useState(false);
    const [scanError, setScanError] = useState<string | null>(null);
    const scanTriggeredRef = useRef(false);

    // Only scan when user navigates to a samples-related category
    const isSamplesCategory = ['samples', 'all', 'sounds', 'drums', 'clips'].includes(selectedCategoryId);

    useEffect(() => {
        if (!isSamplesCategory || scanTriggeredRef.current) return;
        scanTriggeredRef.current = true;

        let cancelled = false;

        // Defer IPC briefly to avoid blocking initial render
        // Note: requestIdleCallback is NOT available in WKWebView (Tauri/Safari)
        const timerId = setTimeout(() => {
            if (cancelled) return;
            setScanLoading(true);
            setScanError(null);

            // Chain: get path → scan folder
            engineApi.getSamplesPath()
                .then(path => {
                    if (cancelled) return Promise.reject('cancelled');
                    return engineApi.scanAudioFolder(path);
                })
                .then(files => {
                    if (!cancelled) {
                        setRealFiles(files);
                        setScanLoading(false);
                    }
                })
                .catch(err => {
                    if (!cancelled && err !== 'cancelled') {
                        console.warn('[AssetBrowser] Scan failed:', err);
                        setScanError(String(err));
                        setScanLoading(false);
                    }
                });
        }, 500);

        return () => {
            cancelled = true;
            clearTimeout(timerId);
        };
    }, [isSamplesCategory]);

    // Convert real file entries to BrowserItems
    const realBrowserItems: BrowserItem[] = useMemo(() => {
        return realFiles.map((f, i) => {
            const sizeKb = Math.round(f.size_bytes / 1024);
            const sizeMb = (f.size_bytes / (1024 * 1024)).toFixed(1);
            const sizeLabel = sizeKb > 1024 ? `${sizeMb} MB` : `${sizeKb} KB`;
            return {
                id: `real-${i}`,
                name: f.name,
                type: 'audio' as const,
                format: f.format,
                meta: sizeLabel,
                path: f.path,
            };
        });
    }, [realFiles]);

    // Get items based on selected category
    const items = useMemo(() => {
        let base: BrowserItem[] = [];
        switch (selectedCategoryId) {
            case 'samples':
            case 'all':
            case 'sounds':
            case 'drums':
            case 'clips':
                // Use real files if available, otherwise fall back to demo
                base = realBrowserItems.length > 0 ? realBrowserItems : DEMO_SAMPLES;
                break;
            case 'instruments':
                base = DEMO_INSTRUMENTS;
                break;
            case 'audioEffects':
            case 'midiEffects':
            case 'maxForLive':
                base = DEMO_FX;
                break;
            case 'favorites':
                base = [...(realBrowserItems.length > 0 ? realBrowserItems : DEMO_SAMPLES), ...DEMO_INSTRUMENTS].filter(i => i.favorite);
                break;
            default:
                base = realBrowserItems.length > 0 ? realBrowserItems : DEMO_SAMPLES;
        }

        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            base = base.filter(i => i.name.toLowerCase().includes(q));
        }

        return base;
    }, [selectedCategoryId, searchQuery, realBrowserItems]);

    // Track current section for collapse logic
    let currentSection: string | null = null;

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            background: 'var(--color-bg-panel)',
            fontSize: 'var(--font-size-xs)',
        }}>

            {/* ── Search ────────── */}
            <div style={{
                padding: '6px 8px',
                borderBottom: '1px solid var(--color-divider)',
                background: 'var(--color-bg-header)',
            }}>
                <input
                    ref={searchRef}
                    type="text"
                    placeholder="Search… (⌘F)"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    style={{
                        width: '100%',
                        padding: '4px 8px',
                        background: 'var(--color-bg-input)',
                        color: 'var(--color-text-primary)',
                        border: '1px solid var(--color-border-subtle)',
                        borderRadius: 'var(--radius-xs)',
                        fontSize: 'var(--font-size-xs)',
                        fontFamily: 'var(--font-mono)',
                        outline: 'none',
                    }}
                />
            </div>

            {/* ══════════════════════════════════════════════
                TWO-PANE VERTICAL SPLIT (Ableton-style)
                Left: Category tree | Right: Filter + file list
               ══════════════════════════════════════════════ */}
            <div style={{
                flex: 1,
                display: 'flex',
                overflow: 'hidden',
            }}>
                {/* ── LEFT PANE: Category Tree ── */}
                <div
                    className="scrollbar-hide"
                    style={{
                        width: 95,
                        minWidth: 85,
                        flexShrink: 0,
                        overflowY: 'auto',
                        borderRight: '1px solid var(--color-divider)',
                        background: 'var(--color-bg-panel)',
                    }}
                >
                    {CATEGORIES.map(cat => {
                        // Section header
                        if (cat.kind === 'section') {
                            const collapsed = collapsedSections.has(cat.id);
                            currentSection = cat.id;
                            return (
                                <button
                                    key={cat.id}
                                    onClick={() => toggleSection(cat.id)}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 3,
                                        width: '100%',
                                        padding: '5px 6px 3px',
                                        background: 'none',
                                        border: 'none',
                                        color: 'var(--color-text-secondary)',
                                        fontSize: 9,
                                        fontWeight: 700,
                                        textTransform: 'uppercase',
                                        letterSpacing: '0.04em',
                                        cursor: 'pointer',
                                    }}
                                >
                                    <span style={{
                                        fontSize: 7,
                                        transform: collapsed ? 'rotate(-90deg)' : 'rotate(0)',
                                        transition: 'transform 0.15s',
                                    }}>▼</span>
                                    {cat.title}
                                </button>
                            );
                        }

                        // Leaf item — hidden if parent section collapsed
                        const parentSectionId = currentSection;
                        if (parentSectionId && collapsedSections.has(parentSectionId)) return null;

                        const isSelected = selectedCategoryId === cat.id;
                        return (
                            <button
                                key={cat.id}
                                onClick={() => setSelectedCategoryId(cat.id)}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 4,
                                    width: '100%',
                                    padding: '2px 4px 2px 12px',
                                    background: isSelected ? 'var(--color-bg-selected)' : 'transparent',
                                    border: 'none',
                                    color: isSelected ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                                    fontSize: 10,
                                    textAlign: 'left',
                                    cursor: 'pointer',
                                    transition: 'background var(--transition-fast)',
                                    lineHeight: 1.6,
                                }}
                            >
                                <span style={{ width: 13, textAlign: 'center', fontSize: 10, flexShrink: 0 }}>{cat.icon}</span>
                                <span style={{
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                }}>{cat.title}</span>
                            </button>
                        );
                    })}
                </div>

                {/* ── RIGHT PANE: Filters + File List ── */}
                <div style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    background: 'var(--color-bg-secondary)',
                }}>
                    {/* Filters Toolbar */}
                    <div style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 4,
                        padding: '4px 6px',
                        borderBottom: '1px solid var(--color-divider)',
                        background: 'var(--color-bg-header)',
                    }}>
                        <FilterPill
                            options={SOURCE_FILTERS as unknown as string[]}
                            value={sourceFilter}
                            onChange={setSourceFilter}
                        />
                        <FilterPill
                            options={FORMAT_FILTERS as unknown as string[]}
                            value={formatFilter}
                            onChange={setFormatFilter}
                        />
                        <FilterPill
                            options={AUDIO_FILTERS as unknown as string[]}
                            value={audioFilter}
                            onChange={setAudioFilter}
                        />
                    </div>

                    {/* File List */}
                    <div className="scrollbar-hide" style={{
                        flex: 1,
                        overflowY: 'auto',
                        overflowX: 'hidden',
                    }}>
                        {/* Scan Status */}
                        {scanLoading && (
                            <div style={{
                                padding: '12px 10px',
                                textAlign: 'center',
                                color: 'var(--color-text-tertiary)',
                                fontSize: 10,
                                animation: 'pulse 1.5s ease-in-out infinite',
                            }}>
                                ⏳ Scanning samples folder…
                            </div>
                        )}
                        {scanError && !scanLoading && (
                            <div style={{
                                padding: '8px 10px',
                                color: 'var(--color-error, #ff6b6b)',
                                fontSize: 10,
                                lineHeight: 1.4,
                            }}>
                                ⚠️ Could not scan folder<br />
                                <span style={{ opacity: 0.7, fontFamily: 'var(--font-mono)', fontSize: 9 }}>{scanError}</span>
                            </div>
                        )}
                        {items.map(item => {
                            const isSelected = selectedItemId === item.id;
                            const isAudio = item.type === 'audio';
                            return (
                                <div
                                    key={item.id}
                                    draggable={isAudio}
                                    onClick={() => setSelectedItemId(item.id)}
                                    onDragStart={(e) => {
                                        if (!isAudio) return;
                                        // Mark as in-app drag so DawShell doesn't show Tauri overlay
                                        (window as any).__dreamInAppDrag = true;
                                        // Set drag data for Timeline drop zone
                                        e.dataTransfer.effectAllowed = 'copy';
                                        e.dataTransfer.setData('application/x-dream-browser-item', JSON.stringify({
                                            id: item.id,
                                            name: item.name,
                                            type: item.type,
                                            path: item.path || '',
                                        }));
                                        e.dataTransfer.setData('text/plain', item.name);

                                        // Custom drag ghost
                                        const ghost = document.createElement('div');
                                        ghost.textContent = `🎵 ${item.name}`;
                                        ghost.style.cssText = `
                                            position: fixed; top: -100px; left: -100px;
                                            padding: 4px 10px; border-radius: 4px;
                                            background: var(--color-accent-primary);
                                            color: #fff; font-size: 11px; font-weight: 600;
                                            font-family: var(--font-mono);
                                            white-space: nowrap; pointer-events: none;
                                            box-shadow: 0 4px 12px rgba(0,0,0,0.4);
                                        `;
                                        document.body.appendChild(ghost);
                                        e.dataTransfer.setDragImage(ghost, 0, 0);
                                        requestAnimationFrame(() => document.body.removeChild(ghost));
                                    }}
                                    onDragEnd={() => {
                                        (window as any).__dreamInAppDrag = false;
                                    }}
                                    style={{
                                        display: 'flex',
                                        flexDirection: 'column',
                                        padding: '2px 6px',
                                        cursor: isAudio ? 'grab' : 'default',
                                        background: isSelected ? 'var(--color-bg-selected)' : 'transparent',
                                        borderBottom: '1px solid var(--color-divider-light)',
                                        transition: 'background var(--transition-fast)',
                                    }}
                                >
                                    <div style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 5,
                                    }}>
                                        <TypeDot type={item.type} />
                                        <span style={{
                                            color: 'var(--color-text-primary)',
                                            fontSize: 10,
                                            fontWeight: 400,
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                        }}>
                                            {item.name}
                                        </span>
                                    </div>
                                    {item.meta && (
                                        <span style={{
                                            color: 'var(--color-text-tertiary)',
                                            fontSize: 9,
                                            paddingLeft: 14,
                                        }}>
                                            {item.meta}
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>

            {/* ── Footer: Count + Preview ────────── */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '4px 8px',
                borderTop: '1px solid var(--color-divider)',
                background: 'var(--color-bg-header)',
                fontSize: 'var(--font-size-2xs)',
                color: 'var(--color-text-tertiary)',
            }}>
                <span>{items.length} items</span>

                <button
                    onClick={() => setPreviewEnabled(!previewEnabled)}
                    title="Toggle Preview"
                    style={{
                        background: previewEnabled ? 'var(--color-accent-primary-dim)' : 'transparent',
                        border: 'none',
                        color: previewEnabled ? 'var(--color-accent-primary)' : 'var(--color-text-tertiary)',
                        borderRadius: 'var(--radius-xs)',
                        padding: '2px 6px',
                        cursor: 'pointer',
                        fontSize: 'var(--font-size-2xs)',
                    }}
                >
                    🎧 Preview
                </button>
            </div>
        </div>
    );
};

// ── Sub-components ──────────────────────────────────────

const TypeDot = ({ type }: { type: BrowserItem['type'] }) => {
    const colorMap: Record<string, string> = {
        audio: 'var(--color-browser-audio)',
        instrument: 'var(--color-browser-midi)',
        audioEffect: 'var(--color-browser-plugin)',
        midiEffect: 'var(--color-browser-preset)',
        plugin: 'var(--color-browser-plugin)',
    };
    return (
        <span style={{
            width: 5, height: 5,
            borderRadius: '50%',
            background: colorMap[type] || 'var(--color-text-tertiary)',
            flexShrink: 0,
        }} />
    );
};

const FilterPill = ({
    options, value, onChange,
}: {
    options: string[];
    value: number;
    onChange: (v: number) => void;
}) => (
    <button
        onClick={() => onChange((value + 1) % options.length)}
        style={{
            background: value > 0 ? 'var(--color-accent-primary-dim)' : 'var(--color-control-bg)',
            color: value > 0 ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)',
            border: 'none',
            borderRadius: 'var(--radius-xs)',
            padding: '2px 5px',
            fontSize: 9,
            cursor: 'pointer',
            fontWeight: 500,
            whiteSpace: 'nowrap',
        }}
    >
        {options[value]}
    </button>
);
