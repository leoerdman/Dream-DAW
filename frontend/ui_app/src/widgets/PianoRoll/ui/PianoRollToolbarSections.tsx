import { memo } from 'react';
import { Pencil, Brush, Sparkles, RotateCw, Music, Filter, ChevronUp, ChevronDown, Volume2 } from 'lucide-react';
import {
    MIDI_GRID_PRESETS,
    ROOT_NOTES,
    SCALE_NAMES,
    DEFAULT_NOTE_HEIGHT,
    type PianoLaneType,
} from '@/widgets/PianoRoll/model/pianoRollConfig';
import { actionBtnStyle, selectStyle } from '@/widgets/PianoRoll/ui/styles';
import type { PianoRollToolbarProps } from '@/widgets/PianoRoll/model/pianoRollTypes';

const dividerStyle = { width: 1, height: 16, background: 'var(--color-divider-light)', margin: '0 var(--space-1)' };

export const PianoRollToolbarLeft = memo(function PianoRollToolbarLeft({
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
    noteAuditionEnabled,
    setNoteAuditionEnabled,
    stepInputOctave,
    setStepInputOctave,
    stepInputCursorBeat,
    activeLane,
    setActiveLane,
}: Pick<PianoRollToolbarProps,
    'tool' | 'setTool' | 'color' | 'gridDivision' | 'setGridDivision' | 'highlightScale' | 'setHighlightScale' |
    'rootNote' | 'setRootNote' | 'scaleName' | 'setScaleName' | 'clipDurationLabel' |
    'duplicateSelection' | 'quantizeAllNotesToGrid' | 'selectSamePitch' |
    'quantizeAmount' | 'setQuantizeAmount' | 'applyLegato' | 'humanizeSelection' |
    'ratchetCount' | 'setRatchetCount' | 'applyRatchet' |
    'foldToUsedNotes' | 'setFoldToUsedNotes' | 'drumMode' | 'setDrumMode' |
    'noteAuditionEnabled' | 'setNoteAuditionEnabled' |
    'stepInputOctave' | 'setStepInputOctave' | 'stepInputCursorBeat' |
    'activeLane' | 'setActiveLane'
>) {
    return (
        <>
            {(['draw', 'paint'] as const).map((nextTool) => {
                const isActive = tool === nextTool;
                const Icon = nextTool === 'draw' ? Pencil : Brush;
                const label = nextTool === 'draw' ? 'Draw' : 'Paint';
                return (
                    <button
                        key={nextTool}
                        onClick={() => setTool(nextTool)}
                        style={{
                            padding: 'var(--token-size-px-3) var(--space-2)',
                            background: isActive ? color : 'var(--color-bg-secondary)',
                            color: isActive ? 'var(--color-text-on-accent)' : 'var(--color-text-secondary)',
                            border: isActive ? 'none' : 'var(--space-px) solid var(--color-control-border)',
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
                    >
                        <Icon size={13} fill={isActive ? 'currentColor' : 'none'} fillOpacity={0.2} />
                        <span style={{ marginTop: 1 }}>{label}</span>
                    </button>
                );
            })}

            <div style={dividerStyle} />
            <span style={{ fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 'var(--letter-spacing-wide)', fontWeight: 'var(--font-weight-semibold)' as unknown as number, marginRight: 2 }}>Grid</span>
            {MIDI_GRID_PRESETS.map((preset) => (
                <button
                    key={preset.division}
                    onClick={() => setGridDivision(preset.division)}
                    style={{
                        padding: 'var(--space-0-5) var(--space-2)',
                        background: gridDivision === preset.division ? color : 'var(--color-bg-secondary)',
                        color: gridDivision === preset.division ? 'var(--color-text-on-accent)' : 'var(--color-text-secondary)',
                        border: gridDivision === preset.division ? 'none' : 'var(--space-px) solid var(--color-control-border)',
                        borderRadius: 'var(--radius-sm)',
                        fontSize: 'var(--font-size-2xs)',
                        fontFamily: 'var(--font-mono)',
                        cursor: 'pointer',
                        fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                    }}
                >
                    {preset.label}
                </button>
            ))}

            <div style={dividerStyle} />
            <button
                onClick={() => setHighlightScale(!highlightScale)}
                style={{
                    padding: 'var(--token-size-px-3) var(--space-2-5)',
                    background: highlightScale ? 'var(--color-accent-primary-dim)' : 'var(--color-bg-secondary)',
                    color: highlightScale ? 'var(--color-accent-primary)' : 'var(--color-text-tertiary)',
                    border: highlightScale ? 'var(--space-px) solid var(--color-accent-primary)' : 'var(--space-px) solid var(--color-control-border)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 'var(--font-size-2xs)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                }}
            >
                <Music size={13} fill={highlightScale ? 'currentColor' : 'none'} fillOpacity={0.2} />
                <span style={{ marginTop: 1 }}>Scale</span>
            </button>
            {highlightScale && (
                <>
                    <select value={rootNote} onChange={(e) => setRootNote(e.target.value as typeof rootNote)} style={selectStyle}>
                        {ROOT_NOTES.map((note) => <option key={note} value={note}>{note}</option>)}
                    </select>
                    <select value={scaleName} onChange={(e) => setScaleName(e.target.value as typeof scaleName)} style={selectStyle}>
                        {SCALE_NAMES.map((scale) => <option key={scale} value={scale}>{scale}</option>)}
                    </select>
                </>
            )}

            <div style={dividerStyle} />
            <div style={{ padding: 'var(--space-0-5) var(--space-2)', background: `${color}1a`, border: `var(--space-px) solid ${color}40`, borderRadius: 'var(--radius-sm)', fontSize: 'var(--font-size-2xs)', color, fontWeight: 'var(--font-weight-semibold)' as unknown as number, fontFamily: 'var(--font-mono)', letterSpacing: '0.var(--token-size-px-3)' }}>{clipDurationLabel}</div>

            <div style={dividerStyle} />
            <button onClick={duplicateSelection} style={actionBtnStyle}>Duplicate</button>
            <button onClick={quantizeAllNotesToGrid} style={actionBtnStyle}>Quantize</button>
            <button onClick={selectSamePitch} style={actionBtnStyle}>Same Pitch</button>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-xs)' }}>
                <span>Amt</span>
                <select value={quantizeAmount} onChange={(e) => setQuantizeAmount(Number(e.target.value))} style={{ ...selectStyle, width: 58, padding: 'var(--space-0-5) var(--token-size-px-3)' }}>
                    <option value={100}>100%</option><option value={75}>75%</option><option value={50}>50%</option><option value={25}>25%</option>
                </select>
            </label>
            <button onClick={applyLegato} style={actionBtnStyle}>Legato</button>
            <button onClick={humanizeSelection} style={actionBtnStyle}>Humanize</button>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-xs)' }}>
                <span>Ratchet</span>
                <select value={ratchetCount} onChange={(e) => setRatchetCount(Number(e.target.value))} style={{ ...selectStyle, width: 52, padding: 'var(--space-0-5) var(--token-size-px-3)' }}>
                    <option value={2}>x2</option><option value={3}>x3</option><option value={4}>x4</option><option value={6}>x6</option><option value={8}>x8</option>
                </select>
            </label>
            <button onClick={applyRatchet} style={actionBtnStyle}>Ratchet</button>
            <button onClick={() => setFoldToUsedNotes(!foldToUsedNotes)} style={{ ...actionBtnStyle, background: foldToUsedNotes ? 'var(--color-accent-primary-dim)' : actionBtnStyle.background, color: foldToUsedNotes ? 'var(--color-accent-primary)' : actionBtnStyle.color, border: foldToUsedNotes ? 'var(--space-px) solid var(--color-accent-primary)' : actionBtnStyle.border, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Filter size={12} /> Fold
            </button>
            <button onClick={() => setDrumMode(!drumMode)} style={{ ...actionBtnStyle, background: drumMode ? 'var(--color-accent-primary-dim)' : actionBtnStyle.background, color: drumMode ? 'var(--color-accent-primary)' : actionBtnStyle.color, border: drumMode ? 'var(--space-px) solid var(--color-accent-primary)' : actionBtnStyle.border }}>Drum</button>
            <button
                onClick={() => setNoteAuditionEnabled(!noteAuditionEnabled)}
                style={{
                    ...actionBtnStyle,
                    background: noteAuditionEnabled ? 'var(--color-accent-primary-dim)' : actionBtnStyle.background,
                    color: noteAuditionEnabled ? 'var(--color-accent-primary)' : actionBtnStyle.color,
                    border: noteAuditionEnabled ? 'var(--space-px) solid var(--color-accent-primary)' : actionBtnStyle.border,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                }}
                title={noteAuditionEnabled ? 'Note preview ON' : 'Note preview OFF'}
                aria-pressed={noteAuditionEnabled}
            >
                <Volume2 size={12} /> Preview
            </button>

            <div style={dividerStyle} />
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>Step</span>
            <button onClick={() => setStepInputOctave(Math.max(0, stepInputOctave - 1))} style={{ ...actionBtnStyle, padding: 'var(--space-0-5) var(--space-1-5)' }}><ChevronDown size={12} /></button>
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)', minWidth: 30, textAlign: 'center' }}>C{stepInputOctave}</span>
            <button onClick={() => setStepInputOctave(Math.min(9, stepInputOctave + 1))} style={{ ...actionBtnStyle, padding: 'var(--space-0-5) var(--space-1-5)' }}><ChevronUp size={12} /></button>
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>@{stepInputCursorBeat.toFixed(2)}</span>

            <div style={dividerStyle} />
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>Lane</span>
            <select value={activeLane} onChange={(e) => setActiveLane(e.target.value as PianoLaneType)} style={{ ...selectStyle, width: 96, padding: 'var(--space-0-5) var(--space-1)' }}>
                <option value="velocity">Velocity</option>
                <option value="modWheel">Mod Wheel (CC1)</option>
                <option value="expression">Expression (CC11)</option>
            </select>
        </>
    );
});

export const PianoRollToolbarRight = memo(function PianoRollToolbarRight({
    onGenerateVariation,
    aiVariationBusy,
    zoomOverrideH,
    noteHeight,
    setZoomOverrideH,
    setNoteHeight,
    selectedCount,
    noteCount,
}: Pick<PianoRollToolbarProps,
    'onGenerateVariation' | 'aiVariationBusy' | 'zoomOverrideH' | 'noteHeight' |
    'setZoomOverrideH' | 'setNoteHeight' | 'selectedCount' | 'noteCount'
>) {
    return (
        <>
            <div style={{ flex: 1 }} />
            <button
                onClick={() => { void onGenerateVariation?.(); }}
                disabled={!onGenerateVariation || aiVariationBusy}
                style={{
                    padding: 'var(--token-size-px-3) var(--space-3)',
                    background: aiVariationBusy ? 'var(--color-bg-secondary)' : 'var(--color-accent-primary)',
                    color: aiVariationBusy ? 'var(--color-text-tertiary)' : 'var(--color-text-on-accent)',
                    border: aiVariationBusy ? 'var(--space-px) solid var(--color-control-border)' : 'none',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 'var(--font-size-2xs)',
                    fontWeight: 'var(--font-weight-bold)' as unknown as number,
                    cursor: !onGenerateVariation || aiVariationBusy ? 'not-allowed' : 'pointer',
                    opacity: !onGenerateVariation ? 0.6 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    boxShadow: aiVariationBusy ? 'none' : '0 var(--space-0-5) var(--space-2) color-mix(in srgb, var(--color-accent-primary) 30%, transparent)',
                }}
            >
                <Sparkles size={13} className={aiVariationBusy ? 'animate-spin' : ''} />
                <span style={{ marginTop: 1 }}>{aiVariationBusy ? 'Generating…' : 'AI Variation'}</span>
            </button>
            <span style={{ fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', opacity: 0.5, fontFamily: 'var(--font-mono)' }}>⌘Scroll H · Alt V</span>
            {(zoomOverrideH || noteHeight !== DEFAULT_NOTE_HEIGHT) && (
                <button
                    onClick={() => { setZoomOverrideH(null); setNoteHeight(DEFAULT_NOTE_HEIGHT); }}
                    style={{ padding: 'var(--space-0-5) var(--space-2)', background: 'var(--color-bg-secondary)', border: 'var(--space-px) solid var(--color-control-border)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, transition: 'all var(--transition-fast)' }}
                >
                    <RotateCw size={11} /><span style={{ marginTop: 1 }}>Fit</span>
                </button>
            )}
            <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                {selectedCount > 0 ? `${selectedCount} selected` : `${noteCount} notes`}
            </span>
        </>
    );
});
