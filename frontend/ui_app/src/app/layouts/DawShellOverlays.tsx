import { lazy, Suspense } from 'react';
import { AssistantChat } from '@/widgets/AssistantChat/AssistantChat';
import { AgentActionIndicator } from '@/widgets/AgentActionIndicator/AgentActionIndicator';
import { DragOverlay } from '@/widgets/DragOverlay/DragOverlay';
import { ErrorBoundary } from '@/shared/ui/ErrorBoundary';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';

const SettingsPanel = lazy(async () => ({
    default: (await import('@/widgets/SettingsPanel/SettingsPanel')).SettingsPanel,
}));
const ExportModal = lazy(async () => ({
    default: (await import('@/widgets/ExportModal/ExportModal')).ExportModal,
}));
const BlockingJobPopup = lazy(async () => ({
    default: (await import('@/widgets/BlockingJobPopup/BlockingJobPopup')).BlockingJobPopup,
}));
const MissingAssetsPanel = lazy(async () => ({
    default: (await import('@/widgets/MissingAssetsPanel/MissingAssetsPanel')).MissingAssetsPanel,
}));

interface DawShellOverlaysProps {
    settingsOpen: boolean;
    onCloseSettings: () => void;
    assistantOpen: boolean;
    onAssistantOpen: () => void;
    onAssistantClose: () => void;
    onSelectClips: (ids: string[]) => void;
    missingAssetsOpen: boolean;
    missingTotal: number;
    onCloseMissingAssets: () => void;
    exportOpen: boolean;
    onCloseExport: () => void;
    projectName: string;
    selectedClipIds: string[];
    timelineClipsForView: TimelineClip[];
    bpm: number;
    sampleRate: number;
    loopStartBeat: number;
    loopEndBeat: number;
    marqueeSelection: { startBeat: number; endBeat: number; startTrack: number; endTrack: number } | null;
}

export function DawShellOverlays({
    settingsOpen,
    onCloseSettings,
    assistantOpen,
    onAssistantOpen,
    onAssistantClose,
    onSelectClips,
    missingAssetsOpen,
    missingTotal,
    onCloseMissingAssets,
    exportOpen,
    onCloseExport,
    projectName,
    selectedClipIds,
    timelineClipsForView,
    bpm,
    sampleRate,
    loopStartBeat,
    loopEndBeat,
    marqueeSelection,
}: DawShellOverlaysProps) {
    return (
        <>
            <ErrorBoundary module="Settings">
                <Suspense fallback={null}>
                    <SettingsPanel isOpen={settingsOpen} onClose={onCloseSettings} />
                </Suspense>
            </ErrorBoundary>

            <AssistantChat
                open={assistantOpen}
                onClose={onAssistantClose}
                onOpen={onAssistantOpen}
                onSelectClips={onSelectClips}
            />

            <AgentActionIndicator />

            <ErrorBoundary module="Resolver">
                <Suspense fallback={null}>
                    <MissingAssetsPanel isOpen={missingAssetsOpen && missingTotal > 0} onClose={onCloseMissingAssets} />
                </Suspense>
            </ErrorBoundary>

            <ErrorBoundary module="Export">
                <Suspense fallback={null}>
                    <ExportModal
                        isOpen={exportOpen}
                        onClose={onCloseExport}
                        projectName={projectName}
                        selectedClipIds={selectedClipIds}
                        allClips={timelineClipsForView}
                        bpm={bpm}
                        sampleRate={sampleRate}
                        loopStartBeat={loopStartBeat}
                        loopEndBeat={loopEndBeat}
                        marqueeSelection={marqueeSelection}
                    />
                </Suspense>
            </ErrorBoundary>

            <Suspense fallback={null}>
                <BlockingJobPopup />
            </Suspense>

            <DragOverlay />
        </>
    );
}

