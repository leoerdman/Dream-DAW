import { memo } from 'react';
import { StatusBar } from '@/widgets/StatusBar/StatusBar';

interface DawShellStatusAreaProps {
    missingAssetsOpen: boolean;
    missingMediaSummary: { offlineClipCount: number; missingPluginCount: number; total: number };
    onToggleMissingAssets: () => void;
    panelMode: 'rack' | 'clip';
    onPanelModeChange: (mode: 'rack' | 'clip') => void;
    panelInfo: string;
    mainViewMode: 'arrangement' | 'session';
}

export const DawShellStatusArea = memo(({
    missingAssetsOpen,
    missingMediaSummary,
    onToggleMissingAssets,
    panelMode,
    onPanelModeChange,
    panelInfo,
    mainViewMode,
}: DawShellStatusAreaProps) => {
    return (
        <>
            {missingMediaSummary.total > 0 && (
                <div
                    className="z-50"
                    style={{
                        borderTop: 'var(--space-px) solid color-mix(in srgb, var(--color-status-error) 55%, transparent)',
                        borderBottom: 'var(--space-px) solid color-mix(in srgb, var(--color-status-error) 35%, transparent)',
                        background: 'linear-gradient(90deg, color-mix(in srgb, var(--color-status-error) 18%, var(--color-bg-panel)) 0%, color-mix(in srgb, var(--color-status-error) 8%, var(--color-bg-panel)) 100%)',
                        minHeight: 24,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: 'var(--token-size-px-3) var(--space-2-5)',
                        gap: 10,
                    }}
                >
                    <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-bold)', color: 'var(--color-status-error)', letterSpacing: '0.02em' }}>
                        Missing media detected: {missingMediaSummary.offlineClipCount} files, {missingMediaSummary.missingPluginCount} plugins
                    </span>
                    <div style={{ display: 'flex', gap: 6 }}>
                        <button
                            onClick={onToggleMissingAssets}
                            style={{
                                border: 'var(--space-px) solid color-mix(in srgb, var(--color-status-error) 45%, transparent)',
                                background: 'color-mix(in srgb, var(--color-status-error) 20%, transparent)',
                                color: 'color-mix(in srgb, var(--color-status-error) 30%, var(--color-text-primary))',
                                borderRadius: 'var(--radius-lg)',
                                fontSize: 'var(--font-size-xs)',
                                fontWeight: 'var(--font-weight-bold)',
                                padding: 'var(--token-size-px-3) var(--space-2)',
                                cursor: 'pointer',
                            }}
                        >
                            {missingAssetsOpen ? 'Hide Resolver' : 'Open Resolver'}
                        </button>
                    </div>
                </div>
            )}
            <div className="z-50 theme-ornament-status">
                <StatusBar panelMode={panelMode} onPanelModeChange={onPanelModeChange} panelInfo={panelInfo} mainViewMode={mainViewMode} />
            </div>
        </>
    );
});
