import { lazy, Suspense } from 'react';
import { ErrorBoundary } from '@/shared/ui/ErrorBoundary';
import { AssetBrowser } from '@/widgets/AssetBrowser/AssetBrowser';
import { Timeline } from '@/widgets/Timeline/Timeline';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import { SessionWorkspace } from './DawShellPanels';

const TrackInspector = lazy(async () => ({
    default: (await import('@/widgets/TrackInspector/TrackInspector')).TrackInspector,
}));

interface DawShellMainViewProps {
    mainSplitRef: React.RefObject<HTMLElement | null>;
    timelineRef: React.RefObject<HTMLDivElement | null>;
    browserWidth: number;
    beginBrowserResize: (event: React.MouseEvent<HTMLDivElement>) => void;
    mainViewMode: 'arrangement' | 'session';
    projectTracks: ProjectTrack[];
    selectedTrackId: string;
    selectedTrackIds: string[];
    onSelectTrack: (trackId: string) => void;
    onSelectTracks: (trackIds: string[], primaryId: string) => void;
    trackHeightBase: number;
    collapsedGroups: Set<string>;
    onToggleGroupCollapse: (trackId: string) => void;
    timelineProps: React.ComponentProps<typeof Timeline>;
}

export function DawShellMainView({
    mainSplitRef,
    timelineRef,
    browserWidth,
    beginBrowserResize,
    mainViewMode,
    projectTracks,
    selectedTrackId,
    selectedTrackIds,
    onSelectTrack,
    onSelectTracks,
    trackHeightBase,
    collapsedGroups,
    onToggleGroupCollapse,
    timelineProps,
}: DawShellMainViewProps) {
    return (
        <main ref={mainSplitRef} className="flex flex-1 overflow-hidden" style={{ gap: 0 }}>
            <aside
                className="shrink-0 h-full z-40 flex flex-col overflow-hidden"
                style={{
                    width: browserWidth,
                    background: 'var(--color-bg-panel)',
                    borderRight: '1px solid var(--color-divider)',
                }}
            >
                <ErrorBoundary module="Asset Browser">
                    <AssetBrowser />
                </ErrorBoundary>
            </aside>
            <div
                onMouseDown={beginBrowserResize}
                style={{ width: 6, cursor: 'ew-resize', background: 'transparent', flexShrink: 0 }}
            />

            {mainViewMode === 'arrangement' ? (
                <>
                    <div ref={timelineRef} className="flex-1 overflow-hidden" style={{ background: 'var(--color-bg-canvas)' }}>
                        <ErrorBoundary module="Timeline">
                            <Timeline {...timelineProps} />
                        </ErrorBoundary>
                    </div>

                    <aside
                        className="shrink-0 h-full z-40 flex flex-col overflow-hidden"
                        style={{
                            width: 'var(--daw-inspector-width)',
                            background: 'var(--color-bg-panel)',
                            borderLeft: '1px solid var(--color-divider)',
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
                <SessionWorkspace tracks={projectTracks} selectedTrackId={selectedTrackId} onSelectTrack={onSelectTrack} />
            )}
        </main>
    );
}
