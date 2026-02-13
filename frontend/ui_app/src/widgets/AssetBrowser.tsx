import React, { useState } from 'react';
import { Layers, Box, Music, Search } from 'lucide-react';

export const AssetBrowser = () => {
    const [activeTab, setActiveTab] = useState('samples');

    return (
        <div className="studio-left pointer-events-auto flex flex-col h-full border-r border-[var(--color-border-subtle)] bg-[var(--color-bg-panel-adjacent)] backdrop-blur-[var(--glass-blur)]">
            {/* Search Header */}
            <div className="h-[var(--layout-header-height)] flex items-center px-4 border-b border-[var(--color-border-subtle)]">
                <div className="relative w-full">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]" size={14} />
                    <input
                        type="text"
                        placeholder="Search assets..."
                        className="w-full bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)] rounded-md pl-8 pr-2 py-1.5 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-accent-primary)] transition-colors"
                    />
                </div>
            </div>

            {/* Tabs */}
            <div className="studio-tabs">
                <button
                    className={`studio-tab ${activeTab === 'samples' ? 'active' : ''}`}
                    onClick={() => setActiveTab('samples')}
                >
                    <Music size={16} />
                </button>
                <button
                    className={`studio-tab ${activeTab === 'plugins' ? 'active' : ''}`}
                    onClick={() => setActiveTab('plugins')}
                >
                    <Box size={16} />
                </button>
                <button
                    className={`studio-tab ${activeTab === 'tracks' ? 'active' : ''}`}
                    onClick={() => setActiveTab('tracks')}
                >
                    <Layers size={16} />
                </button>
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-y-auto p-2">
                {/* Placeholder Items */}
                {Array.from({ length: 15 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-3 p-2 rounded-md hover:bg-[var(--color-bg-hover)] cursor-pointer group transition-colors">
                        <div className="w-8 h-8 rounded bg-[var(--color-bg-elevated)] border border-[var(--color-border-subtle)] flex items-center justify-center text-[var(--color-text-tertiary)] group-hover:border-[var(--color-text-secondary)]">
                            <Music size={14} />
                        </div>
                        <div className="flex flex-col">
                            <span className="text-sm text-[var(--color-text-secondary)] group-hover:text-[var(--color-text-primary)]">Kick_Deep_0{i + 1}.wav</span>
                            <span className="text-[10px] text-[var(--color-text-tertiary)]">One Shot • 24bit</span>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};
