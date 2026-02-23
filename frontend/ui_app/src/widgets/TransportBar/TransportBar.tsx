import { useState, useRef, useCallback, useEffect } from 'react';
import { useClickOutside } from '@/shared/hooks/useClickOutside';
import { useGridStore } from '@/shared/stores/useGridStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
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
        engineSetLoop,
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
    const [timeSigIndex, setTimeSigIndex] = useState(0);
    const [timeSigNum, timeSigDen] = TIME_SIGNATURES[timeSigIndex] ?? [4, 4];
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
            const detected = Math.min(999, Math.max(20, 60000 / avg));
            const rounded = Math.round(detected * 100) / 100;
            engineSetBpm(rounded);
            setBpmText(rounded.toFixed(2));
        }
    }, [engineSetBpm]);
    // BUG-13 FIX: Wrapped in useCallback to prevent unnecessary re-renders of TransportLeftSection.
    const commitBpm = useCallback(() => {
        setBpmText((prev) => {
            const val = parseFloat(prev);
            if (!isNaN(val) && val >= 20 && val <= 999) {
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
    const cycleTimeSignature = useCallback(() => setTimeSigIndex((i) => (i + 1) % TIME_SIGNATURES.length), []);
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
            </div>
        </div>
    );
};
