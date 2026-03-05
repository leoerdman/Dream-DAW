// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Utility & Compressor Plugin Surfaces
// Assembled from PluginModules design system
// ═══════════════════════════════════════════════════════════════════════════
import { clamp01 } from '@/shared/lib/audioMath';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import {
    DryWetSection,
    formatSurfaceParam,
    getDevicePluginKey,
    getParamValue,
    readSurfaceParam,
    type SurfaceHandlers,
} from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';
import {
    ButtonStrip,
    CompressionCurve,
    ControlPanel,
    KnobParamGrid,
    MetaReadout,
    PluginSurfaceLayout,
    SpectrumBars,
    ToggleButton,
    usePluginSurfaceProps,
    VizCard,
    VizColumn,
} from '@/widgets/DeviceRack/ui/PluginModules';

export function renderStandardUtilityCompressorSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const { onApplyUtilityScene } = handlers;
    const normalizedInternalId = getDevicePluginKey(device);

    if (device.effectType === 'utility') {
        const mono = getParamValue(device, ['mono'], 0) > 0.5;
        const { showDryWet, knobParams } = usePluginSurfaceProps(device);
        return (
            <div data-no-drag style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-1)',
                height: '100%',
                padding: 'var(--space-1)',
            }}>
                <KnobParamGrid params={knobParams} handlers={handlers} maxCols={2} minCols={2} />
                <ButtonStrip>
                    <ToggleButton label="Mono" active={mono} onClick={() => onApplyUtilityScene?.('mono')} />
                </ButtonStrip>
                {showDryWet && (
                    <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-7ab6ff)" show={showDryWet} />
                )}
            </div>
        );
    }

    if (device.effectType === 'compressor' || device.effectType === 'glueCompressor' || device.effectType === 'multibandDynamics' || device.effectType === 'transientShaper') {
        const isTransientShaper = normalizedInternalId === 'internal://effect/transient-shaper';
        const isGlueCompressor = normalizedInternalId === 'internal://effect/glue-compressor';
        const isMultibandDynamics = normalizedInternalId === 'internal://effect/multiband-dynamics';
        const { showDryWet, knobParams } = usePluginSurfaceProps(device);
        const thrParam = readSurfaceParam(device, 'thr', -18, 'dB');
        const ratioParam = readSurfaceParam(device, 'ratio', 4, ':1');
        const thr = thrParam.value;
        const ratio = ratioParam.value;
        const rawGr = Number.isFinite(device.vuLevel) ? Math.abs(device.vuLevel!) : 0;
        const pseudoGr = rawGr > 0 ? Math.max(0, Math.min(24, rawGr)) : Math.max(0, Math.min(24, ((-thr) / 60) * ratio * 2.4));

        // Normalize threshold and ratio for CompressionCurve
        const thrNorm = clamp01((thr + 60) / 60);
        const ratioNorm = clamp01(Math.min(ratio, 20) / 20);
        const variant: 'standard' | 'glue' | 'multiband' = isGlueCompressor ? 'glue' : isMultibandDynamics ? 'multiband' : 'standard';

        /* Transient Shaper specific params */
        const tsAtkNorm = isTransientShaper ? clamp01(readSurfaceParam(device, 'attack', 50, '%').value / 100) : 0;
        const tsSusNorm = isTransientShaper ? clamp01((readSurfaceParam(device, 'sustain', 0, '%').value + 100) / 200) : 0;

        /* Meta block */
        const metaBlock = (() => {
            if (isTransientShaper) {
                const atkP = readSurfaceParam(device, 'attack', 50, '%');
                const susP = readSurfaceParam(device, 'sustain', 0, '%');
                return (<><span>Atk {formatSurfaceParam(atkP)}</span><span>Sus {formatSurfaceParam(susP)}</span></>);
            }
            if (isGlueCompressor) {
                const GLUE_COMP_RATIOS = ['2:1', '4:1', '10:1'] as const;
                const ratioIdx = Math.round(ratioParam.value);
                const ratioLabel = GLUE_COMP_RATIOS[Math.max(0, Math.min(2, ratioIdx))] ?? '4:1';
                return (<><span>Thr {formatSurfaceParam(thrParam)}</span><span>{ratioLabel}</span><span>GR {pseudoGr.toFixed(1)}dB</span></>);
            }
            if (isMultibandDynamics) {
                const xoverLo = readSurfaceParam(device, 'xover low', 200, 'Hz');
                const xoverHi = readSurfaceParam(device, 'xover high', 4000, 'Hz');
                return (<><span>Lo {formatSurfaceParam(xoverLo)}</span><span>Hi {formatSurfaceParam(xoverHi)}</span></>);
            }
            return (<><span>Thr {formatSurfaceParam(thrParam)}</span><span>Ratio {formatSurfaceParam(ratioParam)}</span><span>GR {pseudoGr.toFixed(1)}dB</span></>);
        })();

        return (
            <PluginSurfaceLayout>
                <ControlPanel params={knobParams} handlers={handlers} />
                <VizColumn>
                    <VizCard background="var(--plugin-bg-compressor)">
                        {isTransientShaper ? (
                            <SpectrumBars
                                barCount={2}
                                data={[tsAtkNorm, tsSusNorm]}
                                accent="var(--token-color-hex-53b0ff)"
                            />
                        ) : (
                            <CompressionCurve
                                thresholdNorm={thrNorm}
                                ratioNorm={ratioNorm}
                                grDb={pseudoGr}
                                accent="var(--token-color-hex-6ac3ff)"
                                variant={variant}
                            />
                        )}
                    </VizCard>
                    <MetaReadout>
                        {metaBlock}
                    </MetaReadout>
                </VizColumn>
                <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-6ac3ff)" show={showDryWet} />
            </PluginSurfaceLayout>
        );
    }

    return null;
}
