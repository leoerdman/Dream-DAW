import { memo, lazy, Suspense, useMemo } from 'react';
import { ErrorBoundary } from '@/shared/ui/ErrorBoundary';
import { AssetBrowser } from '@/widgets/AssetBrowser/AssetBrowser';
import { Timeline } from '@/widgets/Timeline/Timeline';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import type { EntityState } from '@/shared/stores/engine/storeHelpers';
import { SessionWorkspace } from './DawShellPanels';
import { useFlowSynthStore } from '@/widgets/FlowSynth/model/useFlowSynthStore';

const TrackInspector = lazy(async () => ({
    default: (await import('@/widgets/TrackInspector/TrackInspector')).TrackInspector,
}));

const FlowSynthInlineView = lazy(async () => ({
    default: (await import('@/widgets/FlowSynth/ui/FlowSynthInlineView')).FlowSynthInlineView,
}));

interface DawShellMainViewProps {
    mainSplitRef: React.RefObject<HTMLElement | null>;
    timelineRef: React.RefObject<HTMLDivElement | null>;
    browserWidth: number;
    beginBrowserResize: (event: React.MouseEvent<HTMLDivElement>) => void;
    mainViewMode: 'arrangement' | 'session';
    tracksEntity: EntityState<ProjectTrack>;
    selectedTrackId: string;
    selectedTrackIds: string[];
    onSelectTrack: (trackId: string, options?: { preserveCursor?: boolean }) => void;
    onSelectTracks: (trackIds: string[], primaryId: string, options?: { preserveCursor?: boolean }) => void;
    trackHeightBase: number;
    collapsedGroups: Set<string>;
    onToggleGroupCollapse: (trackId: string) => void;
    timelineProps: React.ComponentProps<typeof Timeline>;
}

export const DawShellMainView = memo(({
    mainSplitRef,
    timelineRef,
    browserWidth,
    beginBrowserResize,
    mainViewMode,
    tracksEntity,
    selectedTrackId,
    selectedTrackIds,
    onSelectTrack,
    onSelectTracks,
    trackHeightBase,
    collapsedGroups,
    onToggleGroupCollapse,
    timelineProps,
}: DawShellMainViewProps) => {
    const sessionTracks = useMemo(
        () => tracksEntity.allIds.map((trackId) => tracksEntity.byId[trackId]).filter(Boolean),
        [tracksEntity],
    );

    // ENTERPRISE: Check if FlowSynth is in inline mode (replaces timeline)
    const flowInlineActive = useFlowSynthStore((s) => s.isOpen && s.displayMode === 'inline');

    return (
        <main ref={mainSplitRef} className="flex flex-1 overflow-hidden" style={{ gap: 0 }}>
            <aside
                className="shrink-0 h-full z-40 flex flex-col overflow-hidden theme-ornament-browser"
                style={{
                    width: browserWidth,
                    background: 'var(--color-bg-panel)',
                    borderRight: 'var(--space-px) solid var(--color-divider)',
                }}
            >
                <ErrorBoundary module="Asset Browser">
                    <AssetBrowser />
                </ErrorBoundary>
            </aside>
            <div className="relative shrink-0 z-50" style={{ width: 0 }}>
                <div
                    onMouseDown={beginBrowserResize}
                    className="absolute top-0 bottom-0 left-[-3px] w-[6px] cursor-ew-resize hover:bg-white/5 transition-colors"
                    title="Resize Browser"
                />
            </div>

            {mainViewMode === 'arrangement' ? (
                <>
                    <div ref={timelineRef} className="flex-1 overflow-hidden" style={{ background: 'var(--color-bg-canvas)' }}>
                        {flowInlineActive ? (
                            <ErrorBoundary module="FlowSynth Inline">
                                <Suspense fallback={null}>
                                    <FlowSynthInlineView />
                                </Suspense>
                            </ErrorBoundary>
                        ) : (
                            <ErrorBoundary module="Timeline">
                                <Timeline {...timelineProps} />
                            </ErrorBoundary>
                        )}
                    </div>

                    <aside
                        className="shrink-0 h-full z-40 flex flex-col overflow-hidden theme-ornament-inspector"
                        style={{
                            width: 'var(--daw-inspector-width)',
                            background: 'var(--color-bg-panel)',
                            borderLeft: 'var(--space-px) solid var(--color-divider)',
                        }}
                    >
                        <ErrorBoundary module="Track Inspector">
                            <Suspense fallback={null}>
                                <TrackInspector
                                    selectedTrackId={selectedTrackId}
                                    selectedTrackIds={selectedTrackIds}
                                    onSelectTracks={onSelectTracks}
                                    onSelectTrack={onSelectTrack}
                                    trackHeight={trackHeightBase}
                                    rulerHeight={28}
                                    mixerFocusMode={false}
                                    collapsedGroups={collapsedGroups}
                                    onToggleGroupCollapse={onToggleGroupCollapse}
                                />
                            </Suspense>
                        </ErrorBoundary>
                    </aside>
                </>
            ) : (
                <SessionWorkspace tracks={sessionTracks} selectedTrackId={selectedTrackId} onSelectTrack={onSelectTrack} />
            )}
        </main>
    );
});
