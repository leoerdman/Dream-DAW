import { SessionIoRow, SessionSendRow, SessionStripFader, sessionClipTransportBtnStyle } from './DawShellPanelControls';

export function SessionMasterScenes({
    width,
    scenes,
    activeSceneIndex,
    isPlaying,
    launchScene,
    stopScene,
}: {
    width: number;
    scenes: number[];
    activeSceneIndex: number | null;
    isPlaying: boolean;
    launchScene: (sceneIndex: number) => void;
    stopScene: (sceneIndex: number) => void;
}) {
    return (
        <div style={{ width, borderLeft: 'var(--space-px) solid var(--color-divider)', background: 'var(--color-bg-panel)' }}>
            <div style={{
                height: 28,
                borderBottom: 'var(--space-px) solid var(--color-overlay-medium)',
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
                const isActiveScene = activeSceneIndex === i && isPlaying;
                return (
                    <div key={`master-scene-${i}`} style={{ height: 26, borderBottom: 'var(--space-px) solid var(--token-color-hex-2a2a2a)', display: 'flex', alignItems: 'center', padding: '0 var(--space-1)', gap: 4 }}>
                        <button type="button" onClick={() => launchScene(i)} style={sessionClipTransportBtnStyle(isActiveScene)} title={`Launch Scene ${i + 1}`}>▶</button>
                        <button type="button" onClick={() => stopScene(i)} style={sessionClipTransportBtnStyle(false)} title={`Stop Scene ${i + 1}`}>■</button>
                        <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-secondary)' }}>{i + 1}</span>
                    </div>
                );
            })}
        </div>
    );
}

export function SessionMasterStrip({
    width,
    masterVolume,
    masterLevelL,
    masterLevelR,
    setMasterVolume,
}: {
    width: number;
    masterVolume: number;
    masterLevelL: number;
    masterLevelR: number;
    setMasterVolume: (gain: number) => void | Promise<unknown>;
}) {
    return (
        <div style={{ width, padding: 'var(--space-2) var(--space-1-5) var(--space-1-5)', borderLeft: 'var(--space-px) solid var(--token-color-hex-3b3b3b)', display: 'grid', gridTemplateRows: 'auto auto auto auto auto 1fr auto', gap: 4 }}>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontWeight: 700 }}>MASTER</div>
            <SessionIoRow label="Audio From" value="All Ins" />
            <SessionIoRow label="Audio To" value="Ext. Out" />
            <SessionIoRow label="Monitor" value="Auto" />
            <SessionSendRow sendA={0} sendB={0} onChangeA={() => { }} onChangeB={() => { }} disabled />
            <SessionStripFader
                gain={masterVolume}
                pan={0}
                meterL={masterLevelL}
                meterR={masterLevelR}
                onGainChange={(nextGain) => { void setMasterVolume(nextGain); }}
                onPanChange={() => { }}
                panDisabled
            />
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>Out</div>
        </div>
    );
}
