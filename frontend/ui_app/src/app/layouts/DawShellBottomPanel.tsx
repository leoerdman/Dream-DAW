import { lazy, Suspense, useCallback, useEffect, useRef } from 'react';
import type { MidiNote } from '@/widgets/PianoRoll/model/pianoRollConfig';
import type { TimelineClip, BrowserDragItem } from '@/shared/lib/arrangementTypes';
import {
    BOTTOM_PANEL_HEIGHT_DEFAULT_PX,
    BOTTOM_PANEL_RACK_EXPANDED_PX,
} from '@/shared/config/layoutConstants';
import { ErrorBoundary } from '@/shared/ui/ErrorBoundary';
import { EmptyClipEditor, SampleClipEditor } from './DawShellPanels';

const DeviceRack = lazy(async () => ({
    default: (await import('@/widgets/DeviceRack/DeviceRack')).DeviceRack,
}));
const PianoRoll = lazy(async () => ({
    default: (await import('@/widgets/PianoRoll/PianoRoll')).PianoRoll,
}));
const MixerPanelLazy = lazy(async () => ({
    default: (await import('@/widgets/MixerPanel/MixerPanel')).MixerPanel,
}));

interface DawShellBottomPanelProps {
    selectedTrackId: string;
    bottomPanelMode: 'rack' | 'clip' | 'mixer';
    hasResizableClipEditor: boolean;
    bottomPanelHeightPx: number;
    setBottomPanelHeightPx: React.Dispatch<React.SetStateAction<number>>;
    beginBottomPanelResize: (event: React.PointerEvent<HTMLDivElement>) => void;
    selectedTimelineClip: TimelineClip | undefined;
    clipColor: string;
    midiNotes: MidiNote[];
    aiVariationBusy: boolean;
    selectedMidiTotalBars: number;
    onDropPluginToTrack: (item: BrowserDragItem, trackId: string) => Promise<void>;
    onMidiNotesChange: (notes: MidiNote[]) => void;
    onMidiEnvelopesChange: (envelopes: Array<{ paramId: string; points: Array<{ beat: number; value: number }> }>) => void;
    onGenerateVariation: () => void;
    /** BUG-017 FIX: Handler for selecting a track from the mixer panel. */
    onSelectTrack: (trackId: string) => void;
}

/** Minimum vertical drag distance to trigger a toggle (prevents accidental clicks). */
const RACK_DRAG_THRESHOLD_PX = 12;

export function DawShellBottomPanel({
    selectedTrackId,
    bottomPanelMode,
    hasResizableClipEditor,
    bottomPanelHeightPx,
    setBottomPanelHeightPx,
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
    onSelectTrack,
}: DawShellBottomPanelProps) {
    const settleRafRef = useRef<number | null>(null);
    const rackExpanded = bottomPanelHeightPx >= BOTTOM_PANEL_RACK_EXPANDED_PX;

    // ── Rack 2-position instant snap ──
    // No live preview. Drag up → expand to 2 rows. Drag down → collapse to 1 row.
    const rackDragStartYRef = useRef(0);

    const onRackDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        rackDragStartYRef.current = e.clientY;
    }, []);

    const onRackDragEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        const deltaY = rackDragStartYRef.current - e.clientY; // positive = dragged up
        if (Math.abs(deltaY) < RACK_DRAG_THRESHOLD_PX) return; // ignore tiny movements
        const shouldExpand = deltaY > 0;
        const target = shouldExpand ? BOTTOM_PANEL_RACK_EXPANDED_PX : BOTTOM_PANEL_HEIGHT_DEFAULT_PX;
        setBottomPanelHeightPx(target);
    }, [setBottomPanelHeightPx]);

    const onRackDragCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
    }, []);

    // Anti-jitter: freeze expensive panel/timeline reactions for one layout tick
    // when switching panel mode or clip target, then resume after layout settles.
    useEffect(() => {
        window.dispatchEvent(new Event('dream:bottom-panel-resize-start'));
        if (settleRafRef.current != null) {
            cancelAnimationFrame(settleRafRef.current);
            settleRafRef.current = null;
        }
        settleRafRef.current = requestAnimationFrame(() => {
            settleRafRef.current = null;
            window.dispatchEvent(new Event('dream:bottom-panel-resize-end'));
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
            {/* ── Resize handle: Clip editor (free drag) or Rack (2-position snap) ── */}
            {(hasResizableClipEditor || bottomPanelMode === 'rack') && (
                <div
                    onPointerDown={hasResizableClipEditor ? beginBottomPanelResize : bottomPanelMode === 'rack' ? onRackDragStart : undefined}
                    onPointerUp={bottomPanelMode === 'rack' ? onRackDragEnd : undefined}
                    onPointerCancel={bottomPanelMode === 'rack' ? onRackDragCancel : undefined}
                    title={bottomPanelMode === 'rack' ? 'Drag to expand plugin rack' : 'Resize Panel'}
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        height: 'var(--daw-resize-handle-size)',
                        cursor: 'ns-resize',
                        zIndex: 'var(--z-modal)',
                        touchAction: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'var(--daw-resize-strip-bg)',
                        transition: 'background var(--transition-fast)',
                    }}
                >

                </div>
            )}
            {bottomPanelMode === 'rack' ? (
                <ErrorBoundary module="Device Rack">
                    <Suspense fallback={null}>
                        <DeviceRack
                            selectedTrackId={selectedTrackId}
                            rackExpanded={rackExpanded}
                            onDropPluginToTrack={(item, trackId) => onDropPluginToTrack(item, trackId)}
                        />
                    </Suspense>
                </ErrorBoundary>
            ) : bottomPanelMode === 'mixer' ? (
                <ErrorBoundary module="Mixer Panel">
                    <Suspense fallback={null}>
                        <MixerPanelLazy
                            selectedTrackId={selectedTrackId}
                            onSelectTrack={onSelectTrack}
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
