// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — TimeTone Plugin Surfaces (Chorus / Saturator)
// Assembled from PluginModules design system
// ═══════════════════════════════════════════════════════════════════════════
import { clamp01 } from '@/shared/lib/audioMath';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import {
    formatSurfaceParam,
    getDevicePluginKey,
    readSurfaceParam,
    type SurfaceHandlers,
} from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';
import {
    ControlPanel,
    MetaReadout,
    ModulationWave,
    PluginSurfaceLayout,
    SaturationCurve,
    usePluginSurfaceProps,
    VizCard,
    VizColumn,
    WaveformDisplay,
} from '@/widgets/DeviceRack/ui/PluginModules';
import { DryWetSection } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';

function renderChorusSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const { showDryWet, knobParams } = usePluginSurfaceProps(device);
    const rate = readSurfaceParam(device, 'rate', 1.2, 'Hz');
    const depth = readSurfaceParam(device, 'depth', 40, '%');
    const depthNorm = clamp01(depth.value / 100);
    const rateNorm = clamp01(Math.min(rate.value, 10) / 10);

    return (
        <PluginSurfaceLayout>
            <ControlPanel params={knobParams} handlers={handlers} />
            <VizColumn>
                <VizCard background="var(--plugin-bg-chorus)">
                    <ModulationWave rate={rateNorm} depth={depthNorm} shape="sine" accent="var(--token-color-hex-c867ff)" />
                </VizCard>
                <MetaReadout>
                    <span>{formatSurfaceParam(rate)}</span>
                    <span>Depth {formatSurfaceParam(depth)}</span>
                </MetaReadout>
            </VizColumn>
            <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-c867ff)" show={showDryWet} />
        </PluginSurfaceLayout>
    );
}

function renderSaturatorSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const normalizedInternalId = getDevicePluginKey(device);
    const { showDryWet, knobParams } = usePluginSurfaceProps(device);
    const isDrumBuss = normalizedInternalId === 'internal://effect/drum-buss';
    const isDynamicTube = normalizedInternalId === 'internal://effect/dynamic-tube';
    const driveParam = readSurfaceParam(device, 'drive', 3, 'dB');
    const driveNorm = clamp01(Math.max(0, driveParam.value) / 24);

    const satType = isDrumBuss ? undefined : isDynamicTube ? 'tube' as const : 'soft' as const;

    return (
        <PluginSurfaceLayout>
            <ControlPanel params={knobParams} handlers={handlers} />
            <VizColumn>
                <VizCard background="var(--plugin-bg-saturator)">
                    {isDrumBuss ? (
                        <WaveformDisplay
                            data={Array.from({ length: 12 }, (_, i) => 0.2 + ((i * 7) % 52) / 80)}
                            accent="var(--token-color-rgba-255-172-89-0d82)"
                            mode="bars"
                        />
                    ) : (
                        <SaturationCurve drive={driveNorm} type={satType} accent="var(--token-color-hex-ffac59)" />
                    )}
                </VizCard>
                <MetaReadout>
                    <span>Drive {formatSurfaceParam(driveParam)}</span>
                </MetaReadout>
            </VizColumn>
            <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-ffac59)" show={showDryWet} />
        </PluginSurfaceLayout>
    );
}

export function renderTimeToneSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    if (device.effectType === 'chorus') return renderChorusSurface(device, handlers);
    if (device.effectType === 'saturator' || device.effectType === 'drumBuss' || device.effectType === 'dynamicTube') return renderSaturatorSurface(device, handlers);
    return null;
}
