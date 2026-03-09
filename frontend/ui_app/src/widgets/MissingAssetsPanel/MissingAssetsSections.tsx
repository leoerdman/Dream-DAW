import type { CSSProperties } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import * as engineApi from '@/shared/api/engine';
import type { GroupedMissingFile } from './MissingAssetsPanel';

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
    onResolveFile: (clipIds: string[], path: string, clipName: string) => Promise<void>;
    onReplacePlugin: (trackId: string, slotId: string, path: string, name: string, wantedName: string) => Promise<void>;
    onSetMessage: (message: string) => void;
};

// ── ENTERPRISE: Grouped missing audio file section ──
export function MissingAudioSection({
    groupedFiles,
    onResolveFile,
}: {
    groupedFiles: GroupedMissingFile[];
    onResolveFile: ResolveCallbacks['onResolveFile'];
}) {
    return (
        <section style={sectionStyle}>
            <div style={sectionTitleStyle}>Missing Audio Files</div>
            {groupedFiles.length === 0 ? (
                <div style={emptyTextStyle}>No offline audio clips.</div>
            ) : groupedFiles.map((item) => {
                // Extract extension from file name for type labeling
                const dotIdx = item.fileName.lastIndexOf('.');
                const ext = dotIdx > 0 ? item.fileName.slice(dotIdx + 1).toUpperCase() : 'AUDIO';
                return (
                    <div key={item.fileName} style={cardStyle}>
                        <div style={cardTitleStyle}>{item.fileName}</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <span style={{
                                fontSize: 'var(--font-size-2xs)',
                                padding: '1px 5px',
                                borderRadius: 'var(--radius-sm)',
                                background: 'color-mix(in srgb, var(--color-browser-audio) 18%, transparent)',
                                color: 'var(--color-browser-audio)',
                                fontWeight: 'var(--font-weight-medium)',
                            }}>🔊 {ext}</span>
                            {/* ENTERPRISE: Show usage count and track names */}
                            {item.usageCount > 1 && (
                                <span style={{
                                    fontSize: 'var(--font-size-2xs)',
                                    padding: '1px 5px',
                                    borderRadius: 'var(--radius-sm)',
                                    background: 'color-mix(in srgb, var(--color-status-warning) 15%, transparent)',
                                    color: 'var(--color-status-warning)',
                                    fontWeight: 'var(--font-weight-medium)',
                                }}>×{item.usageCount} clips</span>
                            )}
                            <span style={{
                                ...cardSubTitleStyle,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                minWidth: 0,
                            }}>
                                {item.trackNames.length <= 2
                                    ? item.trackNames.join(', ')
                                    : `${item.trackNames[0]}, +${item.trackNames.length - 1}`}
                            </span>
                        </div>
                        <div style={rowStyle}>
                            <button
                                onClick={async () => {
                                    const picked = await open({
                                        multiple: false,
                                        title: `Replace missing file: ${item.fileName}`,
                                        filters: [{ name: 'Audio', extensions: ['wav', 'aif', 'aiff', 'flac', 'mp3', 'ogg', 'm4a', 'aac'] }],
                                    });
                                    const path = typeof picked === 'string' ? picked : null;
                                    if (!path) return;
                                    // ENTERPRISE: Resolve ALL clips that reference this source file
                                    await onResolveFile(item.clipIds, path, item.fileName);
                                }}
                                style={iconBtnStyle}
                                title={`Replace file (resolves ${item.usageCount} clip${item.usageCount > 1 ? 's' : ''})`}
                            >
                                ♻️
                            </button>
                            <button
                                onClick={() => {
                                    window.dispatchEvent(new CustomEvent('dream:browser-set-search', {
                                        detail: { query: item.fileName, categoryId: 'samples' },
                                    }));
                                }}
                                style={iconBtnStyle}
                                title="Find in Browser"
                            >
                                📁
                            </button>
                        </div>
                    </div>
                );
            })}
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
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{
                                fontSize: 'var(--font-size-2xs)',
                                padding: '1px 5px',
                                borderRadius: 'var(--radius-sm)',
                                background: 'color-mix(in srgb, var(--color-browser-plugin) 18%, transparent)',
                                color: 'var(--color-browser-plugin)',
                                fontWeight: 'var(--font-weight-medium)',
                            }}>🔌 Plugin</span>
                            <span style={cardSubTitleStyle}>{item.trackName}</span>
                        </div>
                        <div style={{ ...cardSubTitleStyle, color: 'var(--color-text-secondary)' }}>Wanted: {item.wantedName}</div>

                        <div style={gridStyle}>
                            {matches.length > 0 ? matches.map((p) => (
                                <button
                                    key={`${item.slotId}:${p.path}`}
                                    onClick={() => onReplacePlugin(item.trackId, item.slotId, p.path, p.name, item.wantedName)}
                                    style={{ ...actionBtnStyle, justifyContent: 'space-between', width: '100%', display: 'flex' }}
                                >
                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                                    <span style={{ opacity: 0.7, flexShrink: 0 }}>Use</span>
                                </button>
                            )) : (
                                <div style={emptyTextStyle}>{scanBusy ? 'Scanning plugins…' : 'No close plugin match found'}</div>
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
                                style={iconBtnStyle}
                                title="Pick plugin file"
                            >
                                🔌
                            </button>
                            <button
                                onClick={() => {
                                    window.dispatchEvent(new CustomEvent('dream:browser-set-search', {
                                        detail: { query: item.wantedName, categoryId: 'plugins' },
                                    }));
                                }}
                                style={iconBtnStyle}
                                title="Find in Browser"
                            >
                                📁
                            </button>
                        </div>
                    </div>
                );
            })}
        </section>
    );
}

// ── ENTERPRISE: Missing sampler/rack-pad samples section ──

export type MissingSamplerItem = {
    trackId: string;
    trackName: string;
    samplePath: string;
    /** Present only when the sample belongs to a specific drum-rack pad. */
    padIndex?: number;
    /** Human-readable pad name (e.g. "Kick 1"). */
    padName?: string;
};

export function MissingSamplerSection({
    missingSamples,
    scanBusy,
    onResolveSample,
}: {
    missingSamples: MissingSamplerItem[];
    scanBusy: boolean;
    onResolveSample: (samplePath: string, bestEntry: any, fileName: string) => Promise<void>;
}) {
    return (
        <section style={sectionStyle}>
            <div style={sectionTitleStyle}>Missing Sampler Samples</div>
            {missingSamples.length === 0 ? (
                <div style={emptyTextStyle}>{scanBusy ? 'Scanning sampler tracks…' : 'No missing sampler samples.'}</div>
            ) : missingSamples.map((item, idx) => {
                const fileName = item.samplePath.split('/').pop() ?? item.samplePath;
                const isPad = item.padIndex !== undefined;
                return (
                    <div key={`${item.trackId}:${item.padIndex ?? 'main'}:${idx}`} style={cardStyle}>
                        <div style={{
                            ...cardTitleStyle,
                            color: 'var(--color-status-error)',
                            textDecoration: 'line-through',
                        }}>
                            {fileName}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <span style={{
                                fontSize: 'var(--font-size-2xs)',
                                padding: '1px 5px',
                                borderRadius: 'var(--radius-sm)',
                                background: isPad
                                    ? 'color-mix(in srgb, var(--color-status-warning) 18%, transparent)'
                                    : 'color-mix(in srgb, var(--color-browser-audio) 18%, transparent)',
                                color: isPad ? 'var(--color-status-warning)' : 'var(--color-browser-audio)',
                                fontWeight: 'var(--font-weight-medium)',
                            }}>
                                {isPad ? `🥁 Pad ${(item.padIndex ?? 0) + 1}` : '🎹 Sampler'}
                            </span>
                            <span style={{
                                ...cardSubTitleStyle,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                minWidth: 0,
                            }}>
                                {item.trackName}
                                {isPad && item.padName ? ` — ${item.padName}` : ''}
                            </span>
                        </div>
                        {/* Full path — truncated from the left via rtl direction */}
                        <div style={{
                            fontSize: 'var(--font-size-2xs)',
                            color: 'var(--color-text-tertiary)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            direction: 'rtl',
                            textAlign: 'left',
                            minWidth: 0,
                        }}>
                            {item.samplePath}
                        </div>
                        <div style={rowStyle}>
                            <button
                                onClick={async () => {
                                    const picked = await open({
                                        multiple: false,
                                        title: `Replace missing sample: ${fileName}`,
                                        filters: [{ name: 'Audio', extensions: ['wav', 'aif', 'aiff', 'flac', 'mp3', 'ogg', 'm4a', 'aac'] }],
                                    });
                                    const path = typeof picked === 'string' ? picked : null;
                                    if (!path) return;
                                    // Make a mock entry for manual resolution
                                    await onResolveSample(item.samplePath, { path } as any, fileName);
                                }}
                                style={iconBtnStyle}
                                title="Browse for replacement sample"
                            >
                                ♻️
                            </button>
                            <button
                                onClick={() => {
                                    window.dispatchEvent(new CustomEvent('dream:browser-set-search', {
                                        detail: { query: fileName, categoryId: 'samples' },
                                    }));
                                }}
                                style={iconBtnStyle}
                                title="Find in Browser"
                            >
                                📁
                            </button>
                        </div>
                    </div>
                );
            })}
        </section>
    );
}

// ── Styles — ENTERPRISE: all cards properly overflow-contained ──
const sectionStyle: CSSProperties = { display: 'grid', gap: 'var(--space-1-5)' };
const sectionTitleStyle: CSSProperties = {
    fontSize: 'var(--font-size-xs)',
    fontWeight: 'var(--font-weight-bold)',
    color: 'var(--color-text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    paddingBottom: 'var(--space-0-5)',
    borderBottom: 'var(--border-width-1) solid var(--color-divider)',
};
const emptyTextStyle: CSSProperties = {
    fontSize: 'var(--font-size-sm)',
    color: 'var(--color-text-tertiary)',
    padding: 'var(--space-2)',
    textAlign: 'center',
    background: 'color-mix(in srgb, var(--color-bg-base) 40%, transparent)',
    borderRadius: 'var(--radius-md)',
    border: '1px dashed var(--color-divider)',
    fontStyle: 'italic',
};
const cardStyle: CSSProperties = {
    border: 'var(--border-width-1) solid var(--color-divider)',
    borderRadius: 'var(--radius-lg)',
    background: 'color-mix(in srgb, var(--color-bg-header) 60%, transparent)',
    padding: 'var(--space-2)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1-5)',
    overflow: 'hidden',
    minWidth: 0,
    boxShadow: '0 2px 8px color-mix(in srgb, var(--shadow-color) 10%, transparent)',
};
const cardTitleStyle: CSSProperties = {
    fontSize: 'var(--font-size-sm)',
    color: 'var(--color-text-primary)',
    fontWeight: 'var(--font-weight-medium)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0, // ENTERPRISE: Allow text to shrink
};
const cardSubTitleStyle: CSSProperties = { fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' };
const rowStyle: CSSProperties = { display: 'flex', gap: 'var(--space-1)' };
const gridStyle: CSSProperties = { display: 'grid', gap: 'var(--space-0-5)' };
const actionBtnStyle: CSSProperties = {
    border: 'var(--border-width-1) solid var(--color-divider)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--color-bg-panel)',
    color: 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 'var(--font-weight-medium)',
    padding: '3px 8px',
    cursor: 'pointer',
    transition: 'background var(--transition-fast)',
    overflow: 'hidden',
};
const iconBtnStyle: CSSProperties = {
    border: 'var(--border-width-1) solid var(--color-divider)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--color-bg-panel)',
    color: 'var(--color-text-secondary)',
    fontSize: 14,
    padding: '3px 6px',
    cursor: 'pointer',
    transition: 'background var(--transition-fast)',
    lineHeight: 1,
};
