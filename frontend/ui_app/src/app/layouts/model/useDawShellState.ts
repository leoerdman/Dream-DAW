import { useState, useRef, useMemo } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import { useGridStore } from '@/shared/stores/useGridStore';
import { useSettingsStore } from '@/shared/stores/useSettingsStore';
import { resolveSampleRate } from '@/shared/lib/audioMath';
import {
    BOTTOM_PANEL_HEIGHT_DEFAULT_PX,
    BOTTOM_PANEL_HEIGHT_MAX_PX,
    BOTTOM_PANEL_HEIGHT_MIN_PX,
    BROWSER_WIDTH_DEFAULT_PX,
    BROWSER_WIDTH_MAX_PX,
    BROWSER_WIDTH_MIN_PX,
} from '@/shared/config/layoutConstants';
import { readAssistantOpenPref } from './assistantUiPrefs';

type BottomPanelMode = 'rack' | 'clip';
type MainViewMode = 'arrangement' | 'session';

export function useDawShellState() {
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [selectedTrackId, setSelectedTrackId] = useState('master');
    const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);

    const selectedTrackIdRef = useRef(selectedTrackId);
    const selectedTrackIdsRef = useRef(selectedTrackIds);
    selectedTrackIdRef.current = selectedTrackId;
    selectedTrackIdsRef.current = selectedTrackIds;

    const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
    const selectedClipId = useMemo(
        () => selectedClipIds.length > 0 ? selectedClipIds[selectedClipIds.length - 1] : null,
        [selectedClipIds],
    );

    const [editCursorBeat, setEditCursorBeat] = useState(-1);
    const [editCursorTrackIndex, setEditCursorTrackIndex] = useState(0);
    const [editCursorTrackIndexEnd, setEditCursorTrackIndexEnd] = useState(0);

    const [exportOpen, setExportOpen] = useState(false);
    const [assistantOpen, setAssistantOpen] = useState(readAssistantOpenPref);

    const [bottomPanelMode, setBottomPanelMode] = useState<BottomPanelMode>('rack');
    const [bottomPanelModeByTrack, setBottomPanelModeByTrack] = useState<Record<string, BottomPanelMode>>({});
    const [mainViewMode, setMainViewMode] = useState<MainViewMode>('arrangement');

    const [recordingState, setRecordingState] = useState<{ active: boolean; trackIndex: number }>({
        active: false,
        trackIndex: 0,
    });

    const [followPlayhead, setFollowPlayhead] = useState(true);
    const [missingAssetsOpen, setMissingAssetsOpen] = useState(false);

    const [browserWidth, setBrowserWidth] = useState(
        () => Math.max(BROWSER_WIDTH_MIN_PX, Math.min(BROWSER_WIDTH_MAX_PX, BROWSER_WIDTH_DEFAULT_PX)),
    );
    const [fitTimelineToken, setFitTimelineToken] = useState(0);
    const [bottomPanelHeightPx, setBottomPanelHeightPx] = useState(
        () => Math.max(BOTTOM_PANEL_HEIGHT_MIN_PX, Math.min(BOTTOM_PANEL_HEIGHT_MAX_PX, BOTTOM_PANEL_HEIGHT_DEFAULT_PX)),
    );

    const [marqueeSelection, setMarqueeSelection] = useState<{
        startBeat: number;
        endBeat: number;
        startTrack: number;
        endTrack: number;
    } | null>(null);

    const recoveringAudioRef = useRef(false);
    const lastAudioRecoverAtRef = useRef(0);
    const importingRef = useRef(false);

    const timelineRef = useRef<HTMLDivElement>(null);
    const mainSplitRef = useRef<HTMLElement>(null);
    const queuedStartBeatRef = useRef<number | null>(null);

    const projectSampleRate = useEngineStore(s => resolveSampleRate(s.projectSampleRate, s.transport.sample_rate));
    const automationVisible = useAutomationStore(s => s.globalVisible);
    const toggleAutomation = useAutomationStore(s => s.toggleGlobalVisible);
    const gridDivision = useGridStore((s) => s.division);
    const gridTriplet = useGridStore((s) => s.triplet);
    const gridSnapEnabled = useGridStore((s) => s.snapEnabled);
    const pianoPencilMode = useGridStore((s) => s.pianoPencilMode);

    const settingsLoaded = useSettingsStore((s) => s.loaded);
    const settings = useSettingsStore((s) => s.settings);

    return {
        settingsOpen, setSettingsOpen,
        selectedTrackId, setSelectedTrackId,
        selectedTrackIds, setSelectedTrackIds,
        selectedTrackIdRef, selectedTrackIdsRef,
        selectedClipIds, setSelectedClipIds, selectedClipId,
        editCursorBeat, setEditCursorBeat,
        editCursorTrackIndex, setEditCursorTrackIndex,
        editCursorTrackIndexEnd, setEditCursorTrackIndexEnd,
        exportOpen, setExportOpen,
        assistantOpen, setAssistantOpen,
        bottomPanelMode, setBottomPanelMode,
        bottomPanelModeByTrack, setBottomPanelModeByTrack,
        mainViewMode, setMainViewMode,
        recordingState, setRecordingState,
        followPlayhead, setFollowPlayhead,
        missingAssetsOpen, setMissingAssetsOpen,
        browserWidth, setBrowserWidth,
        fitTimelineToken, setFitTimelineToken,
        bottomPanelHeightPx, setBottomPanelHeightPx,
        marqueeSelection, setMarqueeSelection,
        recoveringAudioRef, lastAudioRecoverAtRef, importingRef,
        timelineRef, mainSplitRef, queuedStartBeatRef,
        projectSampleRate,
        automationVisible, toggleAutomation,
        gridDivision, gridTriplet, gridSnapEnabled, pianoPencilMode,
        settingsLoaded, settings,
    };
}
