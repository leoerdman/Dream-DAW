import type { CSSProperties } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import * as engineApi from '@/shared/api/engine';

export type MissingClipItem = {
    clipId: string;
    clipName: string;
    trackName: string;
};

export type MissingPluginSlot = {
    trackId: string;
    trackName: string;
    slotId: string;
    displayName: string;
    pluginId: string;
    wantedName: string;
};

type ResolveCallbacks = {
    onResolveFile: (clipId: string, path: string, clipName: string) => Promise<void>;
    onReplacePlugin: (trackId: string, slotId: string, path: string, name: string, wantedName: string) => Promise<void>;
    onSetMessage: (message: string) => void;
};

export function MissingAudioSection({
    missingClips,
    onResolveFile,
}: {
    missingClips: MissingClipItem[];
    onResolveFile: ResolveCallbacks['onResolveFile'];
}) {
    return (
        <section style={sectionStyle}>
            <div style={sectionTitleStyle}>Missing Audio Files</div>
            {missingClips.length === 0 ? (
                <div style={emptyTextStyle}>No offline audio clips.</div>
            ) : missingClips.map((item) => (
                <div key={item.clipId} style={cardStyle}>
                    <div style={cardTitleStyle}>{item.clipName}</div>
                    <div style={cardSubTitleStyle}>{item.trackName}</div>
                    <div style={rowStyle}>
                        <button
                            onClick={async () => {
                                const picked = await open({
                                    multiple: false,
                                    title: `Replace missing file: ${item.clipName}`,
                                    filters: [{ name: 'Audio', extensions: ['wav', 'aif', 'aiff', 'flac', 'mp3', 'ogg', 'm4a', 'aac'] }],
                                });
                                const path = typeof picked === 'string' ? picked : null;
                                if (!path) return;
                                await onResolveFile(item.clipId, path, item.clipName);
                            }}
                            style={actionBtnStyle}
                        >
                            Replace File...
                        </button>
                        <button
                            onClick={() => {
                                window.dispatchEvent(new CustomEvent('dream:browser-set-search', {
                                    detail: { query: item.clipName, categoryId: 'samples' },
                                }));
                            }}
                            style={actionBtnStyle}
                        >
                            Find in Browser
                        </button>
                    </div>
                </div>
            ))}
        </section>
    );
}

export function MissingPluginsSection({
    missingPlugins,
    pluginEntries,
    scanBusy,
    onReplacePlugin,
}: {
    missingPlugins: MissingPluginSlot[];
    pluginEntries: engineApi.BrowserFileEntry[];
    scanBusy: boolean;
    onReplacePlugin: ResolveCallbacks['onReplacePlugin'];
}) {
    const normalize = (raw: string): string => raw.trim().toLowerCase();
    const compact = (raw: string): string => raw.toLowerCase().replace(/[^a-z0-9]/g, '');
    const scorePluginMatch = (wantedName: string, pluginName: string): number => {
        const w = normalize(wantedName);
        const p = normalize(pluginName);
        if (!w || !p) return 0;
        if (w === p) return 100;
        const wc = compact(w);
        const pc = compact(p);
        if (wc && wc === pc) return 95;
        if (p.startsWith(w) || w.startsWith(p)) return 80;
        if (pc && wc && (pc.includes(wc) || wc.includes(pc))) return 70;
        if (p.includes(w)) return 60;
        return 0;
    };

    return (
        <section style={sectionStyle}>
            <div style={sectionTitleStyle}>Missing Plugins</div>
            {missingPlugins.length === 0 ? (
                <div style={emptyTextStyle}>No missing plugin placeholders.</div>
            ) : missingPlugins.map((item) => {
                const matches = pluginEntries
                    .map((entry) => ({ entry, score: scorePluginMatch(item.wantedName, entry.name) }))
                    .filter((v) => v.score > 0)
                    .sort((a, b) => b.score - a.score)
                    .slice(0, 4)
                    .map((v) => v.entry);
                return (
                    <div key={item.slotId} style={cardStyle}>
                        <div style={cardTitleStyle}>{item.displayName}</div>
                        <div style={cardSubTitleStyle}>{item.trackName}</div>
                        <div style={{ ...cardSubTitleStyle, color: 'var(--color-text-secondary)' }}>Wanted: {item.wantedName}</div>

                        <div style={gridStyle}>
                            {matches.length > 0 ? matches.map((p) => (
                                <button
                                    key={`${item.slotId}:${p.path}`}
                                    onClick={() => onReplacePlugin(item.trackId, item.slotId, p.path, p.name, item.wantedName)}
                                    style={{ ...actionBtnStyle, justifyContent: 'space-between', width: '100%', display: 'flex' }}
                                >
                                    <span>{p.name}</span>
                                    <span style={{ opacity: 0.7 }}>Use</span>
                                </button>
                            )) : (
                                <div style={emptyTextStyle}>{scanBusy ? 'Scanning plugins...' : 'No close plugin match found'}</div>
                            )}
                        </div>

                        <div style={rowStyle}>
                            <button
                                onClick={async () => {
                                    const picked = await open({
                                        multiple: false,
                                        title: `Replace missing plugin: ${item.wantedName}`,
                                        filters: [{ name: 'Plugins', extensions: ['vst3', 'component', 'vst', 'dll'] }],
                                    });
                                    const path = typeof picked === 'string' ? picked : null;
                                    if (!path) return;
                                    await onReplacePlugin(item.trackId, item.slotId, path, '', item.wantedName);
                                }}
                                style={actionBtnStyle}
                            >
                                Pick Plugin...
                            </button>
                            <button
                                onClick={() => {
                                    window.dispatchEvent(new CustomEvent('dream:browser-set-search', {
                                        detail: { query: item.wantedName, categoryId: 'plugins' },
                                    }));
                                }}
                                style={actionBtnStyle}
                            >
                                Find in Browser
                            </button>
                        </div>
                    </div>
                );
            })}
        </section>
    );
}

const sectionStyle: CSSProperties = { display: 'grid', gap: 'var(--space-2)' };
const sectionTitleStyle: CSSProperties = { fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-bold)' as unknown as number, color: 'var(--color-text-primary)' };
const emptyTextStyle: CSSProperties = { fontSize: 'var(--font-size-sm)', color: 'var(--color-text-tertiary)' };
const cardStyle: CSSProperties = {
    border: 'var(--border-width-1) solid var(--color-divider)',
    borderRadius: 'var(--radius-xl)',
    background: 'var(--color-bg-header)',
    padding: 'var(--space-2)',
    display: 'grid',
    gap: 'var(--space-1-5)',
};
const cardTitleStyle: CSSProperties = { fontSize: 'var(--font-size-sm)', color: 'var(--color-text-primary)' };
const cardSubTitleStyle: CSSProperties = { fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' };
const rowStyle: CSSProperties = { display: 'flex', gap: 'var(--space-1-5)' };
const gridStyle: CSSProperties = { display: 'grid', gap: 'var(--space-1)' };
const actionBtnStyle: CSSProperties = {
    border: 'var(--border-width-1) solid var(--color-divider)',
    borderRadius: 'var(--radius-lg)',
    background: 'var(--color-bg-panel)',
    color: 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 'var(--font-weight-semibold)' as unknown as number,
    padding: 'var(--space-1) var(--space-2)',
    cursor: 'pointer',
    transition: 'background var(--transition-fast)',
};
