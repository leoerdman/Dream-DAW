import React from 'react';
import { Sliders, X, Plus } from 'lucide-react';

export const PluginMixer = () => {
    return (
        <div className="h-full w-full flex flex-col">
            {/* Mixer Header */}
            <div className="h-10 border-b border-[var(--color-border-subtle)] flex items-center justify-between px-4 bg-[var(--color-bg-header)]">
                <div className="flex items-center gap-2">
                    <Sliders size={14} className="text-[var(--color-accent-primary)]" />
                    <span className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wide">Master Chain</span>
                </div>
                <div className="flex items-center gap-2">
                    <button className="p-1 hover:bg-[var(--color-bg-hover)] rounded text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]">
                        <Plus size={14} />
                    </button>
                </div>
            </div>

            {/* Chain View */}
            <div className="flex-1 overflow-x-auto p-4 flex items-center gap-4 bg-[var(--color-bg-panel-adjacent)]">

                {/* Plugin Node 1 */}
                <div className="w-[140px] h-[160px] bg-[var(--color-bg-node)] border border-[var(--color-border-default)] rounded-[var(--node-border-radius)] flex flex-col shadow-lg relative group">
                    <div className="h-8 border-b border-[var(--color-border-subtle)] flex items-center px-3 bg-[var(--color-bg-header)] rounded-t-[var(--node-border-radius)] justify-between">
                        <span className="text-xs font-medium text-[var(--color-text-primary)] truncate">EQ Eight</span>
                        <div className="w-2 h-2 rounded-full bg-[var(--color-accent-green)]" />
                    </div>
                    <div className="flex-1 p-2 flex items-center justify-center">
                        {/* Visualizer Placeholder */}
                        <div className="w-full h-full bg-[var(--color-bg-input)] rounded border border-[var(--color-border-subtle)] opacity-50" />
                    </div>
                </div>

                {/* Generic Plugin Node */}
                <div className="w-[140px] h-[160px] bg-[var(--color-bg-node)] border border-[var(--color-border-default)] rounded-[var(--node-border-radius)] flex flex-col shadow-lg relative group">
                    <div className="h-8 border-b border-[var(--color-border-subtle)] flex items-center px-3 bg-[var(--color-bg-header)] rounded-t-[var(--node-border-radius)] justify-between">
                        <span className="text-xs font-medium text-[var(--color-text-primary)] truncate">Compressor</span>
                        <div className="w-2 h-2 rounded-full bg-[var(--color-accent-green)]" />
                    </div>
                    <div className="flex-1 p-3 flex flex-col gap-2">
                        <div className="h-1 bg-[var(--color-bg-input)] rounded overflow-hidden">
                            <div className="h-full w-[60%] bg-[var(--color-accent-primary)]" />
                        </div>
                        <div className="h-1 bg-[var(--color-bg-input)] rounded overflow-hidden">
                            <div className="h-full w-[30%] bg-[var(--color-accent-primary)]" />
                        </div>
                    </div>
                </div>

                {/* Add New Slot */}
                <div className="w-[140px] h-[160px] border-2 border-dashed border-[var(--color-border-subtle)] rounded-[var(--node-border-radius)] flex flex-col items-center justify-center text-[var(--color-text-tertiary)] hover:border-[var(--color-text-secondary)] hover:text-[var(--color-text-secondary)] cursor-pointer transition-all">
                    <Plus size={24} />
                    <span className="text-xs font-medium mt-2">Add Plugin</span>
                </div>

            </div>
        </div>
    );
};
