import { ArrowRight, Circle, Pencil, Play, Rewind, RotateCcw, Square } from 'lucide-react';
import { beatToFrame, resolveBpm, resolveSampleRate } from '@/shared/lib/audioMath';
import * as engineApi from '@/shared/api/engine';
import { ControlButton, PillSection, TransportBtn } from './TransportAtoms';
import type { TransportCenterSectionProps } from './TransportSectionTypes';

export function TransportCenterSection(props: TransportCenterSectionProps) {
    const {
        isPlaying,
        enginePlay,
        engineStop,
        isRecording,
        handleRecordToggle,
        stopRecordingIfNeeded,
        isLooping,
        loopStartFrames,
        loopEndFrames,
        sampleRate,
        bpm,
        readPosBeats,
        timeSigNum,
        engineSetLoop,
        followPlayhead,
        onFollowPlayheadChange,
        pianoPencilMode,
        togglePianoPencilMode,
        automationVisible,
        onAutomationToggle,
        onFitTimelineHorizontally,
        onResetTrackHeights,
        posRef,
        valueChipStyle,
    } = props;

    return (
        <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)' }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
                <PillSection>
                    <TransportBtn icon={<Rewind size={13} fill="currentColor" />} title="Rewind to Start" onClick={() => { void engineApi.seekToBeat(0); }} />
                    <TransportBtn icon={<Play size={13} fill="currentColor" />} title="Play" isActive={isPlaying} activeColor="var(--color-status-success)" activeBackground={false} onClick={() => { void engineApi.stopPreview().catch((err) => console.warn('[Dream] stopPreview before play failed:', err)); void enginePlay(); }} />
                    <TransportBtn icon={<Square size={13} fill="currentColor" />} title="Stop" onClick={() => { engineStop(); void stopRecordingIfNeeded(); }} />
                    <TransportBtn icon={<Circle size={12} fill="currentColor" />} title="Record" isActive={isRecording} activeColor="var(--color-status-record)" className={isRecording ? 'animate-pulse-record' : ''} onClick={() => { void handleRecordToggle(); }} />
                    <TransportBtn icon={<RotateCcw size={13} />} title="Toggle Loop" isActive={isLooping} activeColor="var(--color-accent-primary)" onClick={() => { const next = !isLooping; if (next && loopStartFrames === 0 && loopEndFrames === 0) { const sr = resolveSampleRate(sampleRate); const currentBpm = resolveBpm(bpm); const posBeats = readPosBeats(); void engineSetLoop(true, beatToFrame(posBeats, currentBpm, sr), beatToFrame(posBeats + timeSigNum, currentBpm, sr)); } else { void engineSetLoop(next, loopStartFrames, loopEndFrames); } }} />
                    <TransportBtn icon={<ArrowRight size={13} strokeWidth={followPlayhead ? 3 : 2} />} title="Follow Playhead" isActive={followPlayhead} activeColor="var(--color-accent-primary)" onClick={() => onFollowPlayheadChange?.(!followPlayhead)} />
                </PillSection>
                <PillSection>
                    <span ref={posRef} style={{ ...valueChipStyle, minWidth: 74, textAlign: 'right', display: 'inline-block', cursor: 'default' }}>1.1.00</span>
                </PillSection>
                <PillSection>
                    <TransportBtn icon={<Pencil size={13} />} title="Pencil Mode" isActive={pianoPencilMode} activeColor="var(--color-accent-primary)" onClick={togglePianoPencilMode} />
                    <TransportBtn icon={<svg width={13} height={13} viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" /><text x="8" y="12" textAnchor="middle" fill="currentColor" fontSize="10" fontWeight="700" fontFamily="system-ui">A</text></svg>} title="Automation (A)" isActive={automationVisible} activeColor="var(--color-accent-primary)" onClick={() => onAutomationToggle?.()} />
                    <ControlButton label="W" onClick={() => onFitTimelineHorizontally?.()} />
                    <ControlButton label="H" onClick={() => onResetTrackHeights?.()} />
                </PillSection>
            </div>
        </div>
    );
}
