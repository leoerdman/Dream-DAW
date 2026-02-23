import { useDragStore } from '@/shared/stores/useDragStore';
import { PluginKnob } from '@/widgets/DeviceRack/StandardPluginControls';
import { canDropInZone } from '@/shared/lib/dndMatrix';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';

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
    const otherSamplerParams = device.params.slice(0, 12);
    const sampleName = device.samplePath ? device.samplePath.split('/').pop() : null;

    return (
        <div
            style={{
                display: 'grid',
                gridTemplateRows: '102px auto',
                height: '100%',
                gap: 4,
                borderRadius: 'var(--radius-lg)',
                background: 'var(--surface-tab-inactive)',
                overflow: 'hidden',
            }}
        >
            <div
                style={{
                    position: 'relative',
                    overflow: 'hidden',
                    borderBottom: '1px solid var(--token-color-rgba-90-178-255-0d22)',
                }}
                onMouseUp={() => {
                    const dragging = useDragStore.getState().draggingItem;
                    const acceptance = dragging ? canDropInZone(dragging, 'sampler-surface') : { allowed: false };
                    if (dragging?.path && acceptance.allowed) {
                        onDropSample?.(dragging.path);
                        useDragStore.getState().endDrag();
                    }
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
                    style={{ position: 'absolute', left: 8, right: 8, top: 18, height: 58, width: 'calc(100% - 16px)' }}
                >
                    <defs>
                        <linearGradient id="samplerWaveFill" x1="0" y1="0" x2="0" y2="1">
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
                            <path d={samplerWaveformPath} fill="url(#samplerWaveFill)" />
                            <path d={samplerWaveformPath} fill="none" stroke="var(--token-color-rgba-255-214-110-0d85)" strokeWidth="1" />
                        </>
                    ) : (
                        <path
                            d="M 0 46 C 30 14, 60 78, 90 46 C 120 14, 150 78, 180 46 C 210 14, 240 78, 270 46 C 300 14, 330 78, 360 46 C 390 14, 420 78, 450 46 C 480 14, 510 78, 540 46 C 570 18, 600 74, 630 46 C 660 24, 690 68, 720 46 C 750 30, 780 62, 810 46 C 840 36, 870 56, 900 46 C 930 42, 960 50, 1000 46"
                            fill="none"
                            stroke="var(--token-color-hex-ffbf3c)"
                            strokeWidth="2.4"
                            strokeLinecap="round"
                        />
                    )}
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
                        border: '1px solid var(--color-overlay-light)',
                        borderRadius: 'var(--radius-sm)',
                        background: 'var(--surface-tab-inactive)',
                        color: 'var(--token-color-hex-dce9ff)',
                        fontSize: 'var(--font-size-2xs)',
                        padding: '3px 7px',
                        cursor: 'pointer',
                    }}
                >
                    Load
                </button>
            </div>
            <div
                style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
                    gap: 8,
                    alignItems: 'center',
                    padding: '4px 8px 8px 8px',
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
