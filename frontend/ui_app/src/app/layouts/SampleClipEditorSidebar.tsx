import { type CSSProperties } from 'react';
import { ClipEditorMetaRow, ClipEditorSection, ClipEditorSidebar } from '@/widgets/ClipEditor/ClipEditorSidebar';

type Props = {
    clipDurationBeats: number;
    filePath?: string;
    draftWarpEnabled: boolean;
    draftWarpMode: number;
    draftWarpBaseBpm: number;
    draftPitch: number;
    zoomX: number;
    isPreviewing: boolean;
    setDraftWarpBaseBpm: (value: number) => void;
    setDraftPitch: (value: number) => void;
    setZoomX: (value: number) => void;
    onCommitWarp: (next: { enabled: boolean; mode: number; baseBpm: number }) => void;
    onCommitPitch: (value: number) => void;
    onTogglePreview: () => void;
};

export const SampleClipEditorSidebar = (props: Props) => {
    const {
        clipDurationBeats,
        filePath,
        draftWarpEnabled,
        draftWarpMode,
        draftWarpBaseBpm,
        draftPitch,
        zoomX,
        isPreviewing,
        setDraftWarpBaseBpm,
        setDraftPitch,
        setZoomX,
        onCommitWarp,
        onCommitPitch,
        onTogglePreview,
    } = props;

    return (
        <ClipEditorSidebar>
            <ClipEditorSection title="Clip Setup">
                <ClipEditorMetaRow label="Length" value={`${clipDurationBeats.toFixed(2)} beats`} />
                <ClipEditorMetaRow label="Source" value={filePath ? 'Linked' : 'Missing'} />
            </ClipEditorSection>

            <ClipEditorSection title="Warp">
                <label style={{ ...editorMetaTextStyle, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={draftWarpEnabled} onChange={(e) => onCommitWarp({ enabled: e.target.checked, mode: draftWarpMode, baseBpm: draftWarpBaseBpm })} />
                    Enabled
                </label>
                <select value={draftWarpMode > 0 ? 'pro' : 'standard'} disabled={!draftWarpEnabled} onChange={(e) => onCommitWarp({ enabled: draftWarpEnabled, mode: e.target.value === 'pro' ? 1 : 0, baseBpm: draftWarpBaseBpm })} style={{ ...editorButtonStyle, padding: '3px 6px' }}>
                    <option value="standard">Standard</option>
                    <option value="pro">Pro</option>
                </select>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span style={editorMetaTextStyle}>Base BPM</span>
                    <input
                        type="number"
                        min={20}
                        max={300}
                        value={draftWarpBaseBpm}
                        disabled={!draftWarpEnabled}
                        onChange={(e) => setDraftWarpBaseBpm(Number(e.target.value) || 120)}
                        onBlur={() => onCommitWarp({ enabled: draftWarpEnabled, mode: draftWarpMode, baseBpm: draftWarpBaseBpm })}
                        style={{ width: 68, ...editorButtonStyle, padding: '2px 6px' }}
                    />
                </div>
            </ClipEditorSection>

            <ClipEditorSection title="Pitch">
                <div style={{ display: 'grid', gap: 4 }}>
                    <span style={editorMetaTextStyle}>Transpose (st)</span>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                            type="range"
                            min={-48}
                            max={48}
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
                        <span style={{ ...editorMetaTextStyle, width: '28px', textAlign: 'right' }}>{draftPitch > 0 ? `+${draftPitch}` : draftPitch}</span>
                    </div>
                </div>
            </ClipEditorSection>

            <ClipEditorSection title="Performance">
                <button type="button" onClick={onTogglePreview} style={{ ...editorButtonStyle, width: '100%' }}>
                    {isPreviewing ? 'Stop Preview' : 'Preview'}
                </button>
                <div style={{ display: 'grid', gap: 4 }}>
                    <span style={editorMetaTextStyle}>Zoom</span>
                    <input type="range" min={0.6} max={4} step={0.1} value={zoomX} onChange={(e) => setZoomX(Number(e.target.value))} />
                    <span style={{ ...editorMetaTextStyle }}>{zoomX.toFixed(1)}x</span>
                </div>
            </ClipEditorSection>
        </ClipEditorSidebar>
    );
};

const editorButtonStyle: CSSProperties = {
    border: '1px solid var(--color-divider)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--color-bg-header)',
    color: 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 600,
    padding: '4px 8px',
    cursor: 'pointer',
};

const editorMetaTextStyle: CSSProperties = {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--color-text-tertiary)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    fontWeight: 'var(--font-weight-bold)' as unknown as number,
};
