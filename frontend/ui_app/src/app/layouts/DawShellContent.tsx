import { memo } from 'react';
import { ErrorBoundary } from '@/shared/ui/ErrorBoundary';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import type { EntityState } from '@/shared/stores/engine/storeHelpers';
import { TransportBar } from '@/widgets/TransportBar/TransportBar';
import { DawShellBottomPanel } from './DawShellBottomPanel';
import { ProjectTabBar } from './ProjectTabBar';
import { DawShellMainView } from './DawShellMainView';
import { DawShellStatusArea } from './DawShellStatusArea';

interface DawShellContentProps {
    openSettings: () => void;
    handleOpenExport: () => void;
    handleRecordingStateChange: (state: { active: boolean; trackIndex: number }) => void;
    followPlayhead: boolean;
    setFollowPlayhead: (value: boolean) => void;
    automationVisible: boolean;
    toggleAutomation: () => void;
    handleFitTimelineHorizontally: () => void;
    handleResetTrackHeights: () => void;
    assistantOpen: boolean;
    handleAssistantToggle: () => void;
    mainSplitRef: React.RefObject<HTMLElement | null>;
    timelineRef: React.RefObject<HTMLDivElement | null>;
    browserWidth: number;
    beginBrowserResize: (event: React.MouseEvent<HTMLDivElement>) => void;
    mainViewMode: 'arrangement' | 'session' | 'flow';
    setMainViewMode: React.Dispatch<React.SetStateAction<'arrangement' | 'session' | 'flow'>>;
    isFlowAvailable: boolean;
    tracksEntity: EntityState<ProjectTrack>;
    selectedTrackId: string;
    selectedTrackIds: string[];
    handleSelectTrack: (trackId: string, options?: { preserveCursor?: boolean }) => void;
    handleSelectTracks: (trackIds: string[], primaryId: string, options?: { preserveCursor?: boolean }) => void;
    trackHeightBase: number;
    collapsedGroups: Set<string>;
    toggleGroupCollapse: (trackId: string) => void;
    timelineProps: React.ComponentProps<typeof import('@/widgets/Timeline/Timeline').Timeline>;
    bottomPanelMode: 'rack' | 'clip';
    hasResizableClipEditor: boolean;
    bottomPanelHeightPx: number;
    setBottomPanelHeightPx: React.Dispatch<React.SetStateAction<number>>;
    beginBottomPanelResize: (event: React.MouseEvent<HTMLDivElement>) => void;
    selectedTimelineClip: ReturnType<typeof import('./model/useArrangementTrackViewModel').useArrangementTrackViewModel>['selectedTimelineClip'] | undefined;
    clipColor: string;
    midiNotes: import('@/widgets/PianoRoll/model/pianoRollConfig').MidiNote[];
    aiVariationBusy: boolean;
    selectedMidiTotalBars: number;
    dropPluginOnTrack: (item: import('@/shared/lib/arrangementTypes').BrowserDragItem, trackId: string) => Promise<void>;
    handlePianoRollNotesChange: (clip: import('@/shared/lib/arrangementTypes').TimelineClip | undefined, notes: import('@/widgets/PianoRoll/model/pianoRollConfig').MidiNote[]) => void;
    handlePianoRollEnvelopesChange: (clip: import('@/shared/lib/arrangementTypes').TimelineClip | undefined, envelopes: Array<{ paramId: string; points: Array<{ beat: number; value: number }> }>) => void;
    handleGenerateMidiVariation: (clip: import('@/shared/lib/arrangementTypes').TimelineClip | undefined) => Promise<void>;
    missingAssetsOpen: boolean;
    missingMediaSummary: { offlineClipCount: number; missingPluginCount: number; total: number };
    setMissingAssetsOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setBottomPanelModeForActiveTrack: (next: 'rack' | 'clip' | ((prev: 'rack' | 'clip') => 'rack' | 'clip')) => void;
    panelInfo: string;
}

export const DawShellContent = memo(function DawShellContent(props: DawShellContentProps) {
    return (
        <div className="absolute inset-0 z-10 flex flex-col theme-ornament-shell">
            <ProjectTabBar />
            <header className="shrink-0 w-full flex items-center justify-center z-50 theme-ornament-header" style={{ height: 'var(--daw-transport-height)' }}>
                <ErrorBoundary module="Transport">
                    <TransportBar
                        onSettingsClick={props.openSettings}
                        onOpenExport={props.handleOpenExport}
                        onRecordingStateChange={props.handleRecordingStateChange}
                        followPlayhead={props.followPlayhead}
                        onFollowPlayheadChange={props.setFollowPlayhead}
                        automationVisible={props.automationVisible}
                        onAutomationToggle={props.toggleAutomation}
                        onFitTimelineHorizontally={props.handleFitTimelineHorizontally}
                        onResetTrackHeights={props.handleResetTrackHeights}
                        assistantOpen={props.assistantOpen}
                        onAssistantToggle={props.handleAssistantToggle}
                    />
                </ErrorBoundary>
            </header>

            <ErrorBoundary module="Arrangement">
                <DawShellMainView
                    mainSplitRef={props.mainSplitRef}
                    timelineRef={props.timelineRef}
                    browserWidth={props.browserWidth}
                    beginBrowserResize={props.beginBrowserResize}
                    mainViewMode={props.mainViewMode}
                    tracksEntity={props.tracksEntity}
                    selectedTrackId={props.selectedTrackId}
                    selectedTrackIds={props.selectedTrackIds}
                    onSelectTrack={props.handleSelectTrack}
                    onSelectTracks={props.handleSelectTracks}
                    trackHeightBase={props.trackHeightBase}
                    collapsedGroups={props.collapsedGroups}
                    onToggleGroupCollapse={props.toggleGroupCollapse}
                    timelineProps={props.timelineProps}
                />
            </ErrorBoundary>
            <ErrorBoundary module="Bottom Panel">
                <DawShellBottomPanel
                    selectedTrackId={props.selectedTrackId}
                    bottomPanelMode={props.bottomPanelMode}
                    hasResizableClipEditor={props.hasResizableClipEditor}
                    bottomPanelHeightPx={props.bottomPanelHeightPx}
                    setBottomPanelHeightPx={props.setBottomPanelHeightPx}
                    beginBottomPanelResize={props.beginBottomPanelResize}
                    selectedTimelineClip={props.selectedTimelineClip ?? undefined}
                    clipColor={props.clipColor}
                    midiNotes={props.midiNotes}
                    aiVariationBusy={props.aiVariationBusy}
                    selectedMidiTotalBars={props.selectedMidiTotalBars}
                    onDropPluginToTrack={(item, trackId) => props.dropPluginOnTrack(item, trackId)}
                    onMidiNotesChange={(notes) => props.handlePianoRollNotesChange(props.selectedTimelineClip ?? undefined, notes)}
                    onMidiEnvelopesChange={(envelopes) => props.handlePianoRollEnvelopesChange(props.selectedTimelineClip ?? undefined, envelopes)}
                    onGenerateVariation={() => props.handleGenerateMidiVariation(props.selectedTimelineClip ?? undefined)}
                    onSelectTrack={props.handleSelectTrack}
                />
            </ErrorBoundary>

            <DawShellStatusArea
                missingAssetsOpen={props.missingAssetsOpen}
                missingMediaSummary={props.missingMediaSummary}
                onToggleMissingAssets={() => props.setMissingAssetsOpen((v) => !v)}
                panelMode={props.bottomPanelMode}
                onPanelModeChange={props.setBottomPanelModeForActiveTrack}
                panelInfo={props.panelInfo}
                mainViewMode={props.mainViewMode}
                onMainViewModeChange={props.setMainViewMode}
                isFlowAvailable={props.isFlowAvailable}
            />
        </div>
    );
});
