import { useState } from 'react';

/**
 * AssetBrowser — Left sidebar for browsing audio assets.
 * 
 * Tabs: Samples | Instruments | Audio FX
 * Uses panel-tabs from glass.css (transplanted from .studio-tab).
 * 
 * Each item shows:
 *   [icon] File Name
 *          metadata (type • format)
 */

type Tab = 'samples' | 'instruments' | 'fx';

interface AssetItem {
    name: string;
    type: string;
    meta: string;
}

const MOCK_SAMPLES: AssetItem[] = [
    { name: 'Kick_808_Deep.wav', type: 'One Shot', meta: '24bit • 44.1k' },
    { name: 'Snare_Tight_02.wav', type: 'One Shot', meta: '24bit • 44.1k' },
    { name: 'HiHat_Closed_01.wav', type: 'One Shot', meta: '16bit • 44.1k' },
    { name: 'Clap_Vinyl.wav', type: 'One Shot', meta: '24bit • 48k' },
    { name: 'Bass_Sub_C2.wav', type: 'Loop', meta: '128 BPM • 4 bars' },
    { name: 'Pad_Ambient_Dm.wav', type: 'Loop', meta: '90 BPM • 8 bars' },
    { name: 'Vocal_Chop_Rise.wav', type: 'One Shot', meta: '24bit • 44.1k' },
    { name: 'FX_Riser_04.wav', type: 'FX', meta: '24bit • 48k' },
    { name: 'Perc_Shaker_Loop.wav', type: 'Loop', meta: '120 BPM • 2 bars' },
    { name: 'Synth_Lead_Am7.wav', type: 'Loop', meta: '140 BPM • 4 bars' },
    { name: 'Kick_Acoustic_01.wav', type: 'One Shot', meta: '24bit • 96k' },
    { name: 'Tom_Low_Room.wav', type: 'One Shot', meta: '24bit • 48k' },
];

const MOCK_INSTRUMENTS: AssetItem[] = [
    { name: 'Grand Piano', type: 'Sampler', meta: '1.2 GB' },
    { name: 'Analog Bass', type: 'Synth', meta: 'Subtractor' },
    { name: 'Electric Keys', type: 'Sampler', meta: '450 MB' },
    { name: 'String Ensemble', type: 'Sampler', meta: '2.1 GB' },
    { name: 'FM Bell', type: 'Synth', meta: 'Operator' },
    { name: 'Wavetable Pad', type: 'Synth', meta: 'Serum' },
];

const MOCK_FX: AssetItem[] = [
    { name: 'Parametric EQ', type: 'Equalizer', meta: 'Native' },
    { name: 'Opto Compressor', type: 'Dynamics', meta: 'Native' },
    { name: 'Plate Reverb', type: 'Reverb', meta: 'Native' },
    { name: 'Tape Delay', type: 'Delay', meta: 'Native' },
    { name: 'SSL Bus Comp', type: 'Dynamics', meta: 'Waves' },
    { name: 'Limiter', type: 'Dynamics', meta: 'Native' },
    { name: 'Chorus Ensemble', type: 'Modulation', meta: 'Native' },
];

const TAB_DATA: Record<Tab, { items: AssetItem[], icon: string }> = {
    samples: { items: MOCK_SAMPLES, icon: '♪' },
    instruments: { items: MOCK_INSTRUMENTS, icon: '🎹' },
    fx: { items: MOCK_FX, icon: '◈' },
};

export const AssetBrowser = () => {
    const [activeTab, setActiveTab] = useState<Tab>('samples');
    const [searchQuery, setSearchQuery] = useState('');

    const currentItems = TAB_DATA[activeTab].items.filter(item =>
        item.name.toLowerCase().includes(searchQuery.toLowerCase())
    );

    return (
        <div className="flex flex-col h-full">

            {/* ── Search ── */}
            <div className="h-11 flex items-center px-3 border-b border-border-subtle shrink-0">
                <div className="relative w-full">
                    <svg
                        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
                        width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    >
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                        type="text"
                        placeholder="Search..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full bg-bg-input border border-border-subtle rounded-md pl-8 pr-2 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent transition-colors"
                    />
                </div>
            </div>

            {/* ── Tabs ── */}
            <div className="panel-tabs shrink-0">
                {(Object.keys(TAB_DATA) as Tab[]).map(tab => (
                    <button
                        key={tab}
                        className={`panel-tab ${activeTab === tab ? 'active' : ''}`}
                        onClick={() => setActiveTab(tab)}
                    >
                        <span>{TAB_DATA[tab].icon}</span>
                        <span className="capitalize">{tab}</span>
                    </button>
                ))}
            </div>

            {/* ── Item List ── */}
            <div className="flex-1 overflow-y-auto py-1">
                {currentItems.map((item, i) => (
                    <div
                        key={`${item.name}-${i}`}
                        className="flex items-center gap-3 mx-1.5 px-2.5 py-2 rounded-lg hover:bg-bg-hover cursor-pointer group transition-colors"
                    >
                        {/* Waveform Icon */}
                        <div className="w-8 h-8 rounded-md bg-bg-elevated border border-border-subtle flex items-center justify-center text-text-tertiary group-hover:border-text-secondary group-hover:text-text-secondary transition-colors shrink-0">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M12 3v18M8 7v10M4 10v4M16 7v10M20 10v4" />
                            </svg>
                        </div>
                        <div className="flex flex-col min-w-0">
                            <span className="text-sm text-text-secondary group-hover:text-text-primary truncate transition-colors">
                                {item.name}
                            </span>
                            <span className="text-[10px] text-text-tertiary">
                                {item.type} • {item.meta}
                            </span>
                        </div>
                    </div>
                ))}
            </div>

            {/* ── Footer Status ── */}
            <div className="h-7 flex items-center px-3 border-t border-border-subtle text-[10px] text-text-tertiary font-mono shrink-0">
                {currentItems.length} items
            </div>
        </div>
    );
};
