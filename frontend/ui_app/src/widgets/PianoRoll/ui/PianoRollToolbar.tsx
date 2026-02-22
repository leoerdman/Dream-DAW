import { memo, type RefObject } from 'react';
import {
    Pencil,
    Brush,
    Sparkles,
    RotateCw,
    Music,
    Filter,
    ChevronUp,
    ChevronDown,
} from 'lucide-react';
import type { GridDivision } from '@/shared/lib/gridSnap';
import {
    MIDI_GRID_PRESETS,
    ROOT_NOTES,
    SCALE_NAMES,
    DEFAULT_NOTE_HEIGHT,
    type PianoLaneType,
    type PianoRollTool,
    type RootNote,
    type ScaleName,
} from '@/widgets/PianoRoll/model/pianoRollConfig';
import { actionBtnStyle, selectStyle } from '@/widgets/PianoRoll/ui/styles';

interface PianoRollToolbarProps {
    editorRootRef: RefObject<HTMLDivElement | null>;
    tool: PianoRollTool;
    setTool: (tool: PianoRollTool) => void;
    color: string;
    gridDivision: GridDivision;
    setGridDivision: (division: GridDivision) => void;
    highlightScale: boolean;
    setHighlightScale: (enabled: boolean) => void;
    rootNote: RootNote;
    setRootNote: (note: RootNote) => void;
    scaleName: ScaleName;
    setScaleName: (scale: ScaleName) => void;
    clipDurationLabel: string;
    duplicateSelection: () => void;
    quantizeAllNotesToGrid: () => void;
    selectSamePitch: () => void;
    quantizeAmount: number;
    setQuantizeAmount: (amount: number) => void;
    applyLegato: () => void;
    humanizeSelection: () => void;
    ratchetCount: number;
    setRatchetCount: (count: number) => void;
    applyRatchet: () => void;
    foldToUsedNotes: boolean;
    setFoldToUsedNotes: (next: boolean) => void;
    drumMode: boolean;
    setDrumMode: (next: boolean) => void;
    stepInputOctave: number;
    setStepInputOctave: (next: number) => void;
    stepInputCursorBeat: number;
    activeLane: PianoLaneType;
    setActiveLane: (lane: PianoLaneType) => void;
    onGenerateVariation?: () => void | Promise<void>;
    aiVariationBusy: boolean;
    zoomOverrideH: number | null;
    noteHeight: number;
    setZoomOverrideH: (value: number | null) => void;
    setNoteHeight: (height: number) => void;
    selectedCount: number;
    noteCount: number;
}

export const PianoRollToolbar = memo(function PianoRollToolbar({
    editorRootRef,
    tool,
    setTool,
    color,
    gridDivision,
    setGridDivision,
    highlightScale,
    setHighlightScale,
    rootNote,
    setRootNote,
    scaleName,
    setScaleName,
    clipDurationLabel,
    duplicateSelection,
    quantizeAllNotesToGrid,
    selectSamePitch,
    quantizeAmount,
    setQuantizeAmount,
    applyLegato,
    humanizeSelection,
    ratchetCount,
    setRatchetCount,
    applyRatchet,
    foldToUsedNotes,
    setFoldToUsedNotes,
    drumMode,
    setDrumMode,
    stepInputOctave,
    setStepInputOctave,
    stepInputCursorBeat,
    activeLane,
    setActiveLane,
    onGenerateVariation,
    aiVariationBusy,
    zoomOverrideH,
    noteHeight,
    setZoomOverrideH,
    setNoteHeight,
    selectedCount,
    noteCount,
}: PianoRollToolbarProps) {
    return (
        <div
            onMouseDown={(e) => {
                const target = e.target as HTMLElement;
                if (target.tagName !== 'SELECT') {
                    e.preventDefault();
                }
                requestAnimationFrame(() => editorRootRef.current?.focus());
            }}
            style={{
                height: 'var(--daw-transport-height)',
                display: 'flex',
                alignItems: 'center',
                padding: '0 var(--space-2)',
                gap: 'var(--space-1)',
                background: 'var(--color-bg-elevated)',
                borderBottom: '1px solid var(--color-divider)',
                flexShrink: 0,
            }}
        >
            {(['draw', 'paint'] as const).map((nextTool) => {
                const isActive = tool === nextTool;
                const Icon = nextTool === 'draw' ? Pencil : Brush;
                const label = nextTool === 'draw' ? 'Draw' : 'Paint';

                return (
                    <button
                        key={nextTool}
                        onClick={() => setTool(nextTool)}
                        style={{
                            padding: '3px 8px',
                            background: isActive ? color : 'var(--color-bg-secondary)',
                            color: isActive ? 'var(--color-text-on-accent)' : 'var(--color-text-secondary)',
                            border: isActive ? 'none' : '1px solid var(--color-control-border)',
                            borderRadius: 'var(--radius-sm)',
                            fontSize: 'var(--font-size-2xs)',
                            fontFamily: 'var(--font-family)',
                            fontWeight: isActive ? 600 : 400,
                            cursor: 'pointer',
                            transition: 'all var(--transition-fast)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                        }}
                        title={`${label} Tool`}
                    >
                        <Icon size={13} fill={isActive ? 'currentColor' : 'none'} fillOpacity={0.2} />
                        <span style={{ marginTop: 1 }}>{label}</span>
                    </button>
                );
            })}

            <div style={{ width: 1, height: 16, background: 'var(--color-divider-light)', margin: '0 var(--space-1)' }} />

            <span
                style={{
                    fontSize: 'var(--font-size-micro)',
                    color: 'var(--color-text-tertiary)',
                    textTransform: 'uppercase',
                    letterSpacing: 'var(--letter-spacing-wide)',
                    fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                    marginRight: 2,
                }}
            >
                Grid
            </span>

            {MIDI_GRID_PRESETS.map((preset) => (
                <button
                    key={preset.division}
                    onClick={() => setGridDivision(preset.division)}
                    style={{
                        padding: '2px 8px',
                        background: gridDivision === preset.division ? color : 'var(--color-bg-secondary)',
                        color: gridDivision === preset.division ? 'var(--color-text-on-accent)' : 'var(--color-text-secondary)',
                        border: gridDivision === preset.division ? 'none' : '1px solid var(--color-control-border)',
                        borderRadius: 'var(--radius-sm)',
                        fontSize: 'var(--font-size-2xs)',
                        fontFamily: 'var(--font-mono)',
                        cursor: 'pointer',
                        fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                    }}
                    title={`Set MIDI grid to ${preset.label}`}
                >
                    {preset.label}
                </button>
            ))}

            <div style={{ width: 1, height: 16, background: 'var(--color-divider-light)', margin: '0 var(--space-1)' }} />

            <button
                onClick={() => setHighlightScale(!highlightScale)}
                style={{
                    padding: '3px 10px',
                    background: highlightScale ? 'var(--color-accent-primary-dim)' : 'var(--color-bg-secondary)',
                    color: highlightScale ? 'var(--color-accent-primary)' : 'var(--color-text-tertiary)',
                    border: highlightScale
                        ? '1px solid var(--color-accent-primary)'
                        : '1px solid var(--color-control-border)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 'var(--font-size-2xs)',
                    fontFamily: 'var(--font-family)',
                    fontWeight: highlightScale ? 600 : 400,
                    cursor: 'pointer',
                    transition: 'all var(--transition-fast)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                }}
                title="Highlight notes in the selected scale"
            >
                <Music size={13} fill={highlightScale ? 'currentColor' : 'none'} fillOpacity={0.2} />
                <span style={{ marginTop: 1 }}>Scale</span>
            </button>

            {highlightScale && (
                <>
                    <select
                        value={rootNote}
                        onChange={(e) => setRootNote(e.target.value as RootNote)}
                        style={selectStyle}
                    >
                        {ROOT_NOTES.map((note) => (
                            <option key={note} value={note}>
                                {note}
                            </option>
                        ))}
                    </select>
                    <select
                        value={scaleName}
                        onChange={(e) => setScaleName(e.target.value as ScaleName)}
                        style={selectStyle}
                    >
                        {SCALE_NAMES.map((scale) => (
                            <option key={scale} value={scale}>
                                {scale}
                            </option>
                        ))}
                    </select>
                </>
            )}

            <div style={{ width: 1, height: 16, background: 'var(--color-divider-light)', margin: '0 var(--space-1)' }} />

            <div
                style={{
                    padding: '2px 8px',
                    background: `${color}1a`,
                    border: `1px solid ${color}40`,
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 'var(--font-size-2xs)',
                    color,
                    fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                    fontFamily: 'var(--font-mono)',
                    letterSpacing: '0.3px',
                }}
            >
                {clipDurationLabel}
            </div>

            <div style={{ width: 1, height: 16, background: 'var(--color-divider-light)', margin: '0 var(--space-1)' }} />

            <button onClick={duplicateSelection} style={actionBtnStyle} title="Duplicate selected notes (Cmd/Ctrl + D)">
                Duplicate
            </button>
            <button onClick={quantizeAllNotesToGrid} style={actionBtnStyle} title="Quantize selected notes (Q)">
                Quantize
            </button>
            <button onClick={selectSamePitch} style={actionBtnStyle} title="Select same pitch (Shift+P)">
                Same Pitch
            </button>
            <label
                style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    color: 'var(--color-text-tertiary)',
                    fontSize: 'var(--font-size-xs)',
                }}
            >
                <span>Amt</span>
                <select
                    value={quantizeAmount}
                    onChange={(e) => setQuantizeAmount(Number(e.target.value))}
                    style={{ ...selectStyle, width: 58, padding: '2px 3px' }}
                    title="Quantize amount"
                >
                    <option value={100}>100%</option>
                    <option value={75}>75%</option>
                    <option value={50}>50%</option>
                    <option value={25}>25%</option>
                </select>
            </label>
            <button onClick={applyLegato} style={actionBtnStyle} title="Legato selected notes (L)">
                Legato
            </button>
            <button onClick={humanizeSelection} style={actionBtnStyle} title="Humanize selected notes (H)">
                Humanize
            </button>
            <label
                style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    color: 'var(--color-text-tertiary)',
                    fontSize: 'var(--font-size-xs)',
                }}
            >
                <span>Ratchet</span>
                <select
                    value={ratchetCount}
                    onChange={(e) => setRatchetCount(Number(e.target.value))}
                    style={{ ...selectStyle, width: 52, padding: '2px 3px' }}
                    title="Ratchet repeats"
                >
                    <option value={2}>x2</option>
                    <option value={3}>x3</option>
                    <option value={4}>x4</option>
                    <option value={6}>x6</option>
                    <option value={8}>x8</option>
                </select>
            </label>
            <button onClick={applyRatchet} style={actionBtnStyle} title="Split selected notes by repeats">
                Ratchet
            </button>
            <button
                onClick={() => setFoldToUsedNotes(!foldToUsedNotes)}
                style={{
                    ...actionBtnStyle,
                    background: foldToUsedNotes ? 'var(--color-accent-primary-dim)' : actionBtnStyle.background,
                    color: foldToUsedNotes ? 'var(--color-accent-primary)' : actionBtnStyle.color,
                    border: foldToUsedNotes ? '1px solid var(--color-accent-primary)' : actionBtnStyle.border,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                }}
                title="Fold to used notes"
            >
                <Filter size={12} />
                Fold
            </button>
            <button
                onClick={() => setDrumMode(!drumMode)}
                style={{
                    ...actionBtnStyle,
                    background: drumMode ? 'var(--color-accent-primary-dim)' : actionBtnStyle.background,
                    color: drumMode ? 'var(--color-accent-primary)' : actionBtnStyle.color,
                    border: drumMode ? '1px solid var(--color-accent-primary)' : actionBtnStyle.border,
                }}
                title="Drum mode with named lanes"
            >
                Drum
            </button>

            <div style={{ width: 1, height: 16, background: 'var(--color-divider-light)', margin: '0 var(--space-1)' }} />

            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>Step</span>
            <button
                onClick={() => setStepInputOctave(Math.max(0, stepInputOctave - 1))}
                style={{ ...actionBtnStyle, padding: '2px 6px' }}
                title="Step octave down ([)"
            >
                <ChevronDown size={12} />
            </button>
            <span
                style={{
                    fontSize: 'var(--font-size-xs)',
                    color: 'var(--color-text-secondary)',
                    fontFamily: 'var(--font-mono)',
                    minWidth: 30,
                    textAlign: 'center',
                }}
            >
                C{stepInputOctave}
            </span>
            <button
                onClick={() => setStepInputOctave(Math.min(9, stepInputOctave + 1))}
                style={{ ...actionBtnStyle, padding: '2px 6px' }}
                title="Step octave up (])"
            >
                <ChevronUp size={12} />
            </button>
            <span
                style={{
                    fontSize: 'var(--font-size-xs)',
                    color: 'var(--color-text-tertiary)',
                    fontFamily: 'var(--font-mono)',
                }}
            >
                @{stepInputCursorBeat.toFixed(2)}
            </span>

            <div style={{ width: 1, height: 16, background: 'var(--color-divider-light)', margin: '0 var(--space-1)' }} />

            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>Lane</span>
            <select
                value={activeLane}
                onChange={(e) => setActiveLane(e.target.value as PianoLaneType)}
                style={{ ...selectStyle, width: 96, padding: '2px 4px' }}
                title="Control lane"
            >
                <option value="velocity">Velocity</option>
                <option value="modWheel">Mod Wheel (CC1)</option>
                <option value="expression">Expression (CC11)</option>
            </select>

            <div style={{ flex: 1 }} />

            <button
                onClick={() => {
                    void onGenerateVariation?.();
                }}
                disabled={!onGenerateVariation || aiVariationBusy}
                style={{
                    padding: '3px 12px',
                    background: aiVariationBusy ? 'var(--color-bg-secondary)' : 'var(--color-accent-primary)',
                    color: aiVariationBusy ? 'var(--color-text-tertiary)' : 'var(--color-text-on-accent)',
                    border: aiVariationBusy ? '1px solid var(--color-control-border)' : 'none',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 'var(--font-size-2xs)',
                    fontFamily: 'var(--font-family)',
                    fontWeight: 'var(--font-weight-bold)' as unknown as number,
                    cursor: !onGenerateVariation || aiVariationBusy ? 'not-allowed' : 'pointer',
                    opacity: !onGenerateVariation ? 0.6 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    boxShadow: aiVariationBusy
                        ? 'none'
                        : '0 2px 8px color-mix(in srgb, var(--color-accent-primary) 30%, transparent)',
                }}
                title="Generate AI variation for this MIDI clip"
            >
                <Sparkles size={13} className={aiVariationBusy ? 'animate-spin' : ''} />
                <span style={{ marginTop: 1 }}>{aiVariationBusy ? 'Generating…' : 'AI Variation'}</span>
            </button>

            <span
                style={{
                    fontSize: 'var(--font-size-micro)',
                    color: 'var(--color-text-tertiary)',
                    opacity: 0.5,
                    fontFamily: 'var(--font-mono)',
                }}
            >
                ⌘Scroll H · Alt V
            </span>

            {(zoomOverrideH || noteHeight !== DEFAULT_NOTE_HEIGHT) && (
                <button
                    onClick={() => {
                        setZoomOverrideH(null);
                        setNoteHeight(DEFAULT_NOTE_HEIGHT);
                    }}
                    style={{
                        padding: '2px 8px',
                        background: 'var(--color-bg-secondary)',
                        border: '1px solid var(--color-control-border)',
                        borderRadius: 'var(--radius-sm)',
                        fontSize: 'var(--font-size-micro)',
                        fontFamily: 'var(--font-family)',
                        color: 'var(--color-text-secondary)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        transition: 'all var(--transition-fast)',
                    }}
                    title="Reset zoom to auto-fit"
                >
                    <RotateCw size={11} />
                    <span style={{ marginTop: 1 }}>Fit</span>
                </button>
            )}

            <span
                style={{
                    fontSize: 'var(--font-size-2xs)',
                    color: 'var(--color-text-tertiary)',
                    fontFamily: 'var(--font-mono)',
                }}
            >
                {selectedCount > 0 ? `${selectedCount} selected` : `${noteCount} notes`}
            </span>
        </div>
    );
});
