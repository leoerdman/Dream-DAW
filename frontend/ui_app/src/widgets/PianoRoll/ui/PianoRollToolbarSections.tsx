import { memo } from 'react';
import { MousePointer2, Brush, Sparkles, RotateCw, Music, Filter, ChevronUp, ChevronDown, Volume2 } from 'lucide-react';
import {
    MIDI_GRID_PRESETS,
    ROOT_NOTES,
    SCALE_NAMES,
    DEFAULT_NOTE_HEIGHT,
    type PianoLaneType,
} from '@/widgets/PianoRoll/model/pianoRollConfig';
import { actionBtnStyle, selectStyle } from '@/widgets/PianoRoll/ui/styles';
import type { PianoRollToolbarProps } from '@/widgets/PianoRoll/model/pianoRollTypes';
import { isMacDesktopPlatform } from '@/shared/lib/platform';

const dividerStyle = { width: 1, height: 16, background: 'var(--color-divider-light)', margin: '0 var(--space-1)' };
const zoomHint = isMacDesktopPlatform() ? '⌘+Scroll H · Alt V' : 'Ctrl+Scroll H · Alt V';

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
    quantizeAllNotesToGrid,
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
    'quantizeAllNotesToGrid' |
    'quantizeAmount' | 'setQuantizeAmount' | 'applyLegato' | 'humanizeSelection' |
    'ratchetCount' | 'setRatchetCount' | 'applyRatchet' |
    'foldToUsedNotes' | 'setFoldToUsedNotes' | 'drumMode' | 'setDrumMode' |
    'noteAuditionEnabled' | 'setNoteAuditionEnabled' |
    'stepInputOctave' | 'setStepInputOctave' | 'stepInputCursorBeat' |
    'activeLane' | 'setActiveLane'
>) {
    return (
        <>
            {(['cursor', 'paint'] as const).map((nextTool) => {
                const isActive = tool === nextTool;
                const Icon = nextTool === 'cursor' ? MousePointer2 : Brush;
                const label = nextTool === 'cursor' ? 'Cursor' : 'Paint';
                return (
                    <button
                        key={nextTool}
                        type="button"
                        aria-label={`${label} tool`}
                        title={`${label} tool`}
                        onClick={() => setTool(nextTool)}
                        style={{
                            padding: 'var(--token-size-px-3) var(--space-2)',
                            background: isActive ? color : 'var(--color-bg-secondary)',
                            color: isActive ? 'var(--color-text-on-accent)' : 'var(--color-text-secondary)',
                            border: isActive ? 'none' : 'var(--space-px) solid var(--color-control-border)',
                            borderRadius: 'var(--radius-sm)',
                            fontSize: 'var(--font-size-2xs)',
                            fontFamily: 'var(--font-role-body)',
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
            <span style={{ fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 'var(--letter-spacing-wide)', fontWeight: 'var(--font-weight-semibold)', marginRight: 2 }}>Grid</span>
            <select
                value={gridDivision}
                onChange={(e) => setGridDivision(e.target.value as typeof gridDivision)}
                style={{ ...selectStyle, width: 62, padding: 'var(--space-0-5) var(--token-size-px-3)' }}
                aria-label="Grid Division"
            >
                {MIDI_GRID_PRESETS.map((preset) => (
                    <option key={preset.division} value={preset.division}>
                        {preset.label}
                    </option>
                ))}
            </select>

            <div style={dividerStyle} />
            <button
                type="button"
                aria-label="Toggle Scale Highlight"
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
            <div style={{
                padding: 'var(--space-0-5) var(--space-2)',
                background: `color-mix(in srgb, ${color} 14%, transparent)`,
                border: `var(--space-px) solid color-mix(in srgb, ${color} 32%, transparent)`,
                borderRadius: 'var(--radius-sm)',
                fontSize: 'var(--font-size-2xs)',
                color,
                fontWeight: 'var(--font-weight-semibold)',
                fontFamily: 'var(--font-role-data)',
                letterSpacing: 'var(--letter-spacing-normal)',
            }}>{clipDurationLabel}</div>

            <button type="button" onClick={quantizeAllNotesToGrid} style={actionBtnStyle}>Quantize</button>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-xs)' }}>
                <span>Amt</span>
                <select
                    value={quantizeAmount}
                    onChange={(e) => {
                        const next = Number(e.target.value);
                        setQuantizeAmount(Number.isFinite(next) ? Math.max(1, Math.min(100, next)) : 100);
                    }}
                    style={{ ...selectStyle, width: 58, padding: 'var(--space-0-5) var(--token-size-px-3)' }}
                >
                    <option value={100}>100%</option><option value={75}>75%</option><option value={50}>50%</option><option value={25}>25%</option>
                </select>
            </label>
            <button type="button" onClick={applyLegato} style={actionBtnStyle}>Legato</button>
            <button type="button" onClick={humanizeSelection} style={actionBtnStyle}>Humanize</button>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-xs)' }}>
                <span>Ratchet</span>
                <select value={ratchetCount} onChange={(e) => setRatchetCount(Number(e.target.value))} style={{ ...selectStyle, width: 52, padding: 'var(--space-0-5) var(--token-size-px-3)' }}>
                    <option value={2}>x2</option><option value={3}>x3</option><option value={4}>x4</option><option value={6}>x6</option><option value={8}>x8</option>
                </select>
            </label>
            <button type="button" onClick={applyRatchet} style={actionBtnStyle}>Ratchet</button>
            <button type="button" onClick={() => setFoldToUsedNotes(!foldToUsedNotes)} style={{ ...actionBtnStyle, background: foldToUsedNotes ? 'var(--color-accent-primary-dim)' : actionBtnStyle.background, color: foldToUsedNotes ? 'var(--color-accent-primary)' : actionBtnStyle.color, border: foldToUsedNotes ? 'var(--space-px) solid var(--color-accent-primary)' : actionBtnStyle.border, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Filter size={12} /> Fold
            </button>
            <button type="button" onClick={() => setDrumMode(!drumMode)} style={{ ...actionBtnStyle, background: drumMode ? 'var(--color-accent-primary-dim)' : actionBtnStyle.background, color: drumMode ? 'var(--color-accent-primary)' : actionBtnStyle.color, border: drumMode ? 'var(--space-px) solid var(--color-accent-primary)' : actionBtnStyle.border }}>Drum</button>
            <button
                type="button"
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
            <button type="button" onClick={() => setStepInputOctave(Math.max(0, stepInputOctave - 1))} style={{ ...actionBtnStyle, padding: 'var(--space-0-5) var(--space-1-5)' }}><ChevronDown size={12} /></button>
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-role-data)', minWidth: 30, textAlign: 'center' }}>C{stepInputOctave}</span>
            <button type="button" onClick={() => setStepInputOctave(Math.min(9, stepInputOctave + 1))} style={{ ...actionBtnStyle, padding: 'var(--space-0-5) var(--space-1-5)' }}><ChevronUp size={12} /></button>
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-role-data)' }}>@{stepInputCursorBeat.toFixed(2)}</span>

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
                type="button"
                onClick={() => { void onGenerateVariation?.(); }}
                disabled={!onGenerateVariation || aiVariationBusy}
                style={{
                    padding: 'var(--token-size-px-3) var(--space-3)',
                    background: aiVariationBusy ? 'var(--color-bg-secondary)' : 'var(--color-accent-primary)',
                    color: aiVariationBusy ? 'var(--color-text-tertiary)' : 'var(--color-text-on-accent)',
                    border: aiVariationBusy ? 'var(--space-px) solid var(--color-control-border)' : 'none',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 'var(--font-size-2xs)',
                    fontWeight: 'var(--font-weight-bold)',
                    cursor: !onGenerateVariation || aiVariationBusy ? 'not-allowed' : 'pointer',
                    opacity: !onGenerateVariation ? 0.6 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    boxShadow: 'none',
                }}
            >
                <Sparkles size={13} className={aiVariationBusy ? 'animate-spin' : ''} />
                <span style={{ marginTop: 1 }}>{aiVariationBusy ? 'Generating…' : 'AI Variation'}</span>
            </button>
            <span style={{ fontSize: 'var(--font-size-micro)', color: 'var(--color-text-tertiary)', opacity: 0.5, fontFamily: 'var(--font-role-data)' }}>{zoomHint}</span>
            {(zoomOverrideH || noteHeight !== DEFAULT_NOTE_HEIGHT) && (
                <button
                    type="button"
                    onClick={() => { setZoomOverrideH(null); setNoteHeight(DEFAULT_NOTE_HEIGHT); }}
                    style={{ padding: 'var(--space-0-5) var(--space-2)', background: 'var(--color-bg-secondary)', border: 'var(--space-px) solid var(--color-control-border)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--font-size-micro)', color: 'var(--color-text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, transition: 'all var(--transition-fast)' }}
                >
                    <RotateCw size={11} /><span style={{ marginTop: 1 }}>Fit</span>
                </button>
            )}
            <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-role-data)' }}>
                {selectedCount > 0 ? `${selectedCount} selected` : `${noteCount} notes`}
            </span>
        </>
    );
});
