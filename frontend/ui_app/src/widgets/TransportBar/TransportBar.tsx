import { useState, useRef, useCallback, useEffect } from 'react';
import { useClickOutside } from '@/shared/hooks/useClickOutside';
import { useGridStore } from '@/shared/stores/useGridStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { MIN_BPM, MAX_BPM, clampTimeSigNumerator, clampTimeSigDenominator, DEFAULT_TIME_SIG_NUMERATOR, DEFAULT_TIME_SIG_DENOMINATOR } from '@/shared/lib/audioMath';
import * as engineApi from '@/shared/api/engine';
import { useTransportEngineSlice, usePositionRef } from './model/useTransportEngineSlice';
import {
    KEY_MODES,
    KEY_TONICS,
    resolveKeyModeIndex,
    resolveKeyTonicIndex,
    TIME_SIGNATURES,
} from './model/transportBarDomain';
import { DebugPanel } from './ui/DebugPanel';
import { NotesPanel, readNotesPinned, writeNotesPinned } from './ui/NotesPanel';
import { useTransportDebugPanel } from './model/useTransportDebugPanel';
import { useMidiActivityLed } from './model/useMidiActivityLed';
import { useTransportRecording } from './model/useTransportRecording';
import { TransportCenterSection, TransportLeftSection, TransportRightSection } from './ui/TransportSections';
import { valueChipStyle } from './model/transportBarStyles';
import type { TransportBarProps } from './model/transportBarTypes';
export const TransportBar = ({
    onSettingsClick,
    onOpenExport,
    onRecordingStateChange,
    followPlayhead = false,
    onFollowPlayheadChange,
    automationVisible = false,
    onAutomationToggle,
    onFitTimelineHorizontally,
    onResetTrackHeights,
    assistantOpen = false,
    onAssistantToggle,
}: TransportBarProps) => {
    const {
        isPlaying,
        bpm,
        isLooping,
        loopStartFrames,
        loopEndFrames,
        sampleRate,
        enginePlay,
        engineStop,
        engineSetBpm,
        engineSetTimeSignature,
        engineSetLoop,
        timeSigNumerator,
        timeSigDenominator,
        trackCount,
        armedTrackIndex,
        telemetryRunning,
        engineConnected,
        engineLastError,
        sandboxSnapshot,
        storeKeySigEnabled,
        storeKeySigTonic,
        storeKeySigMode,
    } = useTransportEngineSlice();
    const pianoPencilMode = useGridStore((s) => s.pianoPencilMode);
    const togglePianoPencilMode = useGridStore((s) => s.togglePianoPencilMode);
    const gridDivision = useGridStore((s) => s.division);
    const gridTriplet = useGridStore((s) => s.triplet);
    const setGridDivision = useGridStore((s) => s.setDivision);
    const { isRecording, handleRecordToggle, stopRecordingIfNeeded } = useTransportRecording(armedTrackIndex, onRecordingStateChange);
    const [bpmEditing, setBpmEditing] = useState(false);
    const [bpmText, setBpmText] = useState(bpm.toFixed(2));
    const bpmRef = useRef<HTMLInputElement>(null);
    // BUG-7 FIX: Sync bpmText when engine BPM changes externally (automation, MIDI controller).
    useEffect(() => {
        if (bpmEditing) return;
        const rafId = requestAnimationFrame(() => {
            setBpmText(bpm.toFixed(2));
        });
        return () => cancelAnimationFrame(rafId);
    }, [bpm, bpmEditing]);
    const timeSigNum = clampTimeSigNumerator(timeSigNumerator || DEFAULT_TIME_SIG_NUMERATOR);
    const timeSigDen = clampTimeSigDenominator(timeSigDenominator || DEFAULT_TIME_SIG_DENOMINATOR);
    const [keyMenuOpen, setKeyMenuOpen] = useState(false);
    const keyMenuRef = useRef<HTMLDivElement | null>(null);
    const [gridOpen, setGridOpen] = useState(false);
    const gridRef = useRef<HTMLDivElement | null>(null);
    const keyEnabled = storeKeySigEnabled;
    const keyTonic = resolveKeyTonicIndex(storeKeySigTonic);
    const keyMode = resolveKeyModeIndex(storeKeySigMode);
    // PERF-FIX: Position display is now ref-based (zero React re-renders).
    // posRef is attached to the position <span> in TransportCenterSection.
    // readPosBeats() provides imperative access for loop toggle.
    const { posRef, readPosBeats } = usePositionRef(timeSigNum);
    const tapTimestamps = useRef<number[]>([]);
    const { midiLedRef } = useMidiActivityLed();
    const {
        pdcOpen,
        setPdcOpen,
        debugTab,
        setDebugTab,
        pdcLoading,
        pdcError,
        pdcSnapshot,
        rtSnapshot,
        rtLoading,
        rtError,
        sandboxLoading,
        sandboxError,
        sandboxRuntime,
        pdcPanelRef,
        pdcPanelPos,
        handlePdcDragStart,
        refreshSnapshots,
        tickWatchdog,
    } = useTransportDebugPanel();

    // ── Notes Panel State ──────────────────────────────────────────
    const NOTES_POS_KEY = 'dream-daw-notes-panel-pos';
    const DEFAULT_NOTES_POS = { right: 220, top: 56 };
    const [notesOpen, setNotesOpen] = useState(false);
    const notesPanelRef = useRef<HTMLDivElement | null>(null);
    const [notesPanelPos, setNotesPanelPos] = useState(DEFAULT_NOTES_POS);
    const notesDragRef = useRef<{ dragging: boolean; startX: number; startY: number; baseRight: number; baseTop: number }>({
        dragging: false, startX: 0, startY: 0, baseRight: DEFAULT_NOTES_POS.right, baseTop: DEFAULT_NOTES_POS.top,
    });
    const [notesPinned, setNotesPinned] = useState(() => readNotesPinned());
    const handlePinnedChange = useCallback((pinned: boolean) => {
        setNotesPinned(pinned);
        writeNotesPinned(pinned);
    }, []);

    // Persist notes panel position
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
            const raw = localStorage.getItem(NOTES_POS_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw) as { right?: number; top?: number };
            if (typeof parsed.right === 'number' && typeof parsed.top === 'number') {
                const r = parsed.right;
                const t = parsed.top;
                timer = setTimeout(() => setNotesPanelPos({
                    right: Math.max(8, Math.min(r, window.innerWidth - 200)),
                    top: Math.max(40, Math.min(t, window.innerHeight - 200)),
                }), 0);
            }
        } catch { /* ignore */ }
        return () => { if (timer) clearTimeout(timer); };
    }, []);
    useEffect(() => {
        try { localStorage.setItem(NOTES_POS_KEY, JSON.stringify(notesPanelPos)); } catch { /* ignore */ }
    }, [notesPanelPos]);

    useEffect(() => {
        if (!notesOpen) return;
        // When pinned, skip click-outside close (only Escape still works).
        const onDown = notesPinned ? undefined : (e: globalThis.MouseEvent) => {
            const target = e.target as Node;
            if (notesPanelRef.current && !notesPanelRef.current.contains(target)) {
                const btn = (target as HTMLElement).closest?.('[aria-label="Project Notes"]');
                if (btn) return;
                setNotesOpen(false);
            }
        };
        const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setNotesOpen(false); };
        if (onDown) document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onEsc);
        return () => {
            if (onDown) document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onEsc);
        };
    }, [notesOpen, notesPinned]);

    // ── Option+N global hotkey toggles Notes panel ───────────────────
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.altKey && e.key.toLowerCase() === 'n' && !e.repeat) {
                e.preventDefault();
                setNotesOpen((v) => !v);
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, []);

    // Drag handling
    const handleNotesDragStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        notesDragRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, baseRight: notesPanelPos.right, baseTop: notesPanelPos.top };
        e.preventDefault();
    }, [notesPanelPos.right, notesPanelPos.top]);
    useEffect(() => {
        if (!notesOpen) return;
        const onMove = (e: MouseEvent) => {
            if (!notesDragRef.current.dragging) return;
            const dx = e.clientX - notesDragRef.current.startX;
            const dy = e.clientY - notesDragRef.current.startY;
            setNotesPanelPos({
                right: Math.max(8, Math.min(notesDragRef.current.baseRight - dx, window.innerWidth - 200)),
                top: Math.max(40, Math.min(notesDragRef.current.baseTop + dy, window.innerHeight - 200)),
            });
        };
        const onUp = () => { notesDragRef.current.dragging = false; };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    }, [notesOpen]);

    const handleTapTempo = useCallback(() => {
        const now = Date.now();
        const taps = tapTimestamps.current;
        if (taps.length > 0 && now - taps[taps.length - 1] > 3000) {
            tapTimestamps.current = [];
        }
        taps.push(now);
        if (taps.length > 8) taps.shift();
        if (taps.length >= 2) {
            let total = 0;
            for (let i = 1; i < taps.length; i++) total += taps[i] - taps[i - 1];
            const avg = total / (taps.length - 1);
            const detected = Math.min(MAX_BPM, Math.max(MIN_BPM, 60000 / avg));
            const rounded = Math.round(detected * 100) / 100;
            engineSetBpm(rounded);
            setBpmText(rounded.toFixed(2));
        }
    }, [engineSetBpm]);
    // BUG-13 FIX: Wrapped in useCallback to prevent unnecessary re-renders of TransportLeftSection.
    const commitBpm = useCallback(() => {
        setBpmText((prev) => {
            const val = parseFloat(prev);
            if (!isNaN(val) && val >= MIN_BPM && val <= MAX_BPM) {
                const rounded = Math.round(val * 100) / 100;
                engineSetBpm(rounded);
                return rounded.toFixed(2);
            }
            return bpm.toFixed(2);
        });
        setBpmEditing(false);
    }, [bpm, engineSetBpm]);
    // BUG-14 FIX: All 4 handlers wrapped in useCallback.
    const setKeyTonicAt = useCallback((index: number) => {
        const next = Math.max(0, Math.min(KEY_TONICS.length - 1, index));
        void engineApi
            .setKeySignatureWithDeltas(keyEnabled, KEY_TONICS[next], KEY_MODES[keyMode])
            .then((response) => useEngineStore.getState().applyProjectDeltas(response.deltas, 'transport:key-tonic'));
    }, [keyEnabled, keyMode]);
    const setKeyModeAt = useCallback((index: number) => {
        const next = Math.max(0, Math.min(KEY_MODES.length - 1, index));
        void engineApi
            .setKeySignatureWithDeltas(keyEnabled, KEY_TONICS[keyTonic], KEY_MODES[next])
            .then((response) => useEngineStore.getState().applyProjectDeltas(response.deltas, 'transport:key-mode'));
    }, [keyEnabled, keyTonic]);
    const toggleKeyEnabled = useCallback(() => {
        const next = !keyEnabled;
        void engineApi
            .setKeySignatureWithDeltas(next, KEY_TONICS[keyTonic], KEY_MODES[keyMode])
            .then((response) => useEngineStore.getState().applyProjectDeltas(response.deltas, 'transport:key-enabled'));
    }, [keyEnabled, keyTonic, keyMode]);
    const cycleTimeSignature = useCallback(() => {
        const currentIndex = TIME_SIGNATURES.findIndex(([n, d]) => n === timeSigNum && d === timeSigDen);
        const nextIndex = currentIndex >= 0
            ? (currentIndex + 1) % TIME_SIGNATURES.length
            : 0;
        const [nextNum, nextDen] = TIME_SIGNATURES[nextIndex] ?? [4, 4];
        void engineSetTimeSignature(nextNum, nextDen);
    }, [engineSetTimeSignature, timeSigNum, timeSigDen]);
    // BUG-11 FIX: Replaced 2 inline click-outside effects with shared useClickOutside hook.
    const closeKeyMenu = useCallback(() => setKeyMenuOpen(false), []);
    const closeGridMenu = useCallback(() => setGridOpen(false), []);
    useClickOutside(keyMenuRef, closeKeyMenu, keyMenuOpen);
    useClickOutside(gridRef, closeGridMenu, gridOpen);
    // BUG-42 FIX: Escape key closes open menus.
    useEffect(() => {
        if (!keyMenuOpen && !gridOpen) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (keyMenuOpen) setKeyMenuOpen(false);
                if (gridOpen) setGridOpen(false);
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [keyMenuOpen, gridOpen]);

    // ── ENTERPRISE: "A" keyboard shortcut toggles automation mode ─────
    // Matches Bitwig Studio 6 behavior: pressing [A] switches to Automation Mode.
    // Ignored when focus is in an input field or text area to avoid conflicts.
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key.toLowerCase() !== 'a' || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
            const target = e.target as HTMLElement;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
            e.preventDefault();
            onAutomationToggle?.();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [onAutomationToggle]);
    return (
        <div data-testid="transport-bar" className="glass-pill" style={{ height: 'var(--daw-transport-height)', zIndex: 'var(--z-transport)' }}>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', height: '100%', width: '100%' }}>
                <TransportLeftSection
                    handleTapTempo={handleTapTempo}
                    bpmEditing={bpmEditing}
                    bpmText={bpmText}
                    setBpmText={setBpmText}
                    commitBpm={commitBpm}
                    setBpmEditing={setBpmEditing}
                    bpm={bpm}
                    bpmRef={bpmRef}
                    valueChipStyle={valueChipStyle}
                    cycleTimeSignature={cycleTimeSignature}
                    timeSigNum={timeSigNum}
                    timeSigDen={timeSigDen}
                    keyEnabled={keyEnabled}
                    keyTonic={keyTonic}
                    keyMode={keyMode}
                    keyMenuRef={keyMenuRef}
                    keyMenuOpen={keyMenuOpen}
                    setKeyMenuOpen={setKeyMenuOpen}
                    onToggleKeyEnabled={toggleKeyEnabled}
                    onSelectKeyTonic={setKeyTonicAt}
                    onSelectKeyMode={setKeyModeAt}
                    gridRef={gridRef}
                    gridOpen={gridOpen}
                    setGridOpen={setGridOpen}
                    gridDivision={gridDivision}
                    gridTriplet={gridTriplet}
                    setGridDivision={setGridDivision}
                />
                <TransportCenterSection
                    isPlaying={isPlaying}
                    enginePlay={enginePlay}
                    engineStop={engineStop}
                    isRecording={isRecording}
                    handleRecordToggle={handleRecordToggle}
                    stopRecordingIfNeeded={stopRecordingIfNeeded}
                    isLooping={isLooping}
                    loopStartFrames={loopStartFrames}
                    loopEndFrames={loopEndFrames}
                    sampleRate={sampleRate}
                    bpm={bpm}
                    readPosBeats={readPosBeats}
                    timeSigNum={timeSigNum}
                    engineSetLoop={engineSetLoop}
                    followPlayhead={followPlayhead}
                    onFollowPlayheadChange={onFollowPlayheadChange}
                    pianoPencilMode={pianoPencilMode}
                    togglePianoPencilMode={togglePianoPencilMode}
                    automationVisible={automationVisible}
                    onAutomationToggle={onAutomationToggle}
                    onFitTimelineHorizontally={onFitTimelineHorizontally}
                    onResetTrackHeights={onResetTrackHeights}
                    posRef={posRef}
                    valueChipStyle={valueChipStyle}
                />
                <TransportRightSection
                    midiLedRef={midiLedRef}
                    pdcOpen={pdcOpen}
                    setPdcOpen={setPdcOpen}
                    assistantOpen={assistantOpen}
                    onAssistantToggle={onAssistantToggle}
                    notesOpen={notesOpen}
                    setNotesOpen={setNotesOpen}
                    onOpenExport={onOpenExport}
                    onSettingsClick={onSettingsClick}
                />
                {pdcOpen && (
                    <DebugPanel
                        panelRef={pdcPanelRef}
                        panelPos={pdcPanelPos}
                        onDragStart={handlePdcDragStart}
                        onRefresh={refreshSnapshots}
                        onClose={() => setPdcOpen(false)}
                        debugTab={debugTab}
                        setDebugTab={setDebugTab}
                        onTickWatchdog={tickWatchdog}
                        pdcSnapshot={pdcSnapshot}
                        rtSnapshot={rtSnapshot}
                        sandboxSnapshot={sandboxSnapshot}
                        sandboxRuntime={sandboxRuntime}
                        engineConnected={engineConnected}
                        telemetryRunning={telemetryRunning}
                        isPlaying={isPlaying}
                        bpm={bpm}
                        posString={`${readPosBeats().toFixed(2)}`}
                        sampleRate={sampleRate}
                        trackCount={trackCount}
                        engineLastError={engineLastError ?? ''}
                        pdcLoading={pdcLoading}
                        rtLoading={rtLoading}
                        sandboxLoading={sandboxLoading}
                        pdcError={pdcError}
                        rtError={rtError}
                        sandboxError={sandboxError}
                    />
                )}
                {notesOpen && (
                    <NotesPanel
                        panelRef={notesPanelRef}
                        panelPos={notesPanelPos}
                        onDragStart={handleNotesDragStart}
                        onClose={() => setNotesOpen(false)}
                        pinned={notesPinned}
                        onPinnedChange={handlePinnedChange}
                    />
                )}
            </div>
        </div>
    );
};
