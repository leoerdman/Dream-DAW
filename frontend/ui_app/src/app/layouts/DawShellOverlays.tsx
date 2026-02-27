import React from 'react';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import { SettingsPanel } from '@/widgets/SettingsPanel/SettingsPanel';
import { MissingAssetsPanel } from '@/widgets/MissingAssetsPanel/MissingAssetsPanel';
import { ExportModal } from '@/widgets/ExportModal/ExportModal';

interface DawShellOverlaysProps {
    settingsOpen: boolean;
    onCloseSettings: () => void;
    assistantOpen: boolean;
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
}

export const DawShellOverlays: React.FC<DawShellOverlaysProps> = ({
    settingsOpen,
    onCloseSettings,
    assistantOpen,
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
}) => {
    return (
        <>
            {settingsOpen && <SettingsPanel isOpen={settingsOpen} onClose={onCloseSettings} />}

            {/* AI Assistant Drawer Component */}
            <div
                className={`fixed right-0 top-0 h-full w-[400px] border-l border-border-mute bg-bg-app shadow-2xl transition-transform duration-300 ease-in-out z-[var(--z-drawer-panel)] flex flex-col ${assistantOpen ? 'translate-x-[0px]' : 'translate-x-[400px]'}`}
            >
                <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-border-mute/50 bg-bg-surface backdrop-blur">
                    <div className="flex items-center gap-2">
                        <div className="w-5 h-5 rounded-full bg-gradient-to-tr from-accent-primary to-accent-highlight flex items-center justify-center shadow-accent-glow">
                            <span className="text-[10px] font-bold text-white">✨</span>
                        </div>
                        <span className="font-semibold text-text-primary tracking-tight">Dream AI Assistant</span>
                    </div>
                </div>

                <div className="flex-1 relative overflow-hidden bg-bg-app">
                    <iframe
                        src="/chat"
                        allow="microphone"
                        className="w-full h-full border-none object-contain"
                        title="AI Assistant"
                    />
                </div>

                {/* Resizer overlay - allows resizing from left edge */}
                <div className="absolute left-0 top-0 w-2 h-full cursor-col-resize hover:bg-accent-primary/20 transition-colors z-[var(--z-ui-overlay)]" />
            </div>

            {missingAssetsOpen && missingTotal > 0 && (
                <MissingAssetsPanel isOpen={missingAssetsOpen} onClose={onCloseMissingAssets} />
            )}

            {exportOpen && (
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
                />
            )}
        </>
    );
};
