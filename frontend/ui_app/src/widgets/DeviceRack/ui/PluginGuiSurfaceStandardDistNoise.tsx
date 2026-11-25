// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Distortion / Noise Plugin Surfaces
// Assembled from PluginModules design system
// ═══════════════════════════════════════════════════════════════════════════
import { clamp01 } from '@/shared/lib/audioMath';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import {
    buildSurfaceKnobParams,
    DryWetSection,
    formatSurfaceParam,
    getDevicePluginKey,
    PLUGIN_TITLE_MAP,
    readSurfaceParam,
    safeParamValue,
    type SurfaceHandlers,
} from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';
import {
    ControlPanel,
    MetaReadout,
    PluginSurfaceLayout,
    SaturationCurve,
    SpectrumBars,
    getPluginSurfaceProps,
    VizCard,
    VizColumn,
    WaveformDisplay,
} from '@/widgets/DeviceRack/ui/PluginModules';

function StandardDistNoiseSurface({
    device,
    handlers,
}: {
    device: DeviceSlot;
    handlers: SurfaceHandlers;
}): React.ReactNode {
    const normalizedInternalId = getDevicePluginKey(device);

    /* ═════════════════════════════════════════════════════════════════ */
    /* DISTORTION / BITCRUSHER                                          */
    /* ═════════════════════════════════════════════════════════════════ */
    if (device.effectType === 'distortion' || device.effectType === 'bitcrusher' || device.effectType === 'overdrive' || device.effectType === 'amp' || device.effectType === 'cabinet' || device.effectType === 'pedal' || device.effectType === 'roar' || device.effectType === 'erosion') {
        const { showDryWet, knobParams } = getPluginSurfaceProps(device);
        const title = device.effectType === 'bitcrusher'
            ? 'Bitcrusher'
            : (PLUGIN_TITLE_MAP[normalizedInternalId] ?? 'Distortion');
        const isAmp = title === 'Amp';
        const isCabinet = title === 'Cabinet';
        const isErosion = title === 'Erosion';
        const isOverdrive = title === 'Overdrive';
        const isPedal = title === 'Pedal';
        const isRoar = title === 'Roar';
        const isDrumBuss = title === 'Drum Buss';
        const isDynamicTube = title === 'Dynamic Tube';
        const isBit = title === 'Bitcrusher';

        /* ── Per-plugin meta readouts ── */
        const metaBlock = (() => {
            if (isAmp) {
                const gain = readSurfaceParam(device, 'gain', 0, 'dB');
                const master = readSurfaceParam(device, 'master', 0, 'dB');
                return (<><span>Gain {formatSurfaceParam(gain)}</span><span>Master {formatSurfaceParam(master)}</span></>);
            }
            if (isCabinet) {
                const micPos = readSurfaceParam(device, 'mic pos', 50, '%');
                return (<><span>Mic {formatSurfaceParam(micPos)}</span></>);
            }
            if (isErosion) {
                const freq = readSurfaceParam(device, 'frequency', 2000, 'Hz');
                const amount = readSurfaceParam(device, 'amount', 0, '%');
                return (<><span>Freq {formatSurfaceParam(freq)}</span><span>Amt {formatSurfaceParam(amount)}</span></>);
            }
            if (isOverdrive || isPedal || isRoar) {
                const drive = readSurfaceParam(device, 'drive', 0, 'dB');
                const tone = readSurfaceParam(device, 'tone', 0, '%');
                return (<><span>Drive {formatSurfaceParam(drive)}</span><span>Tone {formatSurfaceParam(tone)}</span></>);
            }
            if (isDrumBuss) {
                const boom = readSurfaceParam(device, 'boom', 40, '%');
                const drive = readSurfaceParam(device, 'drive', 30, '%');
                return (<><span>Boom {formatSurfaceParam(boom)}</span><span>Drive {formatSurfaceParam(drive)}</span></>);
            }
            if (isDynamicTube) {
                const drive = readSurfaceParam(device, 'drive', 40, '%');
                const bias = readSurfaceParam(device, 'bias', 20, '%');
                return (<><span>Drive {formatSurfaceParam(drive)}</span><span>Bias {formatSurfaceParam(bias)}</span></>);
            }
            if (isBit) {
                const bits = readSurfaceParam(device, 'bits', 16, '');
                const downsample = readSurfaceParam(device, 'downsample', 1, 'x');
                return (<><span>Bits {formatSurfaceParam(bits)}</span><span>↓{formatSurfaceParam(downsample)}</span></>);
            }
            const drive = readSurfaceParam(device, 'drive', 0, 'dB');
            const tone = readSurfaceParam(device, 'tone', 0, '%');
            return (<><span>Drive {formatSurfaceParam(drive)}</span><span>Tone {formatSurfaceParam(tone)}</span></>);
        })();

        /* ── Map plugin type → L2 visualization ── */
        const driveParam = readSurfaceParam(device, 'drive', 3, 'dB');
        const driveNorm = clamp01(Math.max(0, driveParam.value) / 24);

        const vizElement = (() => {
            // Standard Distortion → SaturationCurve (hard clip)
            if (!isAmp && !isCabinet && !isErosion && !isOverdrive && !isPedal && !isRoar && !isDrumBuss && !isDynamicTube && !isBit) {
                return <SaturationCurve drive={driveNorm} type="hard" accent="var(--token-color-hex-ff965e)" />;
            }
            // Amp → SaturationCurve (tube)
            if (isAmp) {
                return <SaturationCurve drive={driveNorm} type="tube" accent="var(--token-color-hex-ffb57a)" />;
            }
            // Cabinet → SpectrumBars (frequency response display)
            if (isCabinet) {
                const cabData = Array.from({ length: 11 }, (_, i) => 0.3 + Math.sin(i * 0.7) * 0.25 + Math.cos(i * 0.5) * 0.15);
                return <SpectrumBars data={cabData} accent="var(--token-color-hex-ffb57a)" />;
            }
            // Erosion → SpectrumBars (noise-like)
            if (isErosion) {
                const erosionData = Array.from({ length: 20 }, (_, i) => 0.16 + ((i * 19) % 60) / 80);
                return <SpectrumBars data={erosionData} accent="var(--token-color-hex-ff965e)" />;
            }
            // Overdrive → SaturationCurve (soft)
            if (isOverdrive) {
                return <SaturationCurve drive={driveNorm} type="soft" accent="var(--token-color-hex-ff965e)" />;
            }
            // Pedal → SaturationCurve (tape)
            if (isPedal) {
                return <SaturationCurve drive={driveNorm} type="tape" accent="var(--token-color-hex-ff965e)" />;
            }
            // Roar → SaturationCurve (fold)
            if (isRoar) {
                return <SaturationCurve drive={driveNorm} type="fold" accent="var(--token-color-hex-ff965e)" />;
            }
            // DrumBuss → WaveformDisplay (bars)
            if (isDrumBuss) {
                const drumData = Array.from({ length: 12 }, (_, i) => 0.16 + ((i * 13) % 60) / 80);
                return <WaveformDisplay data={drumData} accent="var(--token-color-hex-ffac59)" mode="bars" />;
            }
            // DynamicTube → SaturationCurve (tube)
            if (isDynamicTube) {
                return <SaturationCurve drive={driveNorm} type="tube" accent="var(--token-color-hex-ffbc74)" />;
            }
            // Bitcrusher → SpectrumBars (digital step pattern)
            if (isBit) {
                const bitData = Array.from({ length: 14 }, (_, i) => i % 2 === 0 || i % 5 === 0 ? 0.75 : 0.35);
                return <SpectrumBars data={bitData} accent="var(--token-color-hex-f2de72)" />;
            }
            return null;
        })();

        const accentColor = device.effectType === 'distortion' ? 'var(--token-color-hex-ff965e)' : 'var(--token-color-hex-f2de72)';

        return (
            <PluginSurfaceLayout>
                <ControlPanel params={knobParams} handlers={handlers} />
                <VizColumn>
                    <VizCard background="var(--plugin-bg-distortion)">
                        {vizElement}
                    </VizCard>
                    <MetaReadout>
                        {metaBlock}
                    </MetaReadout>
                </VizColumn>
                <DryWetSection device={device} handlers={handlers} accent={accentColor} show={showDryWet} />
            </PluginSurfaceLayout>
        );
    }

    /* ═════════════════════════════════════════════════════════════════ */
    /* NOISE MACHINE — Generator (no Dry/Wet applicable)                */
    /* ═════════════════════════════════════════════════════════════════ */
    if (device.effectType === 'noiseMachine') {
        const type = Math.round(safeParamValue(device, 'type', 0));
        const level = readSurfaceParam(device, 'level', -30, 'dB');
        const NOISE_TYPE_LABELS = ['White', 'Pink', 'Brown', 'Blue', 'Violet', 'Grey'];
        const typeLabel = NOISE_TYPE_LABELS[Math.min(type, 5)] ?? 'White';
        const NOISE_COLORS = ['var(--token-color-hex-c8c8c8)', 'var(--token-color-hex-ffb57a)', 'var(--token-color-hex-c4a870)', 'var(--token-color-hex-7ab6ff)', 'var(--token-color-hex-b48cff)', 'var(--token-color-hex-a8b0bd)'];
        const noiseColor = NOISE_COLORS[Math.min(type, 5)] ?? 'var(--token-color-hex-72d68a)';
        const knobParams = buildSurfaceKnobParams(device, {});

        // Generate noise waveform data — random-looking but deterministic
        const noiseData = Array.from({ length: 40 }, (_, i) =>
            0.15 + Math.abs(Math.sin(i * 3.77 + type * 1.3) * 0.6 + Math.cos(i * 2.13) * 0.25)
        );

        return (
            <PluginSurfaceLayout>
                <ControlPanel params={knobParams} handlers={handlers} />
                <VizColumn>
                    <VizCard background="var(--plugin-bg-noise)">
                        <WaveformDisplay data={noiseData} accent={noiseColor} mode="line" />
                    </VizCard>
                    <MetaReadout>
                        <span>{typeLabel}</span>
                        <span>Level {formatSurfaceParam(level)}</span>
                    </MetaReadout>
                </VizColumn>
            </PluginSurfaceLayout>
        );
    }

    return null;
}

export function renderStandardDistNoiseSurface(
    device: DeviceSlot,
    handlers: SurfaceHandlers,
): React.ReactNode {
    return <StandardDistNoiseSurface device={device} handlers={handlers} />;
}
