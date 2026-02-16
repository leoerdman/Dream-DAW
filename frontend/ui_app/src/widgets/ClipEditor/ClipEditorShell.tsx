import type { ReactNode } from 'react';

export const CLIP_EDITOR_SIDEBAR_WIDTH = 182;

export const ClipEditorShell = ({
    sidebar,
    children,
}: {
    sidebar: ReactNode;
    children: ReactNode;
}) => {
    return (
        <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
            {sidebar}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                {children}
            </div>
        </div>
    );
};
