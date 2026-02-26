import type { MutableRefObject } from 'react';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import type { FocusPanel } from '@/shared/stores/useFocusPanelStore';

export interface KeyboardShortcutsConfig {
    selectedClipId: string | null;
    selectedClipIds: string[];
    selectedTrackId: string;
    trackIds: string[];
    tracksById: Record<string, ProjectTrack>;
    editCursorBeat?: number;
    timelineClips: TimelineClip[];
    marqueeSelection: { startBeat: number; endBeat: number; startTrack: number; endTrack: number } | null;
    onTogglePlayback: () => void;
    onClipSelectionChanged: (clipIds: string[]) => void;
}

export interface KeyboardShortcutRuntimeContext extends KeyboardShortcutsConfig {
    playheadFrames: number;
    activePanel: FocusPanel;
    selectedDeviceId: string;
    selectedTrackIndex: number;
    insertAfterIndex: number | null;
}

export interface KeyboardShortcutHandlerEnv {
    e: KeyboardEvent;
    ctx: KeyboardShortcutRuntimeContext;
    clipboardRef: MutableRefObject<TimelineClip[]>;
}
