import { useState, useRef, useCallback } from 'react';
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

    const { isRecording, handleRecordToggle, stopRecordingIfNeeded } = useTransportRecording(armedTrackIndex, onRecordingStateChange);
    const [bpmEditing, setBpmEditing] = useState(false);
    const [bpmText, setBpmText] = useState(bpm.toFixed(2));
    const bpmRef = useRef<HTMLInputElement>(null);

    const [timeSigIndex, setTimeSigIndex] = useState(0);
    const [timeSigNum, timeSigDen] = TIME_SIGNATURES[timeSigIndex] ?? [4, 4];

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

    const cycleKeyTonic = () => {
        const next = (keyTonic + 1) % KEY_TONICS.length;
        void engineApi
            .setKeySignatureWithDeltas(keyEnabled, KEY_TONICS[next], KEY_MODES[keyMode])
            .then((response) => useEngineStore.getState().applyProjectDeltas(response.deltas, 'transport:key-tonic'));
    };
    const cycleKeyMode = () => {
        const next = (keyMode + 1) % KEY_MODES.length;
        void engineApi
            .setKeySignatureWithDeltas(keyEnabled, KEY_TONICS[keyTonic], KEY_MODES[next])
            .then((response) => useEngineStore.getState().applyProjectDeltas(response.deltas, 'transport:key-mode'));
    };
    const cycleTimeSignature = () => setTimeSigIndex((i) => (i + 1) % TIME_SIGNATURES.length);
    const posString = `${position.bar}.${position.beat}.${position.sub.toString().padStart(2, '0')}`;
    const valueChipStyle: React.CSSProperties = {
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--font-size-sm)',
        fontWeight: 'var(--font-weight-bold)' as unknown as number,
        color: 'var(--color-text-primary)',
        background: 'var(--color-bg-input)',
        borderRadius: 'var(--radius-xs)',
        padding: '2px 8px',
        minWidth: 56,
        textAlign: 'center',
        border: 'none',
        cursor: 'pointer',
    };

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
                    cycleKeyTonic={cycleKeyTonic}
                    cycleKeyMode={cycleKeyMode}
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
                    onOpenExport={onOpenExport}
                    midiLedRef={midiLedRef}
                    trackCount={trackCount}
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
