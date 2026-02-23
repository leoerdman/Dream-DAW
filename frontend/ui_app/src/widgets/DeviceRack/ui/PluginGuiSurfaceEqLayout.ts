import type React from 'react';

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
    fontFamily: 'var(--font-mono)',
};

export const EQ_FREQ_LABELS = [
    { freq: 20, label: '20' }, { freq: 50, label: '50' },
    { freq: 100, label: '100' }, { freq: 200, label: '200' }, { freq: 500, label: '500' },
    { freq: 1000, label: '1k' }, { freq: 2000, label: '2k' }, { freq: 5000, label: '5k' },
    { freq: 10000, label: '10k' }, { freq: 20000, label: '20k' },
] as const;

export const EQ_FREQ_SUB_LINES = [40, 60, 80, 150, 300, 400, 700, 800, 1500, 3000, 4000, 7000, 8000, 15000] as const;
