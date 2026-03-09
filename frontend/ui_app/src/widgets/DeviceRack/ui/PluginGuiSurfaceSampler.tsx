import { useState, useMemo, useCallback } from 'react';
import { useDragStore } from '@/shared/stores/useDragStore';
import { PluginKnob, PluginFader } from '@/widgets/DeviceRack/StandardPluginControls';
import { canDropInZone } from '@/shared/lib/dndMatrix';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import { SAMPLER_PAGE_MANIFEST } from '@/shared/config/InternalPluginPageManifest';
import type { PageParamEntry } from '@/shared/config/InternalPluginPageManifest';
import { resolveSurfaceParam } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';
import { AdsrCurve } from '@/widgets/DeviceRack/ui/PluginModules';

interface PluginGuiSurfaceSamplerProps {
    device: DeviceSlot;
    samplerWaveformPath: string | null;
    sampleMissing?: boolean;
    onParamChange: (paramName: string, value: number) => void;
    onParamGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onParamGestureEnd?: (paramName: string) => void;
    onParamContextMenu?: (e: React.MouseEvent, paramName: string) => void;
    onDropSample?: (samplePath: string) => void;
    onLoadSample?: () => void;
}

/* ── Tab button styles (frozen module-level — enterprise perf pattern) ─ */
const TAB_BTN_BASE: React.CSSProperties = Object.freeze({
    height: 18,
    minWidth: 52,
    borderRadius: 'var(--radius-sm)',
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
const TAB_BTN_ACTIVE: React.CSSProperties = Object.freeze({
    ...TAB_BTN_BASE,
    border: 'var(--space-px) solid color-mix(in srgb, var(--color-accent-primary) 44%, var(--color-control-border))',
    background: 'color-mix(in srgb, var(--color-accent-primary) 20%, var(--color-control-bg))',
    color: 'var(--color-text-primary)',
});
const TAB_BTN_INACTIVE: React.CSSProperties = Object.freeze({
    ...TAB_BTN_BASE,
    border: 'var(--space-px) solid transparent',
    background: 'transparent',
    color: 'var(--color-text-secondary)',
});

export function PluginGuiSurfaceSampler({
    device,
    samplerWaveformPath,
    sampleMissing = false,
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

    // ── Precompute ADSR overlay values ─────────────────────────
    const attackParam = resolveSurfaceParam(device, 'attack');
    const normAttack = attackParam ? Math.max(0, (attackParam.value - attackParam.min)) / (Math.max(0.001, attackParam.max - attackParam.min)) : 0.05;
    const finalNormAttack = normAttack < 0.005 ? 0 : normAttack;

    const decayParam = resolveSurfaceParam(device, 'decay');
    const normDecay = decayParam ? Math.max(0, (decayParam.value - decayParam.min)) / (Math.max(0.001, decayParam.max - decayParam.min)) : 0.2;
    const finalNormDecay = normDecay < 0.005 ? 0 : normDecay;

    const sustainParam = resolveSurfaceParam(device, 'sustain');
    const normSustain = sustainParam ? Math.max(0, (sustainParam.value - sustainParam.min)) / (Math.max(0.001, sustainParam.max - sustainParam.min)) : 0.5;
    const finalNormSustain = normSustain < 0.005 ? 0 : normSustain;

    const releaseParam = resolveSurfaceParam(device, 'release');
    const normRelease = releaseParam ? Math.max(0, (releaseParam.value - releaseParam.min)) / (Math.max(0.001, releaseParam.max - releaseParam.min)) : 0.2;
    const finalNormRelease = normRelease < 0.005 ? 0 : normRelease;

    // ── Render ───────────────────────────────────────────────────
    const isWaveformPage = activePageId === 'waveform';

    return (
        <div
            data-no-drag
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onPointerUpCapture={commitDropFromStore}
            onPointerUp={commitDropFromStore}
            className={isDragOver ? 'sampler-drop-active' : undefined}
            style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                borderRadius: 'var(--radius-lg)',
                background: 'var(--surface-tab-inactive)',
                overflow: 'hidden',
            }}
        >
            {/* ── Persistent header: Sample name + Waveform/Settings tabs ── */}
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
                    color: sampleMissing
                        ? 'var(--color-status-error)'
                        : sampleName
                            ? 'var(--token-color-hex-d7dce7)'
                            : 'var(--token-color-hex-a8b0bd)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                    flex: 1,
                    textDecoration: sampleMissing && sampleName ? 'line-through' : undefined,
                }}>
                    {sampleName ?? 'Drop sample here'}
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
                    flexShrink: 0,
                    marginLeft: 8,
                }}>
                    {SAMPLER_PAGE_MANIFEST.pages.map(page => (
                        <button
                            key={page.id}
                            type="button"
                            data-no-drag
                            onClick={() => setActivePageId(page.id)}
                            style={activePageId === page.id ? TAB_BTN_ACTIVE : TAB_BTN_INACTIVE}
                        >
                            {page.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* ── Waveform area (edge-to-edge, no padding) ─────────── */}
            {isWaveformPage && (
                <div
                    data-no-drag
                    style={{
                        position: 'relative',
                        overflow: 'hidden',
                        minHeight: 80,
                    }}
                >
                    {/* Dark waveform background */}
                    <div style={{ position: 'absolute', inset: 0, background: 'var(--surface-tab-inactive)' }} />

                    {/* SVG waveform — edge-to-edge, top-to-bottom */}
                    <svg
                        viewBox="0 0 1000 90"
                        preserveAspectRatio="none"
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', willChange: 'transform', transform: 'translateZ(0)' }}
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

                    {/* ENTERPRISE: Merged Missing Sample UI below */}

                    {/* ADSR Overlay — edge-to-edge, top-to-bottom */}
                    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                        <AdsrCurve
                            attack={finalNormAttack}
                            decay={finalNormDecay}
                            sustain={finalNormSustain}
                            release={finalNormRelease}
                            accent="var(--token-color-hex-4a9eff)"
                            transparent
                        />
                    </div>

                    {/* Centralized Empty/Missing State Container */}
                    {(!hasSample || sampleMissing) && (
                        <div style={{
                            position: 'absolute',
                            inset: 0,
                            display: 'flex',
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 'var(--space-2)',
                            zIndex: 10,
                            pointerEvents: 'none',
                        }}>
                            {sampleMissing ? (
                                <>
                                    <div style={{
                                        padding: '4px 12px',
                                        borderRadius: 'var(--radius-sm)',
                                        background: 'color-mix(in srgb, var(--color-status-error) 18%, transparent)',
                                        border: 'var(--space-px) solid color-mix(in srgb, var(--color-status-error) 30%, transparent)',
                                        color: 'var(--color-status-error)',
                                        fontSize: 'var(--font-size-2xs)',
                                        fontWeight: 'var(--font-weight-bold)',
                                        letterSpacing: '0.04em',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 6,
                                    }}>
                                        <span>⚠️</span>
                                        SAMPLE NOT FOUND
                                    </div>
                                    <button
                                        type="button"
                                        data-no-drag
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            window.dispatchEvent(new CustomEvent('dream:layout-toggle-panel', { detail: 'missing-assets' }));
                                        }}
                                        style={{
                                            padding: '4px 16px',
                                            borderRadius: 'var(--radius-md)',
                                            background: 'var(--surface-overlay)',
                                            border: 'var(--space-px) solid var(--color-control-border)',
                                            color: 'var(--color-text-primary)',
                                            fontSize: 'var(--font-size-2xs)',
                                            fontWeight: 'var(--font-weight-medium)',
                                            cursor: 'pointer',
                                            transition: 'background-color 0.15s ease',
                                            pointerEvents: 'auto',
                                        }}
                                        onPointerEnter={(e) => (e.currentTarget.style.background = 'var(--surface-overlay-hover)')}
                                        onPointerLeave={(e) => (e.currentTarget.style.background = 'var(--surface-overlay)')}
                                    >
                                        Replace Sample
                                    </button>
                                </>
                            ) : (
                                <button
                                    type="button"
                                    data-no-drag
                                    onClick={() => onLoadSample?.()}
                                    className="sampler-load-btn"
                                    style={{ pointerEvents: 'auto' }}
                                >
                                    Load Sample
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* ── Params area (module-card wrapped) ───────────── */}
            <div
                data-no-drag
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-1)',
                    padding: 'var(--space-1) var(--space-1-5)',
                    overflow: 'auto',
                    flex: 1,
                    minHeight: 0,
                }}
            >
                {/* Knobs row — module card */}
                {resolvedParams.filter(r => r.entry.control === 'knob').length > 0 && (
                    <div style={{
                        border: 'var(--space-px) solid var(--plugin-card-border)',
                        borderRadius: 'var(--plugin-card-radius)',
                        padding: 'var(--space-1)',
                        background: 'var(--plugin-card-bg-main)',
                    }}>
                        <div style={{
                            display: 'grid',
                            gridTemplateColumns: `repeat(${Math.min(8, resolvedParams.filter(r => r.entry.control === 'knob').length)}, minmax(0, 90px))`,
                            gap: 'var(--plugin-grid-gap)',
                            alignItems: 'center',
                            justifyContent: 'center',
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
                    </div>
                )}

                {/* Fader rows — module card */}
                {resolvedParams.filter(r => r.entry.control === 'fader').length > 0 && (
                    <div style={{
                        border: 'var(--space-px) solid var(--plugin-card-border)',
                        borderRadius: 'var(--plugin-card-radius)',
                        padding: 'var(--space-1) var(--space-1-5)',
                        background: 'var(--plugin-card-bg-main)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2,
                    }}>
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
                    </div>
                )}

                {/* Extra params on settings page — module card */}
                {extraSettingsParams.length > 0 && (
                    <div style={{
                        border: 'var(--space-px) solid var(--plugin-card-border)',
                        borderRadius: 'var(--plugin-card-radius)',
                        padding: 'var(--space-1)',
                        background: 'var(--plugin-card-bg-main)',
                    }}>
                        <div style={{
                            display: 'grid',
                            gridTemplateColumns: `repeat(${Math.min(6, extraSettingsParams.length)}, minmax(0, 1fr))`,
                            gap: 'var(--plugin-grid-gap)',
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
                    </div>
                )}
            </div>
        </div>
    );
}
