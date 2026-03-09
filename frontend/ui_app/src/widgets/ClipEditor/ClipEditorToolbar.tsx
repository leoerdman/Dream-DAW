import { memo, type CSSProperties, type ReactNode, type RefObject } from 'react';

/**
 * Shared toolbar shell for both MIDI and Audio clip editors.
 * Provides consistent height, background, border, and padding.
 * Each editor inserts its own controls as `children`.
 */

const toolbarStyle: CSSProperties = {
    height: 'var(--daw-transport-height)',
    display: 'flex',
    alignItems: 'center',
    padding: '0 var(--space-2)',
    gap: 'var(--space-1)',
    background: 'var(--color-bg-elevated)',
    borderBottom: 'var(--space-px) solid var(--color-divider)',
    flexShrink: 0,
};

interface ClipEditorToolbarProps {
    /** Ref to the editor root element — will receive focus on toolbar mousedown */
    editorRootRef?: RefObject<HTMLDivElement | null>;
    children: ReactNode;
}

export const ClipEditorToolbar = memo(function ClipEditorToolbar({
    editorRootRef,
    children,
}: ClipEditorToolbarProps) {
    return (
        <div
            onPointerDown={(e) => {
                const target = e.target as HTMLElement;
                if (target.tagName !== 'SELECT' && target.tagName !== 'INPUT') {
                    e.preventDefault();
                }
                if (editorRootRef?.current) {
                    requestAnimationFrame(() => editorRootRef.current?.focus());
                }
            }}
            style={toolbarStyle}
        >
            {children}
        </div>
    );
});
