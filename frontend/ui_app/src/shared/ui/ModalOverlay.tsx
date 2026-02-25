import { memo, useCallback, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

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
    /** Optional blur amount for backdrop. Defaults to token-driven value. */
    blur?: string;
    /** Optional heading element id for accessible dialog naming. */
    labelId?: string;
}

const overlayStyle = (zIndex: string, blur: string): CSSProperties => ({
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--color-overlay-modal)',
    zIndex: zIndex as unknown as number,
    backdropFilter: `blur(${blur})`,
    WebkitBackdropFilter: `blur(${blur})`,
});

const panelStyle: CSSProperties = {
    position: 'relative',
};

export const ModalOverlay = memo(function ModalOverlay({
    children,
    onBackdropClick,
    zIndex = 'var(--z-modal)',
    open,
    blur = 'var(--overlay-modal-blur)',
    labelId,
}: ModalOverlayProps) {
    const panelRef = useRef<HTMLDivElement | null>(null);
    const previousActiveRef = useRef<HTMLElement | null>(null);

    useEffect(() => {
        if (!open) return;
        previousActiveRef.current = document.activeElement as HTMLElement | null;

        const panel = panelRef.current;
        if (!panel) return;

        const focusableSelector = [
            'button:not([disabled])',
            '[href]',
            'input:not([disabled])',
            'select:not([disabled])',
            'textarea:not([disabled])',
            '[tabindex]:not([tabindex="-1"])',
        ].join(',');

        const getFocusable = () =>
            Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector))
                .filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);

        const focusable = getFocusable();
        if (focusable.length > 0) {
            focusable[0].focus();
        } else {
            panel.setAttribute('tabindex', '-1');
            panel.focus();
        }

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Tab') return;
            const currentFocusable = getFocusable();
            if (currentFocusable.length === 0) {
                e.preventDefault();
                return;
            }
            const first = currentFocusable[0];
            const last = currentFocusable[currentFocusable.length - 1];
            const active = document.activeElement as HTMLElement | null;
            if (e.shiftKey && active === first) {
                e.preventDefault();
                last.focus();
                return;
            }
            if (!e.shiftKey && active === last) {
                e.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            previousActiveRef.current?.focus?.();
        };
    }, [open]);

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
            style={overlayStyle(zIndex, blur)}
            onClick={handleBackdropClick}
            role="dialog"
            aria-modal
            aria-labelledby={labelId}
        >
            <div ref={panelRef} style={panelStyle}>{children}</div>
        </div>
    );
});
