import { memo } from 'react';
import { StatusBar } from '@/widgets/StatusBar/StatusBar';

interface DawShellStatusAreaProps {
    missingAssetsOpen: boolean;
    missingMediaSummary: { offlineClipCount: number; missingPluginCount: number; missingSamplerCount: number; total: number };
    onToggleMissingAssets: () => void;
    panelMode: 'rack' | 'clip';
    onPanelModeChange: (mode: 'rack' | 'clip') => void;
    panelInfo: string;
    mainViewMode: 'arrangement' | 'session' | 'flow';
    onMainViewModeChange: React.Dispatch<React.SetStateAction<'arrangement' | 'session' | 'flow'>>;
    isFlowAvailable: boolean;
}

export const DawShellStatusArea = memo(({
    missingMediaSummary,
    onToggleMissingAssets,
    panelMode,
    onPanelModeChange,
    panelInfo,
    mainViewMode,
    onMainViewModeChange,
    isFlowAvailable,
}: DawShellStatusAreaProps) => {
    return (
        <div className="z-50 theme-ornament-status">
            <StatusBar
                panelMode={panelMode}
                onPanelModeChange={onPanelModeChange}
                panelInfo={panelInfo}
                mainViewMode={mainViewMode}
                onMainViewModeChange={onMainViewModeChange}
                isFlowAvailable={isFlowAvailable}
                missingMediaSummary={missingMediaSummary}
                onToggleMissingAssets={onToggleMissingAssets}
            />
        </div>
    );
});
