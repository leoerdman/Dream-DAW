import { SessionIoRow, SessionStripFader } from './DawShellPanelControls';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { dbToMeterNorm } from '@/shared/lib/meterManifest';
import { sessionClipTransportBtnStyle } from './sessionPanelStyles';
import { useEffect, useRef, useState } from 'react';

export function SessionMasterScenes({
    width,
    scenes,
    activeScenes,
    isPlaying,
    launchScene,
    stopScene,
}: {
    width: number;
    scenes: number[];
    activeScenes: Set<number>;
    isPlaying: boolean;
    launchScene: (sceneIndex: number) => void;
    stopScene: (sceneIndex: number) => void;
}) {
    return (
        <div style={{ width, borderLeft: 'var(--space-px) solid var(--color-timeline-grid-line)', background: 'color-mix(in srgb, var(--color-bg-panel) 96%, var(--color-timeline-bg))' }}>
            <div style={{
                height: 28,
                borderBottom: 'var(--space-px) solid var(--color-timeline-grid-bar)',
                background: 'var(--color-bg-header)',
                color: 'var(--color-text-primary)',
                fontSize: 'var(--font-size-sm)',
                fontWeight: 800,
                display: 'flex',
                alignItems: 'center',
                padding: '0 var(--space-2)',
            }}>
                Master
            </div>
            {scenes.map((_, i) => {
                const isActiveScene = activeScenes.has(i) && isPlaying;
                return (
                    <div key={`master-scene-${i}`} style={{ height: 26, borderBottom: 'var(--space-px) solid var(--color-timeline-grid-line)', display: 'flex', alignItems: 'center', padding: '0 var(--space-1)', gap: 4 }}>
                        <button type="button" onClick={() => launchScene(i)} style={sessionClipTransportBtnStyle(isActiveScene)} title={`Launch Scene ${i + 1}`}>▶</button>
                        <button type="button" onClick={() => stopScene(i)} style={sessionClipTransportBtnStyle(false)} title={`Stop Scene ${i + 1}`}>■</button>
                        <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-secondary)' }}>{i + 1}</span>
                    </div>
                );
            })}
        </div>
    );
}

/**
 * PERF-OPT: Subscription-driven master strip meters for session view.
 * Uses RAF coalescing + value equality to avoid ~30fps React re-renders.
 */
export function SessionMasterStrip({
    width,
    masterVolume,
    setMasterVolume,
}: {
    width: number;
    masterVolume: number;
    setMasterVolume: (gain: number) => void | Promise<unknown>;
}) {
    const meterLRef = useRef(0);
    const meterRRef = useRef(0);
    const rafIdRef = useRef(0);
    const mountedRef = useRef(true);
    const lastRef = useRef({ mL: 0, mR: 0 });
    const [, setTick] = useState(0);
    const forceUpdateRef = useRef<() => void>(() => setTick((t) => (t + 1) & 0x7FFFFFFF));
    forceUpdateRef.current = () => setTick((t) => (t + 1) & 0x7FFFFFFF);

    useEffect(() => {
        mountedRef.current = true;
        const unsub = useEngineStore.subscribe((state) => {
            const mL = dbToMeterNorm(state.meters.master_left?.peak ?? -60);
            const mR = dbToMeterNorm(state.meters.master_right?.peak ?? -60);
            const last = lastRef.current;
            if (mL === last.mL && mR === last.mR) return;
            meterLRef.current = mL;
            meterRRef.current = mR;
            lastRef.current = { mL, mR };
            if (rafIdRef.current) return;
            rafIdRef.current = requestAnimationFrame(() => {
                rafIdRef.current = 0;
                if (mountedRef.current) forceUpdateRef.current();
            });
        });
        return () => { mountedRef.current = false; unsub(); if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current); };
    }, []);

    return (
        <div style={{ width, padding: 'var(--space-2) var(--space-1-5) var(--space-1-5)', borderLeft: 'var(--space-px) solid var(--color-timeline-grid-line)', display: 'grid', gridTemplateRows: 'auto auto auto auto 1fr auto', gap: 4, background: 'color-mix(in srgb, var(--color-bg-panel) 96%, var(--color-timeline-bg))' }}>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontWeight: 700 }}>MASTER</div>
            <SessionIoRow label="Audio From" value="All Ins" />
            <SessionIoRow label="Audio To" value="Ext. Out" />
            <SessionIoRow label="Monitor" value="Auto" />
            <SessionStripFader
                gain={masterVolume}
                pan={0}
                meterL={meterLRef.current}
                meterR={meterRRef.current}
                onGainChange={(nextGain) => { void setMasterVolume(nextGain); }}
                onPanChange={() => { }}
                panDisabled
                trackIndex={-1}
                trackDisabled={false}
                trackSolo={false}
                trackArmed={false}
                setTrackDisabled={() => { }}
                setTrackSolo={() => { }}
                setTrackArmed={() => { }}
            />
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-role-data)' }}>Out</div>
        </div>
    );
}
