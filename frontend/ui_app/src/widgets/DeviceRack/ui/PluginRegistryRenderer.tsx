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
            const grDb = device.pluginMetric && device.pluginMetric > 0
                ? device.pluginMetric
                : 0; // Fallback removed, real GR is now active
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
            const rawGr = device.pluginMetric ?? 0;
            const realGr = rawGr > 0 ? Math.min(24, rawGr) : 0;
            const thrNorm = clamp01((thr + 60) / 60);
            const ratioNorm = clamp01(Math.min(ratio, 20) / 20);
            const thrParam = resolveSurfaceParam(device, thrParamNames);
            return (
                <CompressionCurve
                    thresholdNorm={thrNorm}
                    ratioNorm={ratioNorm}
                    grDb={realGr}
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
    const accent = definition.accent;
    const dryWetAccent = definition.dryWetAccent ?? accent;

    // ── Build enum/toggle sets from settings config ──
    const enumLabels = definition.settingsPanel?.enumLabels ?? {};
    const enumParamSet = useMemo(() => new Set(Object.keys(enumLabels).map(k => k.toLowerCase())), [enumLabels]);
    const toggleParamSet = useMemo(() => new Set((definition.settingsPanel?.toggleParams ?? []).map(k => k.toLowerCase())), [definition.settingsPanel?.toggleParams]);

    // ── ALL params merged (main + settings) — no hidden settings anymore ──
    const allKnobParams = useMemo(() => {
        const raw = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });
        // Filter out enum and toggle params — they render as dropdowns/buttons, not knobs
        return raw.filter(p => !enumParamSet.has(p.name.toLowerCase()) && !toggleParamSet.has(p.name.toLowerCase()));
    }, [device, showDryWet, enumParamSet, toggleParamSet]);

    // ── Enum params (render as inline dropdowns) ──
    const enumParams = useMemo(() => {
        return device.params.filter(p => enumParamSet.has(p.name.toLowerCase()));
    }, [device.params, enumParamSet]);

    // ── Toggle params (render as inline buttons) ──
    const toggleParams = useMemo(() => {
        return device.params.filter(p => toggleParamSet.has(p.name.toLowerCase()));
    }, [device.params, toggleParamSet]);

    // ── Utility layout (vertical, no viz card) ──────────────────────
    if (definition.isUtility) {
        return (
            <div data-no-drag style={{
                display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', height: '100%', padding: 'var(--space-1)',
            }}>
                <KnobParamGrid params={allKnobParams} handlers={handlers} maxCols={2} minCols={2} />
                {definition.buttons && definition.buttons.length > 0 && (
                    <ButtonStrip>
                        {definition.buttons.map((btn) => {
                            const active = getParamValue(device, [btn.paramName], 0) > (btn.threshold ?? 0.5);
                            const isUtilityScene = btn.scene === 'center' || btn.scene === 'mono' || btn.scene === 'wide';
                            return (
                                <ToggleButton
                                    key={btn.paramName}
                                    label={btn.label}
                                    active={active}
                                    onClick={() => {
                                        if (isUtilityScene && btn.scene) {
                                            handlers.onApplyUtilityScene?.(btn.scene as 'center' | 'mono' | 'wide');
                                        } else {
                                            handlers.onParamGestureStart?.(btn.paramName);
                                            handlers.onParamChange(btn.paramName, active ? 0 : 1);
                                            handlers.onParamGestureEnd?.(btn.paramName);
                                        }
                                    }}
                                />
                            );
                        })}
                    </ButtonStrip>
                )}
                {showDryWet && <DryWetSection device={device} handlers={handlers} accent={dryWetAccent} show={showDryWet} />}
            </div>
        );
    }

    // ── Standard layout: ControlPanel | VizCard | DryWet ────────────
    const vizElement = resolveViz(definition.viz, device, accent, handlers);
    const metaSpans = resolveMeta(definition.meta, device);

    return (
        <PluginSurfaceLayout>
            <ControlPanel params={allKnobParams} handlers={handlers}>
                {/* ── Inline enum dropdowns ── */}
                {enumParams.length > 0 && (
                    <div style={{ display: 'grid', gap: 4 }}>
                        {enumParams.map((p) => {
                            const labels = enumLabels[p.name] ?? enumLabels[p.name.toLowerCase()] ?? [];
                            const currentValue = Math.round(p.value ?? 0);
                            return (
                                <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span style={{
                                        fontSize: 'var(--font-size-2xs)',
                                        color: 'var(--color-text-tertiary)',
                                        fontWeight: 600,
                                        minWidth: 36,
                                        textTransform: 'capitalize',
                                    }}>
                                        {p.name}
                                    </span>
                                    <select
                                        value={currentValue}
                                        onChange={(e) => {
                                            handlers.onParamGestureStart?.(p.name);
                                            handlers.onParamChange(p.name, Number(e.target.value));
                                            handlers.onParamGestureEnd?.(p.name);
                                        }}
                                        style={{
                                            flex: 1,
                                            border: 'var(--space-px) solid var(--color-divider)',
                                            borderRadius: 'var(--radius-md)',
                                            background: 'var(--color-bg-header)',
                                            color: 'var(--color-text-primary)',
                                            fontSize: 'var(--font-size-2xs)',
                                            padding: '3px 6px',
                                            outline: 'none',
                                            cursor: 'pointer',
                                        }}
                                    >
                                        {labels.map((label, idx) => (
                                            <option key={idx} value={idx}>{label}</option>
                                        ))}
                                    </select>
                                </div>
                            );
                        })}
                    </div>
                )}
                {/* ── Inline toggle buttons ── */}
                {toggleParams.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {toggleParams.map((p) => {
                            const active = (p.value ?? 0) > 0.5;
                            return (
                                <button
                                    key={p.name}
                                    type="button"
                                    onClick={() => {
                                        handlers.onParamGestureStart?.(p.name);
                                        handlers.onParamChange(p.name, active ? 0 : 1);
                                        handlers.onParamGestureEnd?.(p.name);
                                    }}
                                    style={{
                                        padding: '3px 10px',
                                        borderRadius: 'var(--radius-md)',
                                        border: 'var(--space-px) solid var(--color-divider)',
                                        background: active
                                            ? `color-mix(in srgb, ${accent} 30%, var(--color-bg-elevated))`
                                            : 'var(--color-bg-elevated)',
                                        color: active ? accent : 'var(--color-text-tertiary)',
                                        fontSize: 'var(--font-size-2xs)',
                                        fontWeight: 600,
                                        cursor: 'pointer',
                                        transition: 'background 0.15s ease, color 0.15s ease',
                                        textTransform: 'capitalize',
                                    }}
                                >
                                    {p.name}
                                </button>
                            );
                        })}
                    </div>
                )}
                {/* ── Main-surface buttons (e.g. Delay Sync L/R) ── */}
                {definition.buttons && definition.buttons.length > 0 && (
                    <ButtonStrip>
                        {definition.buttons.map((btn) => {
                            const active = getParamValue(device, [btn.paramName], 0) > (btn.threshold ?? 0.5);
                            const isUtilityScene = btn.scene === 'center' || btn.scene === 'mono' || btn.scene === 'wide';
                            return (
                                <ToggleButton
                                    key={btn.paramName}
                                    label={btn.label}
                                    active={active}
                                    onClick={() => {
                                        if (isUtilityScene && btn.scene) {
                                            handlers.onApplyUtilityScene?.(btn.scene as 'center' | 'mono' | 'wide');
                                        } else {
                                            handlers.onParamGestureStart?.(btn.paramName);
                                            handlers.onParamChange(btn.paramName, active ? 0 : 1);
                                            handlers.onParamGestureEnd?.(btn.paramName);
                                        }
                                    }}
                                />
                            );
                        })}
                    </ButtonStrip>
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

// ── Error Boundary ──────────────────────────────────────────────────────

interface ErrorBoundaryProps {
    effectType: string;
    children: React.ReactNode;
}

interface ErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
}

/** Catches render crashes in UniversalPluginRenderer to prevent the
 *  entire DeviceRack from unmounting on a malformed PluginDefinition. */
export class PluginRendererErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
    constructor(props: ErrorBoundaryProps) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        console.error(`[PluginRenderer] ${this.props.effectType} crashed:`, error, info.componentStack);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div style={{
                    padding: 12,
                    color: 'var(--color-text-secondary)',
                    fontSize: 11,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%',
                    background: 'var(--color-surface-raised)',
                    borderRadius: 'var(--radius-md)',
                }}>
                    ⚠ {this.props.effectType ?? 'Plugin'} — render error
                </div>
            );
        }
        return this.props.children;
    }
}

/**
 * Lookup: effectType → PluginDefinition.
 * Returns null if not found (fallback to hand-crafted surface).
 */
export function lookupPluginDefinition(device: DeviceSlot): PluginDefinition | null {
    if (!device.effectType) return null;
    return PLUGIN_REGISTRY[device.effectType] ?? null;
}
