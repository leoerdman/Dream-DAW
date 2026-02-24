import { useDragStore } from '@/shared/stores/useDragStore';
import { PluginKnob } from '@/widgets/DeviceRack/StandardPluginControls';
import { canDropInZone } from '@/shared/lib/dndMatrix';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import { buildSurfaceKnobParams } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';

interface PluginGuiSurfaceSamplerProps {
    device: DeviceSlot;
    samplerWaveformPath: string | null;
    onParamChange: (paramName: string, value: number) => void;
    onParamGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onParamGestureEnd?: (paramName: string) => void;
    onDropSample?: (samplePath: string) => void;
    onLoadSample?: () => void;
}

export function PluginGuiSurfaceSampler({
    device,
    samplerWaveformPath,
    onParamChange,
    onParamGestureStart,
    onParamGestureEnd,
    onDropSample,
    onLoadSample,
}: PluginGuiSurfaceSamplerProps) {
    const otherSamplerParams = buildSurfaceKnobParams(device);
    const sampleName = device.samplePath ? device.samplePath.split('/').pop() : null;
    const normalizeDroppedPath = (raw: string): string | null => {
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
    };
    const extractPathFromDataTransfer = (dt: DataTransfer): string | null => {
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
            // Tauri/WebKit usually exposes absolute path here for local drops.
            const candidate = (firstFile as File & { path?: string }).path;
            if (candidate && candidate.trim().length > 0) return candidate.trim();
        }
        return null;
    };
    const commitDropFromStore = () => {
        const dragging = useDragStore.getState().draggingItem;
        const acceptance = dragging ? canDropInZone(dragging, 'sampler-surface') : { allowed: false };
        if (dragging?.path && acceptance.allowed) {
            onDropSample?.(dragging.path);
            useDragStore.getState().endDrag();
        }
    };

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        const dragging = useDragStore.getState().draggingItem;
        const acceptance = dragging ? canDropInZone(dragging, 'sampler-surface') : { allowed: false };
        const directPath = extractPathFromDataTransfer(e.dataTransfer);
        const hasFilePayload = Array.from(e.dataTransfer.types ?? []).includes('Files');
        if (!acceptance.allowed && !directPath && !hasFilePayload) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
    };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const directPath = extractPathFromDataTransfer(e.dataTransfer);
        if (directPath) {
            onDropSample?.(directPath);
            useDragStore.getState().endDrag();
            return;
        }
        commitDropFromStore();
    };

    return (
        <div
            data-no-drag
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onMouseUpCapture={commitDropFromStore}
            onMouseUp={commitDropFromStore}
            style={{
                display: 'grid',
                gridTemplateRows: 'var(--token-size-px-102) auto',
                height: '100%',
                gap: 'var(--space-1)',
                borderRadius: 'var(--radius-lg)',
                background: 'var(--surface-tab-inactive)',
                overflow: 'hidden',
            }}
        >
            <div
                data-no-drag
                style={{
                    position: 'relative',
                    overflow: 'hidden',
                    borderBottom: 'var(--space-px) solid var(--token-color-rgba-90-178-255-0d22)',
                }}
            >
                <div
                    style={{
                        position: 'absolute',
                        inset: 0,
                        background: 'var(--surface-tab-inactive)',
                    }}
                />
                <svg
                    viewBox="0 0 1000 90"
                    preserveAspectRatio="none"
                    style={{ position: 'absolute', left: 8, right: 8, top: 18, height: 58, width: 'calc(100% - var(--space-4))' }}
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
                <div
                    style={{
                        position: 'absolute',
                        left: 8,
                        top: 4,
                        color: 'var(--token-color-hex-d7dce7)',
                        fontSize: 'var(--font-size-2xs)',
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                        fontWeight: 'var(--font-weight-bold)' as unknown as number,
                    }}
                >
                    Sample
                </div>
                <div
                    style={{
                        position: 'absolute',
                        left: 8,
                        right: 88,
                        bottom: 3,
                        color: sampleName ? 'var(--token-color-hex-9fb6d9)' : 'var(--token-color-hex-a8b0bd)',
                        fontSize: 'var(--font-size-2xs)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {sampleName ?? 'Drop sample here or load from disk'}
                </div>
                <button
                    type="button"
                    onClick={() => onLoadSample?.()}
                    style={{
                        position: 'absolute',
                        right: 8,
                        top: 4,
                        border: 'var(--space-px) solid var(--color-overlay-light)',
                        borderRadius: 'var(--radius-sm)',
                        background: 'var(--surface-tab-inactive)',
                        color: 'var(--token-color-hex-dce9ff)',
                        fontSize: 'var(--font-size-2xs)',
                        padding: 'var(--token-size-px-3) var(--token-size-px-7)',
                        cursor: 'pointer',
                    }}
                >
                    Load
                </button>
            </div>
            <div
                data-no-drag
                style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${Math.min(8, Math.max(4, otherSamplerParams.length))}, minmax(0, 1fr))`,
                    gap: 'var(--space-2)',
                    alignItems: 'center',
                    padding: 'var(--space-1) var(--space-2) var(--space-2) var(--space-2)',
                    background: 'var(--token-color-rgba-16-20-28-0d55)',
                }}
            >
                {otherSamplerParams.map((p) => (
                    <PluginKnob
                        key={p.name}
                        param={p}
                        onChange={onParamChange}
                        onGestureStart={onParamGestureStart}
                        onGestureEnd={onParamGestureEnd}
                        compact
                    />
                ))}
            </div>
        </div>
    );
}
