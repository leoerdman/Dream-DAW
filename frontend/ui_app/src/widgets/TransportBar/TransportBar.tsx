import { useState, useRef, useCallback, useEffect } from 'react';
import { useGridStore } from '@/shared/stores/useGridStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import * as engineApi from '@/shared/api/engine';
import { useTransportEngineSlice } from './model/useTransportEngineSlice';
import {
    computeTransportPosition,
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
import { TRANSPORT_UI } from './ui/TransportAtoms';

interface TransportBarProps {
    onSettingsClick?: () => void;
    onOpenExport?: () => void;
    onRecordingStateChange?: (state: { active: boolean; trackIndex: number }) => void;
    followPlayhead?: boolean;
    onFollowPlayheadChange?: (enabled: boolean) => void;
    automationVisible?: boolean;
    onAutomationToggle?: () => void;
    onFitTimelineHorizontally?: () => void;
    onResetTrackHeights?: () => void;
    assistantOpen?: boolean;
    onAssistantToggle?: () => void;
}

export const TransportBar = ({
    onSettingsClick,
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
        posBeats,
        togglePlay,
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

    const [timeSigIndex, setTimeSigIndex] = useState(0);
    const [timeSigNum, timeSigDen] = TIME_SIGNATURES[timeSigIndex] ?? [4, 4];
    const [keyMenuOpen, setKeyMenuOpen] = useState(false);
    const keyMenuRef = useRef<HTMLDivElement | null>(null);
    const [gridOpen, setGridOpen] = useState(false);
    const gridRef = useRef<HTMLDivElement | null>(null);

    const keyEnabled = storeKeySigEnabled;
    const keyTonic = resolveKeyTonicIndex(storeKeySigTonic);
    const keyMode = resolveKeyModeIndex(storeKeySigMode);

    const position = computeTransportPosition(posBeats, timeSigNum);

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

    const commitBpm = () => {
        const val = parseFloat(bpmText);
        if (!isNaN(val) && val >= 20 && val <= 999) {
            const rounded = Math.round(val * 100) / 100;
            engineSetBpm(rounded);
            setBpmText(rounded.toFixed(2));
        } else {
            setBpmText(bpm.toFixed(2));
        }
        setBpmEditing(false);
    };

    const setKeyTonicAt = (index: number) => {
        const next = Math.max(0, Math.min(KEY_TONICS.length - 1, index));
        void engineApi
            .setKeySignatureWithDeltas(keyEnabled, KEY_TONICS[next], KEY_MODES[keyMode])
            .then((response) => useEngineStore.getState().applyProjectDeltas(response.deltas, 'transport:key-tonic'));
    };
    const setKeyModeAt = (index: number) => {
        const next = Math.max(0, Math.min(KEY_MODES.length - 1, index));
        void engineApi
            .setKeySignatureWithDeltas(keyEnabled, KEY_TONICS[keyTonic], KEY_MODES[next])
            .then((response) => useEngineStore.getState().applyProjectDeltas(response.deltas, 'transport:key-mode'));
    };
    const toggleKeyEnabled = () => {
        const next = !keyEnabled;
        void engineApi
            .setKeySignatureWithDeltas(next, KEY_TONICS[keyTonic], KEY_MODES[keyMode])
            .then((response) => useEngineStore.getState().applyProjectDeltas(response.deltas, 'transport:key-enabled'));
    };
    const cycleTimeSignature = () => setTimeSigIndex((i) => (i + 1) % TIME_SIGNATURES.length);
    const posString = `${position.bar}.${position.beat}.${position.sub.toString().padStart(2, '0')}`;
    const valueChipStyle: React.CSSProperties = {
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--font-size-xs)',
        fontWeight: 'var(--font-weight-semibold)' as unknown as number,
        color: 'var(--color-text-primary)',
        background: TRANSPORT_UI.controlBg,
        borderRadius: TRANSPORT_UI.controlRadius,
        padding: '0 8px',
        minWidth: 56,
        height: TRANSPORT_UI.controlHeight,
        lineHeight: `${TRANSPORT_UI.controlHeight}px`,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        border: TRANSPORT_UI.controlBorder,
        cursor: 'pointer',
    };

    useEffect(() => {
        if (!keyMenuOpen) return;
        const onDown = (e: MouseEvent) => {
            if (keyMenuRef.current && !keyMenuRef.current.contains(e.target as Node)) {
                setKeyMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [keyMenuOpen]);

    useEffect(() => {
        if (!gridOpen) return;
        const onDown = (e: MouseEvent) => {
            if (gridRef.current && !gridRef.current.contains(e.target as Node)) {
                setGridOpen(false);
            }
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [gridOpen]);

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
                    togglePlay={togglePlay}
                    engineStop={engineStop}
                    isRecording={isRecording}
                    handleRecordToggle={handleRecordToggle}
                    stopRecordingIfNeeded={stopRecordingIfNeeded}
                    isLooping={isLooping}
                    loopStartFrames={loopStartFrames}
                    loopEndFrames={loopEndFrames}
                    sampleRate={sampleRate}
                    bpm={bpm}
                    posBeats={posBeats}
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
                    posString={posString}
                    valueChipStyle={valueChipStyle}
                />

                <TransportRightSection
                    midiLedRef={midiLedRef}
                    pdcOpen={pdcOpen}
                    setPdcOpen={setPdcOpen}
                    assistantOpen={assistantOpen}
                    onAssistantToggle={onAssistantToggle}
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
                        posString={posString}
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
