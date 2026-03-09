import type { CSSProperties } from 'react';
import { ClipEditorMetaRow, ClipEditorSection, ClipEditorSidebar } from '@/widgets/ClipEditor/ClipEditorSidebar';
import { DEFAULT_BPM, DEFAULT_TIME_SIG_NUMERATOR, formatBeatsAsBBS, MIN_BPM, MAX_BPM } from '@/shared/lib/audioMath';

interface SampleClipSidebarProps {
    clipDurationBeats: number;
    beatsPerBar?: number;
    hasFilePath: boolean;
    draftWarpEnabled: boolean;
    setDraftWarpEnabled: (enabled: boolean) => void;
    draftWarpMode: number;
    setDraftWarpMode: (mode: number) => void;
    draftWarpBaseBpm: number;
    setDraftWarpBaseBpm: (bpm: number) => void;
    draftPitch: number;
    setDraftPitch: (pitch: number) => void;
    isPreviewing: boolean;
    zoomX: number;
    setZoomX: (zoom: number) => void;
    commitWarp: (next: { enabled: boolean; mode: number; baseBpm: number }) => Promise<void>;
    commitPitch: (nextPitch: number) => Promise<void>;
    togglePreview: () => Promise<void>;
}

export function SampleClipSidebar({
    clipDurationBeats,
    beatsPerBar = DEFAULT_TIME_SIG_NUMERATOR,
    hasFilePath,
    draftWarpEnabled,
    setDraftWarpEnabled,
    draftWarpMode,
    setDraftWarpMode,
    draftWarpBaseBpm,
    setDraftWarpBaseBpm,
    draftPitch,
    setDraftPitch,
    isPreviewing,
    zoomX,
    setZoomX,
    commitWarp,
    commitPitch,
    togglePreview,
}: SampleClipSidebarProps) {
    return (
        <ClipEditorSidebar>
            <ClipEditorSection title="Clip Setup">
                <ClipEditorMetaRow label="Length" value={formatBeatsAsBBS(clipDurationBeats, beatsPerBar)} />
                <ClipEditorMetaRow label="Source" value={hasFilePath ? 'Linked' : 'Missing'} />
            </ClipEditorSection>

            <ClipEditorSection title="Warp">
                <label style={{ ...editorMetaTextStyle, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <input
                        type="checkbox"
                        checked={draftWarpEnabled}
                        onChange={(e) => {
                            setDraftWarpEnabled(e.target.checked);
                            void commitWarp({
                                enabled: e.target.checked,
                                mode: draftWarpMode,
                                baseBpm: draftWarpBaseBpm,
                            });
                        }}
                    />
                    Enabled
                </label>
                <select
                    value={draftWarpMode > 0 ? 'pro' : 'standard'}
                    disabled={!draftWarpEnabled}
                    onChange={(e) => {
                        const mode = e.target.value === 'pro' ? 1 : 0;
                        setDraftWarpMode(mode);
                        void commitWarp({
                            enabled: draftWarpEnabled,
                            mode,
                            baseBpm: draftWarpBaseBpm,
                        });
                    }}
                    style={{ ...editorButtonStyle, padding: 'var(--token-size-px-3) var(--space-1-5)' }}
                >
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
                        onBlur={() => {
                            void commitWarp({
                                enabled: draftWarpEnabled,
                                mode: draftWarpMode,
                                baseBpm: draftWarpBaseBpm,
                            });
                        }}
                        style={{ width: 68, ...editorButtonStyle, padding: 'var(--space-0-5) var(--space-1-5)' }}
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
                            onPointerUp={(e) => void commitPitch(Number(e.currentTarget.value))}
                            onKeyUp={(e) => {
                                if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                                    void commitPitch(draftPitch);
                                }
                            }}
                            style={{ flex: 1 }}
                        />
                        <span style={{ ...editorMetaTextStyle, width: 'var(--space-7)', textAlign: 'right' }}>
                            {draftPitch > 0 ? `+${draftPitch}` : draftPitch}
                        </span>
                    </div>
                </div>
            </ClipEditorSection>

            <ClipEditorSection title="Performance">
                <button type="button" onClick={() => void togglePreview()} style={{ ...editorButtonStyle, width: '100%' }}>
                    {isPreviewing ? 'Stop Preview' : 'Preview'}
                </button>
                <div style={{ display: 'grid', gap: 4 }}>
                    <span style={editorMetaTextStyle}>Zoom</span>
                    <input
                        type="range"
                        min={0.6}
                        max={4}
                        step={0.1}
                        value={zoomX}
                        onChange={(e) => setZoomX(Number(e.target.value))}
                    />
                    <span style={{ ...editorMetaTextStyle }}>{zoomX.toFixed(1)}x</span>
                </div>
            </ClipEditorSection>
        </ClipEditorSidebar>
    );
}

const editorButtonStyle = {
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
