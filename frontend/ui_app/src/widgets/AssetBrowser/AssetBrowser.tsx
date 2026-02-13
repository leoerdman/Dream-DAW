import { useState, useCallback, useMemo, useRef, useEffect } from 'react';

/**
 * AssetBrowser — Full Ableton-style sidebar browser.
 *
 * Ported from BrowserSidebarView.swift (1639 lines).
 *
 * Layout (top → bottom):
 *   1. Search field (Cmd+F)
 *   2. Collapsible Category tree (Collections / Library / Places sections)
 *   3. Filter toolbar (Source, Format, Audio)
 *   4. Results list with icons + metadata
 *   5. Preview bar with toggle + waveform placeholder
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
    { id: 'audioEffects', title: 'Audio Effects', icon: '✦', kind: 'leaf' },
    { id: 'plugins', title: 'Plug-Ins', icon: '🧩', kind: 'leaf' },
    { id: 'clips', title: 'Clips', icon: '🎬', kind: 'leaf' },
    { id: 'templates', title: 'Templates', icon: '📄', kind: 'leaf' },

    { id: 'sec-places', title: 'Places', icon: '💾', kind: 'section' },
    { id: 'userLibrary', title: 'User Library', icon: '👤', kind: 'leaf' },
    { id: 'currentProject', title: 'Current Project', icon: '📋', kind: 'leaf' },
    { id: 'addFolder', title: 'Add Folder…', icon: '＋', kind: 'leaf' },
];

// Demo browser items for the "Samples" category
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

    // Get items based on selected category
    const items = useMemo(() => {
        let base: BrowserItem[] = [];
        switch (selectedCategoryId) {
            case 'samples':
            case 'all':
            case 'sounds':
            case 'drums':
            case 'clips':
                base = DEMO_SAMPLES;
                break;
            case 'instruments':
                base = DEMO_INSTRUMENTS;
                break;
            case 'audioEffects':
                base = DEMO_FX;
                break;
            case 'favorites':
                base = [...DEMO_SAMPLES, ...DEMO_INSTRUMENTS].filter(i => i.favorite);
                break;
            default:
                base = DEMO_SAMPLES;
        }

        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            base = base.filter(i => i.name.toLowerCase().includes(q));
        }

        return base;
    }, [selectedCategoryId, searchQuery]);

    // Rendered sections
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

            {/* ── Category Tree ────────── */}
            <div className="scrollbar-hide" style={{
                flex: '0 0 auto',
                maxHeight: 190,
                overflowY: 'auto',
                borderBottom: '1px solid var(--color-divider)',
            }}>
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
                                    gap: 4,
                                    width: '100%',
                                    padding: '4px 8px',
                                    background: 'none',
                                    border: 'none',
                                    color: 'var(--color-text-secondary)',
                                    fontSize: 'var(--font-size-2xs)',
                                    fontWeight: 600,
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.05em',
                                    cursor: 'pointer',
                                }}
                            >
                                <span style={{ fontSize: 8, transform: collapsed ? 'rotate(-90deg)' : 'rotate(0)', transition: 'transform 0.15s' }}>▼</span>
                                {cat.icon} {cat.title}
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
                                gap: 6,
                                width: '100%',
                                padding: '3px 8px 3px 20px',
                                background: isSelected ? 'var(--color-bg-selected)' : 'transparent',
                                border: 'none',
                                color: isSelected ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                                fontSize: 'var(--font-size-xs)',
                                textAlign: 'left',
                                cursor: 'pointer',
                                transition: 'background var(--transition-fast)',
                            }}
                        >
                            <span style={{ width: 16, textAlign: 'center', fontSize: 11 }}>{cat.icon}</span>
                            {cat.title}
                        </button>
                    );
                })}
            </div>

            {/* ── Filters Toolbar ────────── */}
            <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 4,
                padding: '4px 8px',
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

            {/* ── Results List ────────── */}
            <div className="scrollbar-hide" style={{
                flex: 1,
                overflowY: 'auto',
                overflowX: 'hidden',
            }}>
                {items.map(item => {
                    const isSelected = selectedItemId === item.id;
                    return (
                        <div
                            key={item.id}
                            onClick={() => setSelectedItemId(item.id)}
                            style={{
                                display: 'flex',
                                flexDirection: 'column',
                                padding: '3px 8px',
                                cursor: 'default',
                                background: isSelected ? 'var(--color-bg-selected)' : 'transparent',
                                borderBottom: '1px solid var(--color-divider-light)',
                                transition: 'background var(--transition-fast)',
                            }}
                        >
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                            }}>
                                <TypeDot type={item.type} />
                                <span style={{
                                    color: 'var(--color-text-primary)',
                                    fontSize: 'var(--font-size-xs)',
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
                                    fontSize: 'var(--font-size-2xs)',
                                    paddingLeft: 18,
                                }}>
                                    {item.meta}
                                </span>
                            )}
                        </div>
                    );
                })}
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
            width: 6, height: 6,
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
            padding: '2px 6px',
            fontSize: 'var(--font-size-2xs)',
            cursor: 'pointer',
            fontWeight: 500,
            whiteSpace: 'nowrap',
        }}
    >
        {options[value]}
    </button>
);
