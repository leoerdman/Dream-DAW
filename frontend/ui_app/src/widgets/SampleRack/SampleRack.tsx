import { memo, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { SampleRackConfig } from '@/shared/types/SampleRackConfig';
import type { SampleRackPadConfig } from '@/shared/types/SampleRackPadConfig';
import * as engineApi from '@/shared/api/engine';
import { useDragStore } from '@/shared/stores/useDragStore';
import { canDropInZone } from '@/shared/lib/dndMatrix';

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
    0: '#ff5c5c', 1: '#ff8c5c', 2: '#ffbf5c', 3: '#8c5cff',
    4: '#5caeff', 5: '#5caeff', 6: '#5ce0a6', 7: '#5caeff',
    8: '#5ce0a6', 9: '#5ce0a6', 10: '#f0c430', 11: '#f0c430',
    12: '#f0c430', 13: '#f0c430', 14: '#cf8ef7', 15: '#cf8ef7',
};

// ── Mini Arc Knob ────────────────────────────────────────────────
const ArcKnob = memo(function ArcKnob({
    value, min, max, label, unit, color, size = 36, onChange, onGestureStart, onGestureEnd,
}: {
    value: number; min: number; max: number; label: string;
    unit?: string; color?: string; size?: number;
    onChange: (v: number) => void;
    onGestureStart?: () => void; onGestureEnd?: () => void;
}) {
    const knobRef = useRef<HTMLDivElement>(null);
    const norm = Math.max(0, Math.min(1, (value - min) / (max - min)));
    const startAngle = -135;
    const endAngle = 135;
    const angle = startAngle + norm * (endAngle - startAngle);
    const r = (size - 6) / 2;
    const cx = size / 2;
    const cy = size / 2;
    const arcColor = color ?? '#5ce0a6';

    // Arc path
    const toRad = (deg: number) => (deg - 90) * Math.PI / 180;
    const x1 = cx + r * Math.cos(toRad(startAngle));
    const y1 = cy + r * Math.sin(toRad(startAngle));
    const x2 = cx + r * Math.cos(toRad(angle));
    const y2 = cy + r * Math.sin(toRad(angle));
    const largeArc = angle - startAngle > 180 ? 1 : 0;
    const arcD = `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;

    // Track arc (full range)
    const xe = cx + r * Math.cos(toRad(endAngle));
    const ye = cy + r * Math.sin(toRad(endAngle));
    const trackD = `M ${x1} ${y1} A ${r} ${r} 0 1 1 ${xe} ${ye}`;

    // Formatted display value
    const displayVal = useMemo(() => {
        if (unit === 'Hz') return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${Math.round(value)}`;
        if (unit === 'ms') return value >= 1 ? `${value.toFixed(1)}s` : `${Math.round(value * 1000)}`;
        if (unit === '%') return `${Math.round(value * 100)}`;
        if (unit === 'dB') return `${value.toFixed(1)}`;
        if (unit === 'pan') return value === 0 ? 'C' : value < 0 ? `L${Math.round(Math.abs(value) * 100)}` : `R${Math.round(value * 100)}`;
        return value >= 100 ? Math.round(value).toString() : value.toFixed(value < 1 ? 2 : 1);
    }, [value, unit]);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onGestureStart?.();
        const startY = e.clientY;
        const startNorm = norm;
        const sensitivity = 200;
        const onMove = (me: MouseEvent) => {
            const dy = startY - me.clientY;
            const newNorm = Math.max(0, Math.min(1, startNorm + dy / sensitivity));
            onChange(min + newNorm * (max - min));
        };
        const onUp = () => {
            onGestureEnd?.();
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [norm, min, max, onChange, onGestureStart, onGestureEnd]);

    return (
        <div
            ref={knobRef}
            onMouseDown={handleMouseDown}
            style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
                cursor: 'ns-resize', userSelect: 'none',
            }}
        >
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                <path d={trackD} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={2.5} strokeLinecap="round" />
                <path d={arcD} fill="none" stroke={arcColor} strokeWidth={2.5} strokeLinecap="round"
                    style={{ filter: `drop-shadow(0 0 3px ${arcColor}44)` }} />
                <circle cx={cx} cy={cy} r={r - 5} fill="rgba(0,0,0,0.4)" stroke="rgba(255,255,255,0.1)" strokeWidth={0.5} />
                <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle"
                    fill="#fff" fontSize={size < 38 ? 8 : 9} fontFamily="var(--font-mono)" fontWeight={600}>
                    {displayVal}
                </text>
            </svg>
            <span style={{
                fontSize: 8, color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase',
                letterSpacing: '0.06em', fontWeight: 600, lineHeight: 1,
            }}>
                {label}
            </span>
        </div>
    );
});

// ── ADSR Envelope Visualizer ─────────────────────────────────────
const AdsrVisualizer = memo(function AdsrVisualizer({ attack, decay, sustain, release }: {
    attack: number; decay: number; sustain: number; release: number;
}) {
    const w = 140, h = 36;
    const totalTime = Math.max(0.01, attack + decay + 0.3 + release);
    const tA = (attack / totalTime) * w;
    const tD = (decay / totalTime) * w;
    const tS = (0.3 / totalTime) * w; // sustain hold segment
    const tR = (release / totalTime) * w;
    const sLevel = h - sustain * (h - 4);
    const path = `M 0 ${h} L ${tA} 4 L ${tA + tD} ${sLevel} L ${tA + tD + tS} ${sLevel} L ${tA + tD + tS + tR} ${h}`;

    return (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ borderRadius: 4, background: 'rgba(0,0,0,0.3)' }}>
            <defs>
                <linearGradient id="adsrFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#5ce0a6" stopOpacity="0.3" />
                    <stop offset="100%" stopColor="#5ce0a6" stopOpacity="0.05" />
                </linearGradient>
            </defs>
            <path d={`${path} L ${w} ${h} L 0 ${h} Z`} fill="url(#adsrFill)" />
            <path d={path} fill="none" stroke="#5ce0a6" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
                style={{ filter: 'drop-shadow(0 0 4px rgba(92, 224, 166, 0.5))' }} />
            {/* ADSR phase markers */}
            <circle cx={tA} cy={4} r={2} fill="#5ce0a6" />
            <circle cx={tA + tD} cy={sLevel} r={2} fill="#5ce0a6" />
            <circle cx={tA + tD + tS} cy={sLevel} r={2} fill="#5ce0a6" opacity={0.5} />
        </svg>
    );
});

// ── Mini Waveform Bar ────────────────────────────────────────────
const PadWaveform = memo(function PadWaveform({ samplePath }: { samplePath: string }) {
    const [peaks, setPeaks] = useState<engineApi.PeakPair[] | null>(null);

    useEffect(() => {
        if (!samplePath) { setPeaks(null); return; }
        let cancelled = false;
        engineApi.getWaveformPeaksBinary(samplePath)
            .then(wf => {
                if (cancelled) return;
                const level = wf.mip_levels[0] ?? wf.mip_levels[wf.mip_levels.length - 1];
                const rawPeaks = level?.peaks ?? [];
                // Downsample to ~20 bars
                const target = 20;
                if (rawPeaks.length <= target) { setPeaks(rawPeaks); return; }
                const reduced: engineApi.PeakPair[] = [];
                const bucket = rawPeaks.length / target;
                for (let i = 0; i < target; i++) {
                    const s = Math.floor(i * bucket);
                    const e = Math.min(rawPeaks.length, Math.max(s + 1, Math.floor((i + 1) * bucket)));
                    let mn = 1, mx = -1;
                    for (let j = s; j < e; j++) { if (rawPeaks[j].min < mn) mn = rawPeaks[j].min; if (rawPeaks[j].max > mx) mx = rawPeaks[j].max; }
                    reduced.push({ min: mn, max: mx });
                }
                setPeaks(reduced);
            })
            .catch(() => { if (!cancelled) setPeaks(null); });
        return () => { cancelled = true; };
    }, [samplePath]);

    if (!peaks || peaks.length === 0) return null;

    const w = 44, h = 18;
    const barW = w / peaks.length;

    return (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ opacity: 0.6 }}>
            {peaks.map((p, i) => {
                const mid = h / 2;
                const yMax = mid - Math.max(-1, Math.min(1, p.max)) * mid;
                const yMin = mid - Math.max(-1, Math.min(1, p.min)) * mid;
                const barH = Math.max(1, yMin - yMax);
                return <rect key={i} x={i * barW} y={yMax} width={Math.max(0.8, barW - 0.3)} height={barH} fill="#5ce0a6" rx={0.3} />;
            })}
        </svg>
    );
});

// ══════════════════════════════════════════════════════════════════
// ██  SAMPLE RACK — Premium 16-Pad Drum Machine                  ██
// ══════════════════════════════════════════════════════════════════

export const SampleRack = memo(function SampleRack({ trackId, rackConfig }: SampleRackProps) {
    const [selectedPad, setSelectedPad] = useState<number>(0);
    const draggingItem = useDragStore(s => s.draggingItem);
    const isDragging = !!draggingItem;
    const canDrop = isDragging ? canDropInZone(draggingItem!, 'sampler-surface').allowed : false;

    const handleDropSample = useCallback(async (padIndex: number, samplePath: string) => {
        try {
            await engineApi.setSampleRackPadSample(trackId, padIndex, samplePath);
        } catch (err) {
            console.error('[SampleRack] Failed to set pad sample:', err);
        }
    }, [trackId]);

    const handleClearPad = useCallback(async (padIndex: number) => {
        try {
            await engineApi.setSampleRackPadSample(trackId, padIndex, '');
        } catch (err) {
            console.error('[SampleRack] Failed to clear pad:', err);
        }
    }, [trackId]);

    const pad: SampleRackPadConfig | undefined = rackConfig.pads[selectedPad];
    const padColor = PAD_COLORS[selectedPad] ?? '#5ce0a6';

    // Param change handlers
    const setVolume = useCallback((v: number) => {
        engineApi.setSampleRackPadVolumeCmd?.(trackId, selectedPad, v).catch(console.error);
    }, [trackId, selectedPad]);

    const setAdsr = useCallback((a: number, d: number, s: number, r: number) => {
        engineApi.setSampleRackPadAdsrCmd?.(trackId, selectedPad, a, d, s, r).catch(console.error);
    }, [trackId, selectedPad]);

    const setFilterCutoff = useCallback((cutoff: number) => {
        engineApi.setSampleRackPadFilterCutoffCmd?.(trackId, selectedPad, cutoff).catch(console.error);
    }, [trackId, selectedPad]);

    const toggleMute = useCallback(() => {
        if (!pad) return;
        engineApi.setSampleRackPadMuteCmd?.(trackId, selectedPad, !pad.is_muted).catch(console.error);
    }, [trackId, selectedPad, pad]);

    const toggleSolo = useCallback(() => {
        if (!pad) return;
        engineApi.setSampleRackPadSoloCmd?.(trackId, selectedPad, !pad.is_soloed).catch(console.error);
    }, [trackId, selectedPad, pad]);

    return (
        <div style={{
            display: 'flex', height: '100%', gap: 0,
            background: 'linear-gradient(180deg, rgba(18, 22, 30, 0.95) 0%, rgba(12, 16, 22, 0.98) 100%)',
            borderRadius: 'var(--radius-lg)',
            border: '1px solid rgba(255, 255, 255, 0.06)',
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
                    const pc = PAD_COLORS[i] ?? '#5ce0a6';

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
                                    ? `2px solid ${pc}`
                                    : canDrop
                                        ? '2px dashed rgba(92, 224, 166, 0.5)'
                                        : '1px solid rgba(255, 255, 255, 0.08)',
                                background: hasSample
                                    ? `linear-gradient(180deg, ${pc}18 0%, ${pc}08 100%)`
                                    : 'rgba(0, 0, 0, 0.25)',
                                cursor: 'pointer',
                                display: 'flex', flexDirection: 'column',
                                alignItems: 'center', justifyContent: 'center',
                                transition: 'border-color 0.15s, background 0.15s, box-shadow 0.15s',
                                boxShadow: isSelected ? `0 0 8px ${pc}33, inset 0 0 12px ${pc}11` : 'none',
                                padding: '2px 3px',
                                minHeight: 0,
                            }}
                        >
                            {/* Pad number */}
                            <span style={{
                                position: 'absolute', top: 2, left: 4,
                                fontSize: 8, color: isSelected ? pc : 'rgba(255,255,255,0.25)',
                                fontWeight: 700, fontFamily: 'var(--font-mono)',
                            }}>
                                {i + 1}
                            </span>

                            {/* Mute/Solo indicators */}
                            {p?.is_muted && (
                                <span style={{
                                    position: 'absolute', top: 2, right: 3,
                                    fontSize: 7, color: '#ff5c5c', fontWeight: 700,
                                }}>M</span>
                            )}
                            {p?.is_soloed && (
                                <span style={{
                                    position: 'absolute', top: 2, right: p?.is_muted ? 12 : 3,
                                    fontSize: 7, color: '#f0c430', fontWeight: 700,
                                }}>S</span>
                            )}

                            {/* Waveform or pad name */}
                            {hasSample ? (
                                <PadWaveform samplePath={p!.sample_path} />
                            ) : null}
                            <span style={{
                                fontSize: hasSample ? 8 : 9, fontWeight: 600,
                                color: hasSample ? '#fff' : 'rgba(255,255,255,0.35)',
                                textAlign: 'center', lineHeight: 1.1,
                                overflow: 'hidden', textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap', maxWidth: '100%', padding: '0 2px',
                            }}>
                                {hasSample ? fileName : PAD_NAMES[i]}
                            </span>
                        </div>
                    );
                })}
            </div>

            {/* ── RIGHT: Pad Detail Panel ── */}
            <div style={{
                flex: 1, minWidth: 200, maxWidth: 280,
                display: 'flex', flexDirection: 'column', gap: 6,
                padding: '8px 10px',
                background: 'rgba(0, 0, 0, 0.15)',
                borderLeft: '1px solid rgba(255, 255, 255, 0.04)',
            }}>
                {/* Header */}
                <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    paddingBottom: 4, borderBottom: `1px solid ${padColor}22`,
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{
                            width: 10, height: 10, borderRadius: 2,
                            background: padColor, boxShadow: `0 0 6px ${padColor}66`,
                        }} />
                        <span style={{
                            fontSize: 12, fontWeight: 700, color: '#fff',
                            fontFamily: 'var(--font-mono)', letterSpacing: '0.02em',
                        }}>
                            PAD {selectedPad + 1}
                        </span>
                    </div>
                    {pad?.sample_path && (
                        <button
                            onClick={() => handleClearPad(selectedPad)}
                            style={{
                                background: 'none', border: '1px solid rgba(255,100,100,0.3)',
                                borderRadius: 4, color: '#ff8080', fontSize: 9, padding: '1px 5px',
                                cursor: 'pointer', fontWeight: 600,
                            }}
                        >×</button>
                    )}
                </div>

                {/* Sample name */}
                <div style={{
                    fontSize: 10, color: pad?.sample_path ? padColor : 'rgba(255,255,255,0.3)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    fontFamily: 'var(--font-mono)',
                }}>
                    {pad?.sample_path ? pad.sample_path.split('/').pop() : 'Drop sample here'}
                </div>

                {pad ? (
                    <>
                        {/* ── Volume / Pan / Mute / Solo Row ── */}
                        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, justifyContent: 'space-between' }}>
                            <ArcKnob value={pad.volume ?? 1} min={0} max={2} label="VOL" color={padColor}
                                onChange={setVolume} size={36} />
                            <ArcKnob value={pad.pan ?? 0} min={-1} max={1} label="PAN" unit="pan" color="#9bc6ff"
                                onChange={(v) => {
                                    // Pan not yet exposed in engine API — show the knob but note it
                                    // We'll set ADSR to include pan when API is available
                                }}
                                size={36} />
                            <div style={{ display: 'flex', gap: 4 }}>
                                <button onClick={toggleMute} style={{
                                    width: 28, height: 20, border: 'none', borderRadius: 4,
                                    background: pad.is_muted ? '#ff5c5c' : 'rgba(255,255,255,0.06)',
                                    color: pad.is_muted ? '#fff' : 'rgba(255,255,255,0.4)',
                                    fontSize: 9, fontWeight: 700, cursor: 'pointer',
                                    transition: 'all 0.1s',
                                }}>M</button>
                                <button onClick={toggleSolo} style={{
                                    width: 28, height: 20, border: 'none', borderRadius: 4,
                                    background: pad.is_soloed ? '#f0c430' : 'rgba(255,255,255,0.06)',
                                    color: pad.is_soloed ? '#000' : 'rgba(255,255,255,0.4)',
                                    fontSize: 9, fontWeight: 700, cursor: 'pointer',
                                    transition: 'all 0.1s',
                                }}>S</button>
                            </div>
                        </div>

                        {/* ── ADSR Section ── */}
                        <div style={{
                            background: 'rgba(0,0,0,0.2)', borderRadius: 6,
                            padding: '5px 6px', border: '1px solid rgba(255,255,255,0.04)',
                        }}>
                            <div style={{
                                fontSize: 8, color: 'rgba(255,255,255,0.3)', fontWeight: 700,
                                letterSpacing: '0.1em', marginBottom: 3,
                            }}>ENVELOPE</div>
                            <AdsrVisualizer
                                attack={pad.attack ?? 0.005}
                                decay={pad.decay ?? 0.1}
                                sustain={pad.sustain ?? 1}
                                release={pad.release ?? 0.1}
                            />
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                                <ArcKnob value={pad.attack ?? 0.005} min={0.001} max={0.5} label="A" unit="ms" color="#5ce0a6" size={32}
                                    onChange={(v) => setAdsr(v, pad.decay ?? 0.1, pad.sustain ?? 1, pad.release ?? 0.1)} />
                                <ArcKnob value={pad.decay ?? 0.1} min={0.01} max={2} label="D" unit="ms" color="#5ce0a6" size={32}
                                    onChange={(v) => setAdsr(pad.attack ?? 0.005, v, pad.sustain ?? 1, pad.release ?? 0.1)} />
                                <ArcKnob value={pad.sustain ?? 1} min={0} max={1} label="S" unit="%" color="#5ce0a6" size={32}
                                    onChange={(v) => setAdsr(pad.attack ?? 0.005, pad.decay ?? 0.1, v, pad.release ?? 0.1)} />
                                <ArcKnob value={pad.release ?? 0.1} min={0.01} max={3} label="R" unit="ms" color="#5ce0a6" size={32}
                                    onChange={(v) => setAdsr(pad.attack ?? 0.005, pad.decay ?? 0.1, pad.sustain ?? 1, v)} />
                            </div>
                        </div>

                        {/* ── Filter Section ── */}
                        <div style={{
                            background: 'rgba(0,0,0,0.2)', borderRadius: 6,
                            padding: '5px 6px', border: '1px solid rgba(255,255,255,0.04)',
                            display: 'flex', alignItems: 'center', gap: 8,
                        }}>
                            <div style={{
                                fontSize: 8, color: 'rgba(255,255,255,0.3)', fontWeight: 700,
                                letterSpacing: '0.1em', writingMode: 'vertical-lr',
                                transform: 'rotate(180deg)',
                            }}>FILTER</div>
                            <ArcKnob
                                value={pad.filter_cutoff ?? 20000} min={20} max={20000}
                                label="CUTOFF" unit="Hz" color="#ffbf5c" size={40}
                                onChange={setFilterCutoff}
                            />
                            {/* Mini filter curve */}
                            <svg width={60} height={28} viewBox="0 0 60 28" style={{ opacity: 0.5 }}>
                                <path
                                    d={(() => {
                                        const fc = Math.max(20, Math.min(20000, pad.filter_cutoff ?? 20000));
                                        const norm = (Math.log10(fc) - Math.log10(20)) / (Math.log10(20000) - Math.log10(20));
                                        const cutX = norm * 60;
                                        return `M 0 4 L ${Math.max(0, cutX - 8)} 4 Q ${cutX} 4 ${cutX} 14 Q ${cutX} 26 ${Math.min(60, cutX + 8)} 26 L 60 26`;
                                    })()}
                                    fill="none" stroke="#ffbf5c" strokeWidth={1.5} strokeLinecap="round"
                                />
                            </svg>
                        </div>
                    </>
                ) : (
                    <div style={{
                        fontSize: 11, color: 'rgba(255,255,255,0.3)', textAlign: 'center',
                        marginTop: 20, fontStyle: 'italic',
                    }}>
                        Select a pad
                    </div>
                )}
            </div>
        </div>
    );
});
