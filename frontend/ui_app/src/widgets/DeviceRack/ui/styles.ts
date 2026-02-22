import type { CSSProperties } from 'react';

export const pluginPanelKnobGrid = (columns: string): CSSProperties => ({
    display: 'grid',
    gridTemplateColumns: columns,
    alignItems: 'center',
    gap: 'var(--plugin-grid-gap)',
});
