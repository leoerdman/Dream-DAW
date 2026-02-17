import { memo, useCallback, type CSSProperties, type ReactNode } from 'react';

/* ═══════════════════════════════════════════════════════════════
   ModalOverlay — Enterprise shared modal overlay + centered panel.
   Standardizes the backdrop + centered container pattern used by
   ExportModal, SettingsPanel, BlockingJobPopup, MissingAssetsPanel.
   ═══════════════════════════════════════════════════════════════ */

interface ModalOverlayProps {
    children: ReactNode;
    /** Called when clicking the backdrop (not the panel). Pass undefined to disable. */
    onBackdropClick?: () => void;
    /** z-index token string, e.g. 'var(--z-modal)'. Defaults to --z-modal. */
    zIndex?: string;
    /** Whether to render. Controls mount/unmount. */
    open: boolean;
}

const overlayStyle = (zIndex: string): CSSProperties => ({
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--color-overlay-modal)',
    zIndex: zIndex as unknown as number,
});

const panelStyle: CSSProperties = {
    position: 'relative',
};

export const ModalOverlay = memo(function ModalOverlay({
    children,
    onBackdropClick,
    zIndex = 'var(--z-modal)',
    open,
}: ModalOverlayProps) {
    const handleBackdropClick = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            if (e.target === e.currentTarget) {
                onBackdropClick?.();
            }
        },
        [onBackdropClick],
    );

    if (!open) return null;

    return (
        <div
            style={overlayStyle(zIndex)}
            onClick={handleBackdropClick}
            role="dialog"
            aria-modal
        >
            <div style={panelStyle}>{children}</div>
        </div>
    );
});
