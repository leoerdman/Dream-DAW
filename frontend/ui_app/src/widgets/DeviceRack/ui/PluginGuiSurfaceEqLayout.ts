import type React from 'react';

// ENTERPRISE SSOT: Re-export grid constants from the canonical source.
// Do NOT define duplicate freq/sub-line arrays here.
export { FREQ_LABELS as EQ_FREQ_LABELS, FREQ_SUB_LINES as EQ_FREQ_SUB_LINES, DB_GRID_LINES } from '@/widgets/DeviceRack/lib/eqConstants';

export const pluginPanelCardBaseStyle: React.CSSProperties = {
    border: 'var(--space-px) solid var(--plugin-card-border)',
    borderRadius: 'var(--plugin-card-radius)',
    padding: 'var(--plugin-card-pad-y) var(--plugin-card-pad-x)',
    display: 'grid',
    gridTemplateRows: '1fr auto',
    gap: 'var(--plugin-card-gap)',
    background: 'var(--plugin-card-bg-main)',
};

export const pluginPanelMetaStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 'var(--font-size-xs)',
    color: 'var(--plugin-meta-color)',
    fontFamily: 'var(--font-role-data)',
};
