import type { RefObject } from 'react';
import type { GridDivision } from '@/shared/lib/gridSnap';
import type { MidiNote, PianoLaneType, PianoRollTool, RootNote, ScaleName } from './pianoRollConfig';

export interface PianoRollProps {
    notes: MidiNote[];
    ghostNotes?: MidiNote[];
    trackIndex?: number;
    midiEnvelopes?: Array<{ paramId: string; points: Array<{ beat: number; value: number }> }>;
    onSetMidiEnvelopes?: (
        envelopes: Array<{ paramId: string; points: Array<{ beat: number; value: number }> }>,
    ) => void;
    onNotesChange: (notes: MidiNote[]) => void;
    onGenerateVariation?: () => void | Promise<void>;
    aiVariationBusy?: boolean;
    color?: string;
    timeSignature?: [number, number];
    totalBars?: number;
    playheadBeat?: number;
    clipStartBeat?: number;
    clipLengthBeats?: number;
}

export interface PianoRollToolbarProps {
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
    noteAuditionEnabled: boolean;
    setNoteAuditionEnabled: (next: boolean) => void;
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
