// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — ModSpatial Plugin Surfaces (AutoPan / Phaser / Flanger)
// Assembled from PluginModules design system
// ═══════════════════════════════════════════════════════════════════════════
import React from 'react';
import { clamp01 } from '@/shared/lib/audioMath';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import {
    DryWetSection,
    formatSurfaceParam,
    readSurfaceParam,
    type SurfaceHandlers,
} from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';
import {
    ControlPanel,
    MetaReadout,
    ModulationWave,
    PluginSurfaceLayout,
    SpectrumBars,
    getPluginSurfaceProps,
    VizCard,
    VizColumn,
} from '@/widgets/DeviceRack/ui/PluginModules';

function AutoPanSurface({ device, handlers }: { device: DeviceSlot; handlers: SurfaceHandlers }): React.ReactNode {
    const { showDryWet, knobParams } = getPluginSurfaceProps(device);
    const modRate = readSurfaceParam(device, 'rate', 1, 'Hz');
    const modDepth = readSurfaceParam(device, 'depth', 50, '%');
    const depthNorm = clamp01(modDepth.value / 100);
    const rateNorm = clamp01(Math.min(modRate.value, 10) / 10);

    return (
        <PluginSurfaceLayout>
            <ControlPanel params={knobParams} handlers={handlers} />
            <VizColumn>
                <VizCard background="var(--plugin-bg-mod)">
                    <ModulationWave rate={rateNorm} depth={depthNorm} shape="sine" accent="var(--token-color-hex-6db3ff)" />
                </VizCard>
                <MetaReadout>
                    <span>Rate {formatSurfaceParam(modRate)}</span>
                    <span>Depth {formatSurfaceParam(modDepth)}</span>
                </MetaReadout>
            </VizColumn>
            <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-6db3ff)" show={showDryWet} />
        </PluginSurfaceLayout>
    );
}

function PhaserSurface({ device, handlers }: { device: DeviceSlot; handlers: SurfaceHandlers }): React.ReactNode {
    const { showDryWet, knobParams } = getPluginSurfaceProps(device);
    const modRate = readSurfaceParam(device, 'rate', 0.5, 'Hz');
    const modDepth = readSurfaceParam(device, 'depth', 60, '%');
    const stages = readSurfaceParam(device, 'stages', 6, '');
    const stageCount = Math.max(2, Math.min(12, Math.round(stages.value)));
    const depthNorm = clamp01(modDepth.value / 100);

    // Generate notch comb viz data — unique per phaser
    const phaserData = Array.from({ length: stageCount }, (_, i) => {
        const notchNorm = 0.3 + depthNorm * 0.55;
        return i % 2 === 0 ? notchNorm : notchNorm * 0.6;
    });

    return (
        <PluginSurfaceLayout>
            <ControlPanel params={knobParams} handlers={handlers} />
            <VizColumn>
                <VizCard background="var(--plugin-bg-mod)">
                    <SpectrumBars data={phaserData} accent="var(--token-color-hex-998bff)" />
                </VizCard>
                <MetaReadout>
                    <span>{formatSurfaceParam(modRate)}</span>
                    <span>Depth {formatSurfaceParam(modDepth)}</span>
                    <span>{stageCount} stages</span>
                </MetaReadout>
            </VizColumn>
            <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-998bff)" show={showDryWet} />
        </PluginSurfaceLayout>
    );
}

function FlangerSurface({ device, handlers }: { device: DeviceSlot; handlers: SurfaceHandlers }): React.ReactNode {
    const { showDryWet, knobParams } = getPluginSurfaceProps(device);
    const modRate = readSurfaceParam(device, 'rate', 0.3, 'Hz');
    const modDepth = readSurfaceParam(device, 'depth', 50, '%');
    const fb = readSurfaceParam(device, ['fb', 'feedback'], 40, '%');
    const fbNorm = clamp01(Math.abs(fb.value) / 100);

    // Decaying comb bars — unique per flanger
    const flangerData = Array.from({ length: 10 }, (_, i) => {
        return 0.24 + fbNorm * 0.6 * Math.pow(0.85, i);
    });

    return (
        <PluginSurfaceLayout>
            <ControlPanel params={knobParams} handlers={handlers} />
            <VizColumn>
                <VizCard background="var(--plugin-bg-mod)">
                    <SpectrumBars data={flangerData} accent="var(--token-color-hex-66b3ff)" />
                </VizCard>
                <MetaReadout>
                    <span>{formatSurfaceParam(modRate)}</span>
                    <span>Depth {formatSurfaceParam(modDepth)}</span>
                    <span>FB {formatSurfaceParam(fb)}</span>
                </MetaReadout>
            </VizColumn>
            <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-66b3ff)" show={showDryWet} />
        </PluginSurfaceLayout>
    );
}

export function renderModSpatialSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    if (device.effectType === 'autoPan') return <AutoPanSurface device={device} handlers={handlers} />;
    if (device.effectType === 'phaser' || device.effectType === 'phaserFlanger') return <PhaserSurface device={device} handlers={handlers} />;
    if (device.effectType === 'flanger') return <FlangerSurface device={device} handlers={handlers} />;
    return null;
}
