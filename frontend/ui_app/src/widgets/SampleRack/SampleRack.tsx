import { memo, useState, useCallback } from 'react';
import type { SampleRackConfig } from '@bindings/SampleRackConfig';
import type { SampleRackPadConfig } from '@bindings/SampleRackPadConfig';
import * as engineApi from '@/shared/api/engine';
import { useDragStore } from '@/shared/stores/useDragStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { canDropInZone } from '@/shared/lib/dndMatrix';
import { PluginKnob } from '@/widgets/DeviceRack/StandardPluginControls';
import { errorMessage } from '@/widgets/DeviceRack/model/deviceRackCatalog';
import { PadWaveform } from '@/widgets/SampleRack/PadWaveform';
interface SampleRackProps {
    trackId: string;
    rackConfig: SampleRackConfig;
    onParamChange?: (paramName: string, value: number) => void;
}
const PAD_NAMES = [
    'Kick', 'Snare', 'Clap', 'Sub',
    'Tom Lo', 'Tom Mid', 'CH', 'Tom Hi',
    'PH', 'OH', 'Ride', 'Crash',
    'Crash 2', 'Bell', 'Perc 1', 'Perc 2',
];
// Pad color groups (GM drum map style)
const PAD_COLORS: Record<number, string> = {
    0: 'var(--token-color-hex-ff5c5c)', 1: 'var(--token-color-hex-ff8c5c)', 2: 'var(--token-color-hex-ffbf5c)', 3: 'var(--token-color-hex-8c5cff)',
    4: 'var(--token-color-hex-5caeff)', 5: 'var(--token-color-hex-5caeff)', 6: 'var(--token-color-hex-5ce0a6)', 7: 'var(--token-color-hex-5caeff)',
    8: 'var(--token-color-hex-5ce0a6)', 9: 'var(--token-color-hex-5ce0a6)', 10: 'var(--token-color-hex-f0c430)', 11: 'var(--token-color-hex-f0c430)',
    12: 'var(--token-color-hex-f0c430)', 13: 'var(--token-color-hex-f0c430)', 14: 'var(--token-color-hex-cf8ef7)', 15: 'var(--token-color-hex-cf8ef7)',
};
export const SampleRack = memo(function SampleRack({ trackId, rackConfig }: SampleRackProps) {
    const [selectedPad, setSelectedPad] = useState<number>(0);
    const statusError = useStatusStore((s) => s.setError);
    const statusClear = useStatusStore((s) => s.clear);
    const draggingItem = useDragStore(s => s.draggingItem);
    const isDragging = !!draggingItem;
    const canDrop = isDragging ? canDropInZone(draggingItem!, 'sampler-surface').allowed : false;
    const reportRackError = useCallback((action: string, err: unknown) => {
        statusError(`Sample Rack: ${action}: ${errorMessage(err)}`);
    }, [statusError]);
    const handleDropSample = useCallback(async (padIndex: number, samplePath: string) => {
        try {
            const response = await engineApi.setSampleRackPadSampleWithDeltas(trackId, padIndex, samplePath);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'sample-rack:drop-sample');
            statusClear();
        } catch (err) {
            reportRackError('failed to set pad sample', err);
        }
    }, [trackId, reportRackError, statusClear]);
    const handleClearPad = useCallback(async (padIndex: number) => {
        try {
            const response = await engineApi.setSampleRackPadSampleWithDeltas(trackId, padIndex, '');
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'sample-rack:clear-sample');
            statusClear();
        } catch (err) {
            reportRackError('failed to clear pad', err);
        }
    }, [trackId, reportRackError, statusClear]);
    const pad: SampleRackPadConfig | undefined = rackConfig.pads[selectedPad];
    const setVolume = useCallback((v: number) => {
        void engineApi.setSampleRackPadVolumeCmd?.(trackId, selectedPad, v)
            ?.catch((err) => reportRackError('failed to set volume', err));
    }, [trackId, selectedPad, reportRackError]);
    const setAdsr = useCallback((a: number, d: number, s: number, r: number) => {
        void engineApi.setSampleRackPadAdsrCmd?.(trackId, selectedPad, a, d, s, r)
            ?.catch((err) => reportRackError('failed to set ADSR', err));
    }, [trackId, selectedPad, reportRackError]);
    const setFilterCutoff = useCallback((cutoff: number) => {
        void engineApi.setSampleRackPadFilterCutoffCmd?.(trackId, selectedPad, cutoff)
            ?.catch((err) => reportRackError('failed to set filter cutoff', err));
    }, [trackId, selectedPad, reportRackError]);
    const toggleMute = useCallback(() => {
        if (!pad) return;
        void engineApi.setSampleRackPadMuteCmd?.(trackId, selectedPad, !pad.is_muted)
            ?.catch((err) => reportRackError('failed to toggle mute', err));
    }, [trackId, selectedPad, pad, reportRackError]);
    const toggleSolo = useCallback(() => {
        if (!pad) return;
        void engineApi.setSampleRackPadSoloCmd?.(trackId, selectedPad, !pad.is_soloed)
            ?.catch((err) => reportRackError('failed to toggle solo', err));
    }, [trackId, selectedPad, pad, reportRackError]);
    return (
        <div style={{
            display: 'flex', height: '100%', gap: 0,
            background: 'var(--surface-tab-inactive)',
            borderRadius: 'var(--radius-lg)',
            border: 'none',
            overflow: 'hidden',
        }}>
            {/* ── LEFT: 4×4 Pad Grid ── */}
            <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gridTemplateRows: 'repeat(4, 1fr)',
                gap: 3, padding: 8, flex: '0 0 auto', width: 220,
            }}>
                {Array.from({ length: 16 }).map((_, rIdx) => {
                    const row = 3 - Math.floor(rIdx / 4);
                    const col = rIdx % 4;
                    const i = row * 4 + col;
                    const p = rackConfig.pads[i];
                    const isSelected = selectedPad === i;
                    const hasSample = !!p?.sample_path;
                    const fileName = p?.sample_path?.split('/').pop()?.replace(/\.[^.]+$/, '') || '';
                    const pc = PAD_COLORS[i] ?? 'var(--token-color-hex-5ce0a6)';
                    return (
                        <div
                            key={i}
                            onClick={() => setSelectedPad(i)}
                            onMouseUp={() => {
                                const drag = useDragStore.getState().draggingItem;
                                if (drag?.path && canDropInZone(drag, 'sampler-surface').allowed) {
                                    handleDropSample(i, drag.path);
                                    useDragStore.getState().endDrag();
                                }
                            }}
                            style={{
                                position: 'relative', overflow: 'hidden',
                                borderRadius: 6,
                                border: isSelected
                                    ? `var(--space-0-5) solid ${pc}`
                                    : canDrop
                                        ? 'var(--space-0-5) dashed var(--color-success)'
                                        : 'var(--space-px) solid var(--color-divider)',
                                background: hasSample
                                    ? `color-mix(in srgb, ${pc} 15%, transparent)`
                                    : 'var(--color-bg-muted)',
                                cursor: 'pointer',
                                display: 'flex', flexDirection: 'column',
                                alignItems: 'center', justifyContent: 'center',
                                transition: 'var(--transition-fast)',
                                boxShadow: 'none',
                                padding: 'var(--space-0-5) var(--token-size-px-3)',
                                minHeight: 0,
                            }}
                        >
                            {/* Pad number */}
                            <span style={{
                                position: 'absolute', top: 2, left: 4,
                                fontSize: 8, color: isSelected ? pc : 'var(--token-color-rgba-255-255-255-0d25)',
                                fontWeight: 700, fontFamily: 'var(--font-role-data)',
                            }}>
                                {i + 1}
                            </span>
                            {/* Mute/Solo indicators */}
                            {p?.is_muted && (
                                <span style={{
                                    position: 'absolute', top: 2, right: 3,
                                    fontSize: 7, color: 'var(--token-color-hex-ff5c5c)', fontWeight: 700,
                                }}>M</span>
                            )}
                            {p?.is_soloed && (
                                <span style={{
                                    position: 'absolute', top: 2, right: p?.is_muted ? 12 : 3,
                                    fontSize: 7, color: 'var(--token-color-hex-f0c430)', fontWeight: 700,
                                }}>S</span>
                            )}
                            {/* Waveform or pad name */}
                            {hasSample && p?.sample_path ? (
                                <PadWaveform samplePath={p.sample_path} />
                            ) : null}
                            <span style={{
                                fontSize: hasSample ? 8 : 9, fontWeight: 600,
                                color: hasSample ? 'var(--token-color-hex-ffffff)' : 'var(--token-color-rgba-255-255-255-0d35)',
                                textAlign: 'center', lineHeight: 1.1,
                                overflow: 'hidden', textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap', maxWidth: '100%', padding: '0 var(--space-0-5)',
                            }}>
                                {hasSample ? fileName : PAD_NAMES[i]}
                            </span>
                        </div>
                    );
                })}
            </div>
            {/* ── RIGHT: Pad Detail Panel (Sampler UI) ── */}
            <div style={{
                flex: 1, minWidth: 0,
                display: 'grid', gridTemplateRows: 'var(--token-size-px-102) auto',
                gap: 4, padding: 4,
                background: 'var(--token-color-rgba-0-0-0-0d15)',
                borderLeft: 'var(--space-px) solid var(--token-color-rgba-255-255-255-0d04)',
            }}>
                {pad ? (
                    <>
                        {/* Waveform View */}
                        <div style={{
                            position: 'relative', overflow: 'hidden',
                            borderBottom: 'var(--space-px) solid var(--color-divider)',
                            background: 'var(--surface-tab-inactive)',
                            borderRadius: 'var(--space-1) var(--space-1) 0 0',
                        }}>
                            <div style={{
                                position: 'absolute', inset: 0,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                opacity: 0.5,
                            }}>
                                {/* Here we could render a real large waveform. For now, just stretch the mini one or show placeholder */}
                                {pad.sample_path ? (
                                    <div style={{ transform: 'scale(3)', opacity: 0.5 }}>
                                        <PadWaveform samplePath={pad.sample_path} />
                                    </div>
                                ) : (
                                    <span style={{ fontSize: 10, color: 'var(--token-color-rgba-255-255-255-0d3)', fontFamily: 'var(--font-role-data)' }}>
                                        NO SAMPLE LOADED
                                    </span>
                                )}
                            </div>
                            <div style={{
                                position: 'absolute', top: 6, left: 8,
                                color: 'var(--token-color-hex-e0e0e0)', fontSize: 10, fontWeight: 700,
                                fontFamily: 'var(--font-role-data)', letterSpacing: 'var(--letter-spacing-wide)'
                            }}>
                                PAD {selectedPad + 1}
                            </div>
                            <div style={{
                                position: 'absolute', bottom: 4, left: 8, right: 8,
                                color: pad.sample_path ? 'var(--token-color-hex-5ce0a6)' : 'var(--token-color-rgba-255-255-255-0d4)',
                                fontSize: 10, fontFamily: 'var(--font-role-data)',
                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                            }}>
                                {pad.sample_path ? pad.sample_path.split('/').pop() : 'Drop sample here'}
                            </div>
                            {pad.sample_path && (
                                <button
                                    onClick={() => handleClearPad(selectedPad)}
                                    style={{
                                        position: 'absolute', top: 4, right: 8,
                                        background: 'var(--token-color-rgba-255-100-100-0d15)', border: 'var(--space-px) solid var(--token-color-rgba-255-100-100-0d3)',
                                        borderRadius: 4, color: 'var(--token-color-hex-ff8080)', fontSize: 9, padding: 'var(--space-0-5) var(--space-1-5)',
                                        cursor: 'pointer', fontWeight: 600,
                                    }}
                                >
                                    CLEAR
                                </button>
                            )}
                        </div>
                        {/* Knobs Grid */}
                        <div style={{
                            display: 'flex', flexWrap: 'wrap', gap: 8,
                            padding: 'var(--space-2) var(--space-1)',
                            alignItems: 'flex-start',
                        }}>
                            <PluginKnob param={{ name: 'Vol', value: pad.volume ?? 1, min: 0, max: 2, suffix: '', step: 0.01 }}
                                compact onChange={(_, v) => setVolume(v)} />
                            <PluginKnob param={{ name: 'Pan', value: pad.pan ?? 0, min: -1, max: 1, suffix: '', step: 0.01 }}
                                compact onChange={() => { /* Pan not implemented in engine yet */ }} />
                            <PluginKnob param={{ name: 'Attack', value: pad.attack ?? 0.005, min: 0.001, max: 2, suffix: 's', step: 0.001 }}
                                compact onChange={(_, v) => setAdsr(v, pad.decay ?? 0.1, pad.sustain ?? 1, pad.release ?? 0.1)} />
                            <PluginKnob param={{ name: 'Decay', value: pad.decay ?? 0.1, min: 0.001, max: 4, suffix: 's', step: 0.001 }}
                                compact onChange={(_, v) => setAdsr(pad.attack ?? 0.005, v, pad.sustain ?? 1, pad.release ?? 0.1)} />
                            <PluginKnob param={{ name: 'Sustain', value: pad.sustain ?? 1, min: 0, max: 1, suffix: '', step: 0.01 }}
                                compact onChange={(_, v) => setAdsr(pad.attack ?? 0.005, pad.decay ?? 0.1, v, pad.release ?? 0.1)} />
                            <PluginKnob param={{ name: 'Release', value: pad.release ?? 0.05, min: 0.001, max: 8, suffix: 's', step: 0.001 }}
                                compact onChange={(_, v) => setAdsr(pad.attack ?? 0.005, pad.decay ?? 0.1, pad.sustain ?? 1, v)} />
                            <PluginKnob param={{ name: 'Cutoff', value: pad.filter_cutoff ?? 20000, min: 20, max: 20000, suffix: 'Hz', step: 1 }}
                                compact onChange={(_, v) => setFilterCutoff(v)} />
                            {/* Mute/Solo */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginLeft: 'auto', marginRight: 8, alignSelf: 'center' }}>
                                <button onClick={toggleMute} style={{
                                    width: 32, height: 20, border: pad.is_muted ? 'var(--space-px) solid var(--token-color-hex-ff5c5c)' : 'var(--space-px) solid var(--token-color-rgba-255-255-255-0d1)',
                                    borderRadius: 4, background: pad.is_muted ? 'var(--token-color-rgba-255-92-92-0d2)' : 'var(--token-color-rgba-0-0-0-0d2)',
                                    color: pad.is_muted ? 'var(--token-color-hex-ff5c5c)' : 'var(--token-color-rgba-255-255-255-0d4)',
                                    fontSize: 9, fontWeight: 700, cursor: 'pointer', transition: 'all 0.1s', fontFamily: 'var(--font-role-data)'
                                }}>MUTE</button>
                                <button onClick={toggleSolo} style={{
                                    width: 32, height: 20, border: pad.is_soloed ? 'var(--space-px) solid var(--token-color-hex-f0c430)' : 'var(--space-px) solid var(--token-color-rgba-255-255-255-0d1)',
                                    borderRadius: 4, background: pad.is_soloed ? 'var(--token-color-rgba-240-196-48-0d2)' : 'var(--token-color-rgba-0-0-0-0d2)',
                                    color: pad.is_soloed ? 'var(--token-color-hex-f0c430)' : 'var(--token-color-rgba-255-255-255-0d4)',
                                    fontSize: 9, fontWeight: 700, cursor: 'pointer', transition: 'all 0.1s', fontFamily: 'var(--font-role-data)'
                                }}>SOLO</button>
                            </div>
                        </div>
                    </>
                ) : (
                    <div style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        height: '100%', fontSize: 11, color: 'var(--token-color-rgba-255-255-255-0d3)',
                        fontFamily: 'var(--font-role-data)', fontStyle: 'italic',
                    }}>
                        SELECT A PAD
                    </div>
                )}
            </div>
        </div>
    );
});
