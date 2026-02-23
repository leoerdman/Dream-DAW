import { lazy, Suspense, useEffect, useRef } from 'react';
import type { MidiNote } from '@/widgets/PianoRoll/PianoRoll';
import type { TimelineClip, BrowserDragItem } from '@/shared/lib/arrangementTypes';
import { ErrorBoundary } from '@/shared/ui/ErrorBoundary';
import { EmptyClipEditor, SampleClipEditor } from './DawShellPanels';

const DeviceRack = lazy(async () => ({
    default: (await import('@/widgets/DeviceRack/DeviceRack')).DeviceRack,
}));
const PianoRoll = lazy(async () => ({
    default: (await import('@/widgets/PianoRoll/PianoRoll')).PianoRoll,
}));

interface DawShellBottomPanelProps {
    selectedTrackId: string;
    bottomPanelMode: 'rack' | 'clip';
    hasResizableClipEditor: boolean;
    bottomPanelHeightPx: number;
    beginBottomPanelResize: (event: React.MouseEvent<HTMLDivElement>) => void;
    selectedTimelineClip: TimelineClip | undefined;
    clipColor: string;
    midiNotes: MidiNote[];
    aiVariationBusy: boolean;
    selectedMidiTotalBars: number;
    onDropPluginToTrack: (item: BrowserDragItem, trackId: string) => Promise<void>;
    onMidiNotesChange: (notes: MidiNote[]) => void;
    onMidiEnvelopesChange: (envelopes: Array<{ paramId: string; points: Array<{ beat: number; value: number }> }>) => void;
    onGenerateVariation: () => void;
}

export function DawShellBottomPanel({
    selectedTrackId,
    bottomPanelMode,
    hasResizableClipEditor,
    bottomPanelHeightPx,
    beginBottomPanelResize,
    selectedTimelineClip,
    clipColor,
    midiNotes,
    aiVariationBusy,
    selectedMidiTotalBars,
    onDropPluginToTrack,
    onMidiNotesChange,
    onMidiEnvelopesChange,
    onGenerateVariation,
}: DawShellBottomPanelProps) {
    const settleRafRef = useRef<number | null>(null);

    // Anti-jitter: freeze expensive panel/timeline reactions for one layout tick
    // when switching panel mode or clip target, then resume after layout settles.
    useEffect(() => {
        window.dispatchEvent(new Event('dream:bottom-panel-resize-start'));
        if (settleRafRef.current != null) {
            cancelAnimationFrame(settleRafRef.current);
            settleRafRef.current = null;
        }
        settleRafRef.current = requestAnimationFrame(() => {
            settleRafRef.current = requestAnimationFrame(() => {
                settleRafRef.current = null;
                window.dispatchEvent(new Event('dream:bottom-panel-resize-end'));
            });
        });
        return () => {
            if (settleRafRef.current != null) {
                cancelAnimationFrame(settleRafRef.current);
                settleRafRef.current = null;
            }
            window.dispatchEvent(new Event('dream:bottom-panel-resize-end'));
        };
    }, [bottomPanelMode, selectedTimelineClip?.id]);

    return (
        <footer
            className="shrink-0 z-40 overflow-hidden"
            style={{
                height: `var(--daw-bottom-panel-height, ${bottomPanelHeightPx}px)`,
                minHeight: 'var(--daw-device-rack-min-height)',
                borderTop: 'var(--space-px) solid var(--color-divider)',
                position: 'relative',
                contain: 'layout paint style',
            }}
        >
            {hasResizableClipEditor && (
                <div
                    onMouseDown={beginBottomPanelResize}
                    title="Resize Clip Editor"
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        height: 8,
                        cursor: 'ns-resize',
                        zIndex: 'var(--z-modal)' as unknown as number,
                        background: 'transparent',
                    }}
                >
                    <div
                        style={{
                            width: 56,
                            height: 2,
                            borderRadius: 'var(--radius-xs)',
                            background: 'color-mix(in srgb, var(--color-text-secondary) 45%, transparent)',
                            margin: 'var(--space-0-5) auto 0',
                        }}
                    />
                </div>
            )}
            {bottomPanelMode === 'rack' ? (
                <ErrorBoundary module="Device Rack">
                    <Suspense fallback={null}>
                        <DeviceRack
                            selectedTrackId={selectedTrackId}
                            onDropPluginToTrack={(item, trackId) => onDropPluginToTrack(item, trackId)}
                        />
                    </Suspense>
                </ErrorBoundary>
            ) : (
                <ErrorBoundary module="Clip Editor">
                    {selectedTimelineClip?.type === 'midi' ? (
                        <Suspense fallback={null}>
                            <PianoRoll
                                notes={midiNotes}
                                ghostNotes={[]}
                                midiEnvelopes={selectedTimelineClip.midiEnvelopes ?? []}
                                trackIndex={selectedTimelineClip.trackIndex}
                                onNotesChange={onMidiNotesChange}
                                onSetMidiEnvelopes={onMidiEnvelopesChange}
                                onGenerateVariation={onGenerateVariation}
                                aiVariationBusy={aiVariationBusy}
                                clipStartBeat={selectedTimelineClip.startBeat}
                                totalBars={selectedMidiTotalBars}
                                clipLengthBeats={selectedTimelineClip.durationBeats}
                                color={clipColor}
                            />
                        </Suspense>
                    ) : selectedTimelineClip?.type === 'audio' ? (
                        <SampleClipEditor
                            clip={selectedTimelineClip}
                        />
                    ) : (
                        <EmptyClipEditor />
                    )}
                </ErrorBoundary>
            )}
        </footer>
    );
}
