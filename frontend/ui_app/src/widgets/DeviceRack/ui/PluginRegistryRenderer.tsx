// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Plugin Registry Renderer
// Universal renderer that reads PluginDefinition and assembles UI modules
// ═══════════════════════════════════════════════════════════════════════════

import React, { useMemo } from 'react';
import { clamp01 } from '@/shared/lib/audioMath';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import {
    buildSurfaceKnobParams,
    DryWetSection,
    formatSurfaceParam,
    getParamValue,
    KnobParamGrid,
    readSurfaceParam,
    resolveSurfaceParam,
    safeParamValue,
    shouldShowDryWet,
    type SurfaceHandlers,
} from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';
import {
    ButtonStrip,
    CompressionCurve,
    ControlPanel,
    GainReductionMeter,
    MetaReadout,
    MiniFilterEq,
    ModulationWave,
    PluginSurfaceLayout,
    SaturationCurve,
    SettingsPanel,
    SpectrumBars,
    ToggleButton,
    VizCard,
    VizColumn,
    WaveformDisplay,
} from '@/widgets/DeviceRack/ui/PluginModules';
import { PLUGIN_REGISTRY } from '@/widgets/DeviceRack/ui/PluginRegistryData';
import type { MetaParamDescriptor, PluginDefinition, VizConfig } from '@/widgets/DeviceRack/ui/PluginRegistryTypes';

// ── Helpers ──────────────────────────────────────────────────────────────

function freqToNorm(hz: number): number {
    return clamp01(Math.log2(Math.max(20, hz) / 20) / Math.log2(20000 / 20));
}

/** Denormalize log frequency norm → Hz */
function normToHz(n: number): number {
    return 20 * Math.pow(1000, clamp01(n));
}

/** Resolve VizConfig → React element with interactive callbacks. */
function resolveViz(
    viz: VizConfig,
    device: DeviceSlot,
    accent: string,
    handlers: SurfaceHandlers,
): React.ReactNode {
    switch (viz.type) {
        case 'modulationWave': {
            const rateRaw = safeParamValue(device, viz.rateParam ?? 'rate', viz.rateFallback ?? 1);
            const depthRaw = safeParamValue(device, viz.depthParam ?? 'depth', viz.depthFallback ?? 50);
            const rateNorm = clamp01(Math.min(rateRaw, viz.rateMax ?? 10) / (viz.rateMax ?? 10));
            const depthNorm = clamp01(depthRaw / (viz.depthMax ?? 100));
            return <ModulationWave rate={rateNorm} depth={depthNorm} shape={viz.waveShape ?? 'sine'} accent={accent} />;
        }
        case 'saturationCurve': {
            const driveParamNames = viz.driveParam ?? 'drive';
            const driveRaw = safeParamValue(device, driveParamNames, viz.driveFallback ?? 3);
            const driveMax = viz.driveMax ?? 24;
            const driveNorm = clamp01(Math.max(0, driveRaw) / driveMax);
            const driveParam = resolveSurfaceParam(device, driveParamNames);
            return (
                <SaturationCurve
                    drive={driveNorm}
                    type={viz.satType ?? 'soft'}
                    accent={accent}
                    onDriveChange={driveParam ? (normDrive: number) => {
                        handlers.onParamChange(driveParam.name, normDrive * driveMax);
                    } : undefined}
                    onGestureStart={driveParam ? () => handlers.onParamGestureStart?.(driveParam.name) : undefined}
                    onGestureEnd={driveParam ? () => handlers.onParamGestureEnd?.(driveParam.name) : undefined}
                />
            );
        }
        case 'miniFilterEq': {
            const hpHz = safeParamValue(device, viz.hpParam ?? 'hp', viz.hpFallback ?? 200);
            const lpHz = safeParamValue(device, viz.lpParam ?? 'lp', viz.lpFallback ?? 8000);
            const hpParam = resolveSurfaceParam(device, viz.hpParam ?? 'hp');
            const lpParam = resolveSurfaceParam(device, viz.lpParam ?? 'lp');
            return (
                <MiniFilterEq
                    hpFreqNorm={freqToNorm(hpHz)}
                    lpFreqNorm={freqToNorm(lpHz)}
                    accentHp={accent}
                    accentLp={accent}
                    onFreqChange={(handle, normFreq) => {
                        const param = handle === 'hp' ? hpParam : lpParam;
                        if (param) handlers.onParamChange(param.name, normToHz(normFreq));
                    }}
                    onGestureStart={(handle) => {
                        const param = handle === 'hp' ? hpParam : lpParam;
                        if (param) handlers.onParamGestureStart?.(param.name);
                    }}
                    onGestureEnd={(handle) => {
                        const param = handle === 'hp' ? hpParam : lpParam;
                        if (param) handlers.onParamGestureEnd?.(param.name);
                    }}
                />
            );
        }
        case 'gainReductionMeter': {
            const thrDb = Math.abs(safeParamValue(device, 'thr', -0.3));
            const grDb = Math.max(0, thrDb * 0.8);
            return (
                <div style={{ display: 'flex', height: '100%', gap: 6, padding: 6 }}>
                    <div style={{ flex: 1 }}>
                        <GainReductionMeter grDb={grDb} maxDb={24} orientation={viz.grOrientation ?? 'horizontal'} />
                    </div>
                </div>
            );
        }
        case 'compressionCurve': {
            const thrParamNames = viz.thrParam ?? 'thr';
            const thr = safeParamValue(device, thrParamNames, viz.thrFallback ?? -18);
            const ratio = safeParamValue(device, viz.ratioParam ?? 'ratio', viz.ratioFallback ?? 4);
            const rawGr = Number.isFinite(device.vuLevel) ? Math.abs(device.vuLevel!) : 0;
            const pseudoGr = rawGr > 0 ? Math.min(24, rawGr) : Math.min(24, ((-thr) / 60) * ratio * 2.4);
            const thrNorm = clamp01((thr + 60) / 60);
            const ratioNorm = clamp01(Math.min(ratio, 20) / 20);
            const thrParam = resolveSurfaceParam(device, thrParamNames);
            return (
                <CompressionCurve
                    thresholdNorm={thrNorm}
                    ratioNorm={ratioNorm}
                    grDb={pseudoGr}
                    accent={accent}
                    variant={viz.compVariant ?? 'standard'}
                    onThresholdChange={thrParam ? (normThr: number) => {
                        handlers.onParamChange(thrParam.name, normThr * 60 - 60);
                    } : undefined}
                    onGestureStart={thrParam ? () => handlers.onParamGestureStart?.(thrParam.name) : undefined}
                    onGestureEnd={thrParam ? () => handlers.onParamGestureEnd?.(thrParam.name) : undefined}
                />
            );
        }
        case 'spectrumBars': {
            const data = viz.staticDataGenerator?.(device);
            return <SpectrumBars data={data} barCount={viz.barCount ?? data?.length ?? 16} accent={accent} />;
        }
        case 'waveformDisplay': {
            const data = viz.staticDataGenerator?.(device) ?? [];
            return <WaveformDisplay data={data} accent={accent} mode={viz.waveMode ?? 'bars'} />;
        }
        default:
            return null;
    }
}

/** Resolve MetaParamDescriptors → formatted spans. */
function resolveMeta(
    metaDescs: MetaParamDescriptor[],
    device: DeviceSlot,
): React.ReactNode[] {
    return metaDescs.map((desc, i) => {
        // Noise: type → label
        if (device.effectType === 'noiseMachine' && desc.paramNames === 'type') {
            const type = Math.round(safeParamValue(device, 'type', 0));
            const LABELS = ['White', 'Pink', 'Brown', 'Blue', 'Violet', 'Grey'];
            return <span key={i}>{LABELS[Math.min(type, 5)] ?? 'White'}</span>;
        }
        // Stages suffix
        if (desc.suffix === ' stages') {
            const val = Math.round(safeParamValue(device, desc.paramNames, desc.fallback));
            return <span key={i}>{val}{desc.suffix}</span>;
        }
        const param = readSurfaceParam(device, desc.paramNames, desc.fallback, desc.suffix);
        return <span key={i}>{desc.label ? `${desc.label} ` : ''}{formatSurfaceParam(param)}</span>;
    });
}

/**
 * Resolve settings panel params — filter device.params by the settings config.
 */
function resolveSettingsParams(
    device: DeviceSlot,
    settingsParamNames: string[],
): DeviceSlot['params'] {
    const nameSet = new Set(settingsParamNames.map(n => n.toLowerCase()));
    return device.params.filter(p => nameSet.has(p.name.toLowerCase()));
}

// ═══════════════════════════════════════════════════════════════════════════
// UNIVERSAL PLUGIN RENDERER
// ═══════════════════════════════════════════════════════════════════════════

export const UniversalPluginRenderer = React.memo(function UniversalPluginRenderer({
    device,
    handlers,
    definition,
}: {
    device: DeviceSlot;
    handlers: SurfaceHandlers;
    definition: PluginDefinition;
}) {
    const showDryWet = shouldShowDryWet(device);
    const knobParams = useMemo(
        () => buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet }),
        [device, showDryWet],
    );
    const accent = definition.accent;
    const dryWetAccent = definition.dryWetAccent ?? accent;

    // Resolve settings panel params
    const settingsParams = useMemo(
        () => definition.settingsPanel
            ? resolveSettingsParams(device, definition.settingsPanel.params)
            : [],
        [device, definition.settingsPanel],
    );

    // ── Utility layout (vertical, no viz card) ──────────────────────
    if (definition.isUtility) {
        return (
            <div data-no-drag style={{
                display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', height: '100%', padding: 'var(--space-1)',
            }}>
                <KnobParamGrid params={knobParams} handlers={handlers} maxCols={2} minCols={2} />
                {definition.buttons && definition.buttons.length > 0 && (
                    <ButtonStrip>
                        {definition.buttons.map((btn) => {
                            const active = getParamValue(device, [btn.paramName], 0) > (btn.threshold ?? 0.5);
                            return (
                                <ToggleButton
                                    key={btn.paramName}
                                    label={btn.label}
                                    active={active}
                                    onClick={() => btn.scene && handlers.onApplyUtilityScene?.(btn.scene)}
                                />
                            );
                        })}
                    </ButtonStrip>
                )}
                {showDryWet && <DryWetSection device={device} handlers={handlers} accent={dryWetAccent} show={showDryWet} />}
            </div>
        );
    }

    // ── Standard EQ-style layout ────────────────────────────────────
    const vizElement = resolveViz(definition.viz, device, accent, handlers);
    const metaSpans = resolveMeta(definition.meta, device);

    return (
        <PluginSurfaceLayout>
            <ControlPanel params={knobParams} handlers={handlers}>
                {/* Settings panel sits below knob grid inside ControlPanel */}
                {settingsParams.length > 0 && (
                    <SettingsPanel
                        params={settingsParams}
                        handlers={handlers}
                        maxCols={definition.settingsPanel?.maxCols ?? 3}
                        accent={accent}
                    />
                )}
            </ControlPanel>
            <VizColumn>
                <VizCard background={definition.background}>
                    {vizElement}
                </VizCard>
                {metaSpans.length > 0 && (
                    <MetaReadout>
                        {metaSpans}
                    </MetaReadout>
                )}
            </VizColumn>
            <DryWetSection device={device} handlers={handlers} accent={dryWetAccent} show={showDryWet} />
        </PluginSurfaceLayout>
    );
});

/**
 * Lookup: effectType → PluginDefinition.
 * Returns null if not found (fallback to hand-crafted surface).
 */
export function lookupPluginDefinition(device: DeviceSlot): PluginDefinition | null {
    if (!device.effectType) return null;
    return PLUGIN_REGISTRY[device.effectType] ?? null;
}
