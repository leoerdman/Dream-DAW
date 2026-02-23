export interface TransportBarProps {
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
