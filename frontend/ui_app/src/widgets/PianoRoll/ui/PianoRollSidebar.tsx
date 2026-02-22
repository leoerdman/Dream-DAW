import { memo } from 'react';
import { ClipEditorMetaRow, ClipEditorSection, ClipEditorSidebar } from '@/widgets/ClipEditor/ClipEditorSidebar';
import { miniBtnStyle } from '@/widgets/PianoRoll/ui/styles';
import type { MidiNote } from '@/widgets/PianoRoll/model/pianoRollConfig';
import type { GridDivision } from '@/shared/lib/gridSnap';

interface PianoRollSidebarProps {
    clipDurationLabel: string;
    gridDivision: GridDivision;
    gridTriplet: boolean;
    transposeNotes: (semitones: number) => void;
    clipTranspose: number;
    quantizeAllNotesToGrid: () => void;
    setZoomOverrideH: (value: number | null) => void;
    selectedNotes: Set<string>;
    notes: MidiNote[];
    onNotesChange: (notes: MidiNote[]) => void;
}

export const PianoRollSidebarPanel = memo(function PianoRollSidebarPanel({
    clipDurationLabel,
    gridDivision,
    gridTriplet,
    transposeNotes,
    clipTranspose,
    quantizeAllNotesToGrid,
    setZoomOverrideH,
    selectedNotes,
    notes,
    onNotesChange,
}: PianoRollSidebarProps) {
    return (
        <ClipEditorSidebar>
            <ClipEditorSection title="Clip Setup">
                <ClipEditorMetaRow label="Length" value={clipDurationLabel} />
                <ClipEditorMetaRow label="Grid" value={`${gridDivision}${gridTriplet ? 'T' : ''}`} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                    <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>Transpose</span>
                    <button onClick={() => transposeNotes(-1)} style={miniBtnStyle}>
                        -1
                    </button>
                    <button onClick={() => transposeNotes(1)} style={miniBtnStyle}>
                        +1
                    </button>
                    <span
                        style={{
                            fontSize: 'var(--font-size-xs)',
                            color: 'var(--color-text-primary)',
                            fontFamily: 'var(--font-mono)',
                            marginLeft: 'auto',
                        }}
                    >
                        {clipTranspose >= 0 ? `+${clipTranspose}` : clipTranspose}
                    </span>
                </div>
            </ClipEditorSection>

            <ClipEditorSection title="Performance">
                <button onClick={quantizeAllNotesToGrid} style={{ ...miniBtnStyle, width: '100%', marginBottom: 6 }}>
                    Quantize To Grid
                </button>
                <button onClick={() => setZoomOverrideH(null)} style={{ ...miniBtnStyle, width: '100%', marginBottom: 6 }}>
                    Fit To Clip
                </button>
                <button
                    onClick={() => {
                        if (selectedNotes.size === 0) return;
                        const nudged = notes.map((note) => (
                            selectedNotes.has(note.id)
                                ? { ...note, velocity: Math.max(1, Math.min(127, note.velocity + 8)) }
                                : note
                        ));
                        onNotesChange(nudged);
                    }}
                    style={{ ...miniBtnStyle, width: '100%' }}
                >
                    Velocity +8
                </button>
            </ClipEditorSection>
        </ClipEditorSidebar>
    );
});
