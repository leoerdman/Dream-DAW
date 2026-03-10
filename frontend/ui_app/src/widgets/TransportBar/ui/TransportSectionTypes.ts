import type React from 'react';
import type { GridDivision } from '@/shared/lib/gridSnap';

export interface TransportLeftSectionProps {
    handleTapTempo: () => void;
    bpmEditing: boolean;
    bpmText: string;
    setBpmText: (text: string) => void;
    commitBpm: () => void;
    setBpmEditing: (next: boolean) => void;
    bpm: number;
    bpmRef: React.RefObject<HTMLInputElement | null>;
    valueChipStyle: React.CSSProperties;
    cycleTimeSignature: () => void;
    timeSigNum: number;
    timeSigDen: number;
    keyEnabled: boolean;
    keyTonic: number;
    keyMode: number;
    keyMenuRef: React.RefObject<HTMLDivElement | null>;
    keyMenuOpen: boolean;
    setKeyMenuOpen: (open: boolean) => void;
    onToggleKeyEnabled: () => void;
    onSelectKeyTonic: (index: number) => void;
    onSelectKeyMode: (index: number) => void;
    gridRef: React.RefObject<HTMLDivElement | null>;
    gridOpen: boolean;
    setGridOpen: (open: boolean) => void;
    gridDivision: GridDivision;
    gridTriplet: boolean;
    setGridDivision: (division: GridDivision) => void;
    metronomeEnabled: boolean;
    onToggleMetronome: () => void;
    metronomeVolume: number;
    onMetronomeVolumeChange: (volume: number) => void;
    metronomeMenuRef: React.RefObject<HTMLDivElement | null>;
    metronomeMenuOpen: boolean;
    setMetronomeMenuOpen: (open: boolean) => void;
}

export interface TransportCenterSectionProps {
    isPlaying: boolean;
    enginePlay: () => Promise<void>;
    engineStop: () => void;
    isRecording: boolean;
    handleRecordToggle: () => Promise<void>;
    stopRecordingIfNeeded: () => Promise<void>;
    isLooping: boolean;
    loopStartFrames: number;
    loopEndFrames: number;
    sampleRate: number;
    bpm: number;
    readPosBeats: () => number;
    timeSigNum: number;
    engineSetLoop: (enabled: boolean, start: number, end: number) => Promise<void>;
    followPlayhead: boolean;
    onFollowPlayheadChange?: (enabled: boolean) => void;
    pianoPencilMode: boolean;
    togglePianoPencilMode: () => void;
    automationVisible: boolean;
    onAutomationToggle?: () => void;
    onFitTimelineHorizontally?: () => void;
    onResetTrackHeights?: () => void;
    posRef: React.RefObject<HTMLSpanElement | null>;
    valueChipStyle: React.CSSProperties;
}

export interface TransportRightSectionProps {
    midiLedRef: React.RefObject<HTMLSpanElement | null>;
    pdcOpen: boolean;
    setPdcOpen: (next: boolean | ((prev: boolean) => boolean)) => void;
    notesOpen: boolean;
    setNotesOpen: (next: boolean | ((prev: boolean) => boolean)) => void;
    assistantOpen: boolean;
    onAssistantToggle?: () => void;
    onOpenExport?: () => void;
    onSettingsClick?: () => void;
}
