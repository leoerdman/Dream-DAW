import type { CSSProperties } from 'react';

export const panelModeBtnStyle = (active: boolean): CSSProperties => ({
    height: 20,
    minWidth: 56,
    border: active
        ? 'var(--space-px) solid color-mix(in srgb, var(--color-accent-primary) 44%, var(--color-control-border))'
        : 'var(--space-px) solid transparent',
    borderRadius: 'var(--radius-sm)',
    background: active
        ? 'color-mix(in srgb, var(--color-accent-primary) 20%, var(--color-control-bg))'
        : 'transparent',
    color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 600,
    letterSpacing: '0.02em',
    padding: '0 var(--space-3)',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'background-color 120ms ease, color 120ms ease, border-color 120ms ease',
});
