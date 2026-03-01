import { type CSSProperties } from 'react';
import { ClipEditorMetaRow, ClipEditorSection, ClipEditorSidebar } from '@/widgets/ClipEditor/ClipEditorSidebar';
import { DEFAULT_BPM, DEFAULT_TIME_SIG_NUMERATOR, formatBeatsAsBBS, clampPitchShift, MIN_PITCH_SHIFT, MAX_PITCH_SHIFT, MIN_BPM, MAX_BPM } from '@/shared/lib/audioMath';

type Props = {
    clipDurationBeats: number;
    beatsPerBar?: number;
    filePath?: string;
    draftWarpEnabled: boolean;
    draftWarpMode: number;
    draftWarpBaseBpm: number;
    draftPitch: number;
    zoomX: number;
    zoomY: number;
    isPreviewing: boolean;
    setDraftWarpBaseBpm: (value: number) => void;
    setDraftPitch: (value: number) => void;
    setZoomX: (value: number) => void;
    setZoomY: (value: number) => void;
    onCommitWarp: (next: { enabled: boolean; mode: number; baseBpm: number }) => void;
    onCommitPitch: (value: number) => void;
    onTogglePreview: () => void;
};

export const SampleClipEditorSidebar = (props: Props) => {
    const {
        clipDurationBeats,
        beatsPerBar = DEFAULT_TIME_SIG_NUMERATOR,
        filePath,
        draftWarpEnabled,
        draftWarpMode,
        draftWarpBaseBpm,
        draftPitch,
        zoomX,
        zoomY,
        isPreviewing,
        setDraftWarpBaseBpm,
        setDraftPitch,
        setZoomX,
        setZoomY,
        onCommitWarp,
        onCommitPitch,
        onTogglePreview,
    } = props;

    const clampPitch = (value: number) => clampPitchShift(Math.round(value ?? 0));
    const nudgePitch = (delta: number) => {
        const next = clampPitch(draftPitch + delta);
        setDraftPitch(next);
        onCommitPitch(next);
    };

    return (
        <ClipEditorSidebar>
            <ClipEditorSection title="Clip Setup">
                <ClipEditorMetaRow label="Length" value={formatBeatsAsBBS(clipDurationBeats, beatsPerBar)} />
                <ClipEditorMetaRow label="Source" value={filePath ? 'Linked' : 'Missing'} />
            </ClipEditorSection>

            <ClipEditorSection title="Warp">
                <label style={{ ...editorMetaTextStyle, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={draftWarpEnabled} onChange={(e) => onCommitWarp({ enabled: e.target.checked, mode: draftWarpMode, baseBpm: draftWarpBaseBpm })} />
                    Enabled
                </label>
                <select value={draftWarpMode > 0 ? 'pro' : 'standard'} disabled={!draftWarpEnabled} onChange={(e) => onCommitWarp({ enabled: draftWarpEnabled, mode: e.target.value === 'pro' ? 1 : 0, baseBpm: draftWarpBaseBpm })} style={{ ...editorButtonStyle, padding: 'var(--token-size-px-3) var(--space-1-5)' }}>
                    <option value="standard">Standard</option>
                    <option value="pro">Pro</option>
                </select>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span style={editorMetaTextStyle}>Base BPM</span>
                    <input
                        type="number"
                        min={MIN_BPM}
                        max={MAX_BPM}
                        value={draftWarpBaseBpm}
                        disabled={!draftWarpEnabled}
                        onChange={(e) => setDraftWarpBaseBpm(Number(e.target.value) || DEFAULT_BPM)}
                        onBlur={() => onCommitWarp({ enabled: draftWarpEnabled, mode: draftWarpMode, baseBpm: draftWarpBaseBpm })}
                        style={{ width: 68, ...editorButtonStyle, padding: 'var(--space-0-5) var(--space-1-5)' }}
                    />
                </div>
            </ClipEditorSection>

            <ClipEditorSection title="Pitch">
                <div style={{ display: 'grid', gap: 4 }}>
                    <span style={editorMetaTextStyle}>Transpose (st)</span>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <button
                            type="button"
                            onClick={() => nudgePitch(-12)}
                            style={{ ...editorButtonStyle, minWidth: 40, padding: 'var(--token-size-px-3) var(--space-1-5)' }}
                            title="Transpose down octave"
                        >
                            -12
                        </button>
                        <button
                            type="button"
                            onClick={() => nudgePitch(-1)}
                            style={{ ...editorButtonStyle, minWidth: 34, padding: 'var(--token-size-px-3) var(--space-1-5)' }}
                            title="Transpose down"
                        >
                            -1
                        </button>
                        <input
                            type="range"
                            min={MIN_PITCH_SHIFT}
                            max={MAX_PITCH_SHIFT}
                            step={1}
                            value={draftPitch}
                            onChange={(e) => setDraftPitch(Number(e.target.value))}
                            onMouseUp={(e) => onCommitPitch(Number(e.currentTarget.value))}
                            onTouchEnd={(e) => onCommitPitch(Number(e.currentTarget.value))}
                            onKeyUp={(e) => {
                                if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                                    onCommitPitch(draftPitch);
                                }
                            }}
                            style={{ flex: 1 }}
                        />
                        <button
                            type="button"
                            onClick={() => nudgePitch(1)}
                            style={{ ...editorButtonStyle, minWidth: 34, padding: 'var(--token-size-px-3) var(--space-1-5)' }}
                            title="Transpose up"
                        >
                            +1
                        </button>
                        <button
                            type="button"
                            onClick={() => nudgePitch(12)}
                            style={{ ...editorButtonStyle, minWidth: 40, padding: 'var(--token-size-px-3) var(--space-1-5)' }}
                            title="Transpose up octave"
                        >
                            +12
                        </button>
                        <input
                            type="number"
                            min={MIN_PITCH_SHIFT}
                            max={MAX_PITCH_SHIFT}
                            step={1}
                            value={draftPitch}
                            onChange={(e) => setDraftPitch(clampPitch(Number(e.target.value)))}
                            onBlur={() => onCommitPitch(clampPitch(draftPitch))}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    onCommitPitch(clampPitch(draftPitch));
                                }
                            }}
                            style={{ width: 58, ...editorButtonStyle, padding: 'var(--space-0-5) var(--space-1-5)', textAlign: 'right' }}
                            title="Exact transpose in semitones"
                        />
                        <button
                            type="button"
                            onClick={() => {
                                setDraftPitch(0);
                                onCommitPitch(0);
                            }}
                            style={{ ...editorButtonStyle, minWidth: 52, padding: 'var(--token-size-px-3) var(--space-1-5)' }}
                            title="Reset transpose"
                        >
                            Reset
                        </button>
                    </div>
                </div>
            </ClipEditorSection>

            <ClipEditorSection title="Performance">
                <button type="button" onClick={onTogglePreview} style={{ ...editorButtonStyle, width: '100%' }}>
                    {isPreviewing ? 'Stop Preview' : 'Preview'}
                </button>
                <div style={{ display: 'grid', gap: 4 }}>
                    <span style={editorMetaTextStyle}>Zoom X</span>
                    <input type="range" min={0.6} max={4} step={0.1} value={zoomX} onChange={(e) => setZoomX(Number(e.target.value))} />
                    <span style={{ ...editorMetaTextStyle }}>{zoomX.toFixed(1)}x</span>
                </div>
                <div style={{ display: 'grid', gap: 4 }}>
                    <span style={editorMetaTextStyle}>Height</span>
                    <input type="range" min={0.5} max={2} step={0.05} value={zoomY} onChange={(e) => setZoomY(Number(e.target.value))} />
                    <span style={{ ...editorMetaTextStyle }}>{zoomY.toFixed(2)}x</span>
                </div>
            </ClipEditorSection>
        </ClipEditorSidebar>
    );
};

const editorButtonStyle: CSSProperties = {
    border: 'var(--space-px) solid var(--color-divider)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--color-bg-header)',
    color: 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 600,
    padding: 'var(--space-1) var(--space-2)',
    cursor: 'pointer',
};

const editorMetaTextStyle: CSSProperties = {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--color-text-tertiary)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    fontWeight: 'var(--font-weight-bold)',
};
