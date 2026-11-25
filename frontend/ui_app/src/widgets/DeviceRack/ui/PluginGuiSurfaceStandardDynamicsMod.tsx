// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — DynamicsMod Plugin Surfaces (Limiter / Gate / AutoFilter)
// Assembled from PluginModules design system
// ═══════════════════════════════════════════════════════════════════════════
import React from 'react';
import { clamp01 } from '@/shared/lib/audioMath';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import {
    DryWetSection,
    formatSurfaceParam,
    getDevicePluginKey,
    readSurfaceParam,
    type SurfaceHandlers,
} from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';
import {
    ControlPanel,
    GainReductionMeter,
    MetaReadout,
    MiniFilterEq,
    PluginSurfaceLayout,
    SpectrumBars,
    getPluginSurfaceProps,
    VizCard,
    VizColumn,
} from '@/widgets/DeviceRack/ui/PluginModules';
import { renderModSpatialSurface } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardModSpatial';

function LimiterSurface({ device, handlers }: { device: DeviceSlot; handlers: SurfaceHandlers }): React.ReactNode {
    const { showDryWet, knobParams } = getPluginSurfaceProps(device);
    const thrParam = readSurfaceParam(device, 'thr', -0.3, 'dB');
    const ceilParam = readSurfaceParam(device, 'ceil', -0.1, 'dB');
    const limGr = Math.max(0, Math.abs(thrParam.value) * 0.8);

    return (
        <PluginSurfaceLayout>
            <ControlPanel params={knobParams} handlers={handlers} />
            <VizColumn>
                <VizCard background="var(--plugin-bg-limiter)">
                    <div style={{ display: 'flex', height: '100%', gap: 6, padding: 6 }}>
                        <div style={{ flex: 1 }}>
                            <GainReductionMeter grDb={limGr} maxDb={24} orientation="horizontal" />
                        </div>
                    </div>
                </VizCard>
                <MetaReadout>
                    <span>Thr {formatSurfaceParam(thrParam)}</span>
                    <span>Ceil {formatSurfaceParam(ceilParam)}</span>
                    <span>GR ~{limGr.toFixed(1)} dB</span>
                </MetaReadout>
            </VizColumn>
            <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-56d4c8)" show={showDryWet} />
        </PluginSurfaceLayout>
    );
}

function GateSurface({ device, handlers }: { device: DeviceSlot; handlers: SurfaceHandlers }): React.ReactNode {
    const { showDryWet, knobParams } = getPluginSurfaceProps(device);
    const thrParam = readSurfaceParam(device, 'thr', -40, 'dB');
    const thrNorm = clamp01((thrParam.value + 60) / 60);

    // Generate bar data with gating threshold applied
    const gateData = Array.from({ length: 14 }, (_, i) => {
        const raw = Math.abs(Math.sin((i + 1) * 0.95));
        const aboveThreshold = raw > thrNorm * 0.8;
        return aboveThreshold ? 0.12 + raw * 0.7 : 0.05;
    });

    return (
        <PluginSurfaceLayout>
            <ControlPanel params={knobParams} handlers={handlers} />
            <VizColumn>
                <VizCard background="var(--plugin-bg-gate)">
                    <SpectrumBars data={gateData} accent="var(--token-color-hex-8ecb7c)" />
                </VizCard>
                <MetaReadout>
                    <span>Thr {formatSurfaceParam(thrParam)}</span>
                </MetaReadout>
            </VizColumn>
            <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-8ecb7c)" show={showDryWet} />
        </PluginSurfaceLayout>
    );
}

function AutoFilterSurface({ device, handlers }: { device: DeviceSlot; handlers: SurfaceHandlers }): React.ReactNode {
    const { showDryWet, knobParams } = getPluginSurfaceProps(device);
    const normalizedInternalId = getDevicePluginKey(device);
    const isVocoder = normalizedInternalId === 'internal://effect/vocoder';
    const modFreq = readSurfaceParam(device, ['freq', 'frequency', 'cutoff', 'center'], 1000, 'Hz');
    const freqNorm = clamp01((Math.log10(Math.max(20, modFreq.value)) - Math.log10(20)) / (Math.log10(20000) - Math.log10(20)));

    return (
        <PluginSurfaceLayout>
            <ControlPanel params={knobParams} handlers={handlers} />
            <VizColumn>
                <VizCard background="var(--plugin-bg-mod)">
                    {isVocoder ? (
                        <SpectrumBars barCount={20} accent="var(--token-color-rgba-76-201-216-0d85)" />
                    ) : (
                        <MiniFilterEq
                            hpFreqNorm={0}
                            lpFreqNorm={freqNorm}
                            accentHp="var(--token-color-hex-4cc9d8)"
                            accentLp="var(--token-color-hex-4cc9d8)"
                        />
                    )}
                </VizCard>
                <MetaReadout>
                    <span>Freq {formatSurfaceParam(modFreq)}</span>
                </MetaReadout>
            </VizColumn>
            <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-4cc9d8)" show={showDryWet} />
        </PluginSurfaceLayout>
    );
}

export function renderStandardDynamicsModSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    if (device.effectType === 'limiter') return <LimiterSurface device={device} handlers={handlers} />;
    if (device.effectType === 'gate') return <GateSurface device={device} handlers={handlers} />;
    if (device.effectType === 'autoFilter') return <AutoFilterSurface device={device} handlers={handlers} />;
    return renderModSpatialSurface(device, handlers);
}
