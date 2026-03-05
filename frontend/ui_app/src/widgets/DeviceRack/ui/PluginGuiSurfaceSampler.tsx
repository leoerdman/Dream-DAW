import { useState, useMemo, useCallback } from 'react';
import { useDragStore } from '@/shared/stores/useDragStore';
import { PluginKnob, PluginFader } from '@/widgets/DeviceRack/StandardPluginControls';
import { canDropInZone } from '@/shared/lib/dndMatrix';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import { SAMPLER_PAGE_MANIFEST } from '@/shared/config/InternalPluginPageManifest';
import type { PageParamEntry, PluginPage } from '@/shared/config/InternalPluginPageManifest';
import { resolveSurfaceParam } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';

interface PluginGuiSurfaceSamplerProps {
    device: DeviceSlot;
    samplerWaveformPath: string | null;
    onParamChange: (paramName: string, value: number) => void;
    onParamGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onParamGestureEnd?: (paramName: string) => void;
    onParamContextMenu?: (e: React.MouseEvent, paramName: string) => void;
    onDropSample?: (samplePath: string) => void;
    onLoadSample?: () => void;
}

/* ── Tab button style (matching StatusBar Rack/Clip pattern) ───── */
const tabBtnStyle = (active: boolean): React.CSSProperties => ({
    height: 18,
    minWidth: 52,
    border: active
        ? 'var(--space-px) solid color-mix(in srgb, var(--color-accent-primary) 44%, var(--color-control-border))'
        : 'var(--space-px) solid transparent',
    borderRadius: 'var(--radius-sm)',
    background: active
        ? 'color-mix(in srgb, var(--color-accent-primary) 20%, var(--color-control-bg))'
        : 'transparent',
    color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-2xs)',
    fontWeight: 600,
    letterSpacing: '0.02em',
    padding: '0 var(--space-2)',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'background-color 120ms ease, color 120ms ease, border-color 120ms ease',
});

export function PluginGuiSurfaceSampler({
    device,
    samplerWaveformPath,
    onParamChange,
    onParamGestureStart,
    onParamGestureEnd,
    onParamContextMenu,
    onDropSample,
    onLoadSample,
}: PluginGuiSurfaceSamplerProps) {
    const [activePageId, setActivePageId] = useState<string>(SAMPLER_PAGE_MANIFEST.pages[0].id);
    const sampleName = device.samplePath ? device.samplePath.split('/').pop() : null;
    const hasSample = !!sampleName;
    const [isDragOver, setIsDragOver] = useState(false);

    const activePage = useMemo(() =>
        SAMPLER_PAGE_MANIFEST.pages.find(p => p.id === activePageId) ?? SAMPLER_PAGE_MANIFEST.pages[0],
        [activePageId]);

    // ── Resolve params for the active page ──────────────────────
    const resolvedParams = useMemo(() => {
        return activePage.params
            .map(entry => {
                const param = resolveSurfaceParam(device, entry.name);
                return param ? { entry, param } : null;
            })
            .filter((x): x is { entry: PageParamEntry; param: NonNullable<ReturnType<typeof resolveSurfaceParam>> } => x !== null);
    }, [activePage.params, device]);

    // For settings page: also show any remaining params not on any page
    const allManifestParamNames = useMemo(() => {
        const names = new Set<string>();
        for (const page of SAMPLER_PAGE_MANIFEST.pages) {
            for (const p of page.params) {
                names.add(p.name.toLowerCase());
            }
        }
        return names;
    }, []);

    const extraSettingsParams = useMemo(() => {
        if (activePageId !== 'settings') return [];
        return device.params.filter(p => !allManifestParamNames.has(p.name.toLowerCase()));
    }, [activePageId, allManifestParamNames, device.params]);

    // ── DnD handlers ────────────────────────────────────────────
    const normalizeDroppedPath = useCallback((raw: string): string | null => {
        const trimmed = raw.trim();
        if (!trimmed) return null;
        if (trimmed.startsWith('file://')) {
            try {
                const url = new URL(trimmed);
                return decodeURIComponent(url.pathname || '').trim() || null;
            } catch {
                return decodeURIComponent(trimmed.replace(/^file:\/\//, '')).trim() || null;
            }
        }
        return trimmed;
    }, []);

    const extractPathFromDataTransfer = useCallback((dt: DataTransfer): string | null => {
        const uriList = dt.getData('text/uri-list');
        if (uriList) {
            const first = uriList
                .split('\n')
                .map((s) => s.trim())
                .find((s) => s && !s.startsWith('#'));
            const normalized = first ? normalizeDroppedPath(first) : null;
            if (normalized) return normalized;
        }
        const plain = dt.getData('text/plain');
        if (plain) {
            const normalized = normalizeDroppedPath(plain);
            if (normalized) return normalized;
        }
        const firstFile = dt.files?.[0];
        if (firstFile) {
            const candidate = (firstFile as File & { path?: string }).path;
            if (candidate && candidate.trim().length > 0) return candidate.trim();
        }
        return null;
    }, [normalizeDroppedPath]);

    const commitDropFromStore = useCallback(() => {
        const dragging = useDragStore.getState().draggingItem;
        const acceptance = dragging ? canDropInZone(dragging, 'sampler-surface') : { allowed: false };
        if (dragging?.path && acceptance.allowed) {
            onDropSample?.(dragging.path);
            useDragStore.getState().endDrag();
        }
    }, [onDropSample]);

    const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        const dragging = useDragStore.getState().draggingItem;
        const acceptance = dragging ? canDropInZone(dragging, 'sampler-surface') : { allowed: false };
        const directPath = extractPathFromDataTransfer(e.dataTransfer);
        const hasFilePayload = Array.from(e.dataTransfer.types ?? []).includes('Files');
        if (!acceptance.allowed && !directPath && !hasFilePayload) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        setIsDragOver(true);
    }, [extractPathFromDataTransfer]);

    const handleDragLeave = useCallback(() => setIsDragOver(false), []);

    const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);
        const directPath = extractPathFromDataTransfer(e.dataTransfer);
        if (directPath) {
            onDropSample?.(directPath);
            useDragStore.getState().endDrag();
            return;
        }
        commitDropFromStore();
    }, [extractPathFromDataTransfer, onDropSample, commitDropFromStore]);

    // ── Render ───────────────────────────────────────────────────
    const isWaveformPage = activePageId === 'waveform';

    return (
        <div
            data-no-drag
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onMouseUpCapture={commitDropFromStore}
            onMouseUp={commitDropFromStore}
            className={isDragOver ? 'sampler-drop-active' : undefined}
            style={{
                display: 'grid',
                gridTemplateRows: 'auto 1fr',
                height: '100%',
                gap: 'var(--space-1)',
                borderRadius: 'var(--radius-lg)',
                background: 'var(--surface-tab-inactive)',
                overflow: 'hidden',
            }}
        >
            {/* ── Top section: Waveform area ─────────────────────── */}
            {isWaveformPage && (
                <div
                    data-no-drag
                    style={{
                        position: 'relative',
                        overflow: 'hidden',
                        borderBottom: 'var(--space-px) solid var(--token-color-rgba-90-178-255-0d22)',
                        minHeight: 80,
                    }}
                >
                    {/* Dark waveform background */}
                    <div style={{ position: 'absolute', inset: 0, background: 'var(--surface-tab-inactive)' }} />

                    {/* Sample name ABOVE waveform — top left */}
                    <div style={{
                        position: 'absolute',
                        left: 8,
                        top: 4,
                        right: 120,
                        color: sampleName ? 'var(--token-color-hex-d7dce7)' : 'var(--token-color-hex-a8b0bd)',
                        fontSize: 'var(--font-size-2xs)',
                        fontWeight: 'var(--font-weight-bold)',
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}>
                        {sampleName ?? 'Drop sample here'}
                    </div>

                    {/* Tab switcher — top right */}
                    <div style={{
                        position: 'absolute',
                        right: 6,
                        top: 3,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 2,
                        border: 'var(--space-px) solid var(--color-control-border)',
                        borderRadius: 'var(--radius-md)',
                        padding: 2,
                        background: 'var(--color-control-bg)',
                        boxShadow: 'inset 0 var(--space-px) 0 color-mix(in srgb, var(--color-text-primary) 5%, transparent)',
                        zIndex: 2,
                    }}>
                        {SAMPLER_PAGE_MANIFEST.pages.map(page => (
                            <button
                                key={page.id}
                                type="button"
                                data-no-drag
                                onClick={() => setActivePageId(page.id)}
                                style={tabBtnStyle(activePageId === page.id)}
                            >
                                {page.label}
                            </button>
                        ))}
                    </div>

                    {/* SVG waveform */}
                    <svg
                        viewBox="0 0 1000 90"
                        preserveAspectRatio="xMidYMid slice"
                        style={{ position: 'absolute', left: 8, right: 8, top: 18, height: 58, width: 'calc(100% - var(--space-4))', willChange: 'transform', transform: 'translateZ(0)' }}
                    >
                        <defs>
                            <linearGradient id={`samplerWaveFill-${device.id}`} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="var(--token-color-hex-ffcc58)" stopOpacity="0.92" />
                                <stop offset="100%" stopColor="var(--token-color-hex-f0a62a)" stopOpacity="0.66" />
                            </linearGradient>
                        </defs>
                        <rect x="0" y="0" width="1000" height="90" fill="color-mix(in srgb, var(--surface-1) 90%, var(--token-color-hex-0f1728))" />
                        {Array.from({ length: 18 }).map((_, i) => (
                            <line
                                key={`g-${i}`}
                                x1={(i / 17) * 1000}
                                y1={0}
                                x2={(i / 17) * 1000}
                                y2={90}
                                stroke="var(--token-color-rgba-90-178-255-0d09)"
                                strokeWidth="1"
                            />
                        ))}
                        <line x1="0" y1="45" x2="1000" y2="45" stroke="var(--token-color-rgba-255-255-255-0d12)" strokeWidth="1" />
                        {samplerWaveformPath ? (
                            <>
                                <path d={samplerWaveformPath} fill={`url(#samplerWaveFill-${device.id})`} />
                                <path d={samplerWaveformPath} fill="none" stroke="var(--token-color-rgba-255-214-110-0d85)" strokeWidth="1" />
                            </>
                        ) : null}
                    </svg>

                    {/* Load button — centered, only when no sample */}
                    {!hasSample && (
                        <button
                            type="button"
                            data-no-drag
                            onClick={() => onLoadSample?.()}
                            className="sampler-load-btn"
                            style={{
                                position: 'absolute',
                                left: '50%',
                                top: '50%',
                                transform: 'translate(-50%, -50%)',
                                zIndex: 1,
                            }}
                        >
                            Load Sample
                        </button>
                    )}
                </div>
            )}

            {/* ── Settings page header (when settings active) ────── */}
            {!isWaveformPage && (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '4px 8px',
                    borderBottom: 'var(--space-px) solid var(--color-divider)',
                    flexShrink: 0,
                }}>
                    <span style={{
                        fontSize: 'var(--font-size-2xs)',
                        fontWeight: 'var(--font-weight-bold)',
                        color: 'var(--color-text-secondary)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                    }}>
                        {activePage.label}
                    </span>
                    {/* Tab switcher */}
                    <div style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 2,
                        border: 'var(--space-px) solid var(--color-control-border)',
                        borderRadius: 'var(--radius-md)',
                        padding: 2,
                        background: 'var(--color-control-bg)',
                        boxShadow: 'inset 0 var(--space-px) 0 color-mix(in srgb, var(--color-text-primary) 5%, transparent)',
                    }}>
                        {SAMPLER_PAGE_MANIFEST.pages.map(page => (
                            <button
                                key={page.id}
                                type="button"
                                data-no-drag
                                onClick={() => setActivePageId(page.id)}
                                style={tabBtnStyle(activePageId === page.id)}
                            >
                                {page.label}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* ── Params area ────────────────────────────────────── */}
            <div
                data-no-drag
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-1)',
                    padding: 'var(--space-1) var(--space-2)',
                    background: 'var(--token-color-rgba-16-20-28-0d55)',
                    overflow: 'hidden',
                }}
            >
                {/* Knobs row */}
                {resolvedParams.filter(r => r.entry.control === 'knob').length > 0 && (
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: `repeat(${Math.min(8, resolvedParams.filter(r => r.entry.control === 'knob').length)}, minmax(0, 1fr))`,
                        gap: 'var(--space-1-5)',
                        alignItems: 'center',
                    }}>
                        {resolvedParams
                            .filter(r => r.entry.control === 'knob')
                            .map(({ entry, param }) => (
                                <PluginKnob
                                    key={param.name}
                                    param={entry.faderMin != null ? { ...param, min: entry.faderMin, max: entry.faderMax ?? param.max } : param}
                                    label={entry.label}
                                    onChange={onParamChange}
                                    onGestureStart={onParamGestureStart}
                                    onGestureEnd={onParamGestureEnd}
                                    onContextMenu={onParamContextMenu}
                                    compact
                                />
                            ))
                        }
                    </div>
                )}

                {/* Fader rows */}
                {resolvedParams
                    .filter(r => r.entry.control === 'fader')
                    .map(({ entry, param }) => (
                        <PluginFader
                            key={param.name}
                            param={entry.faderMin != null ? { ...param, min: entry.faderMin, max: entry.faderMax ?? param.max } : param}
                            label={entry.label}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            onContextMenu={onParamContextMenu}
                        />
                    ))
                }

                {/* Extra params on settings page (not in manifest) */}
                {extraSettingsParams.length > 0 && (
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: `repeat(${Math.min(6, extraSettingsParams.length)}, minmax(0, 1fr))`,
                        gap: 'var(--space-1-5)',
                        alignItems: 'center',
                    }}>
                        {extraSettingsParams.map(p => (
                            <PluginKnob
                                key={p.name}
                                param={p}
                                onChange={onParamChange}
                                onGestureStart={onParamGestureStart}
                                onGestureEnd={onParamGestureEnd}
                                onContextMenu={onParamContextMenu}
                                compact
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
