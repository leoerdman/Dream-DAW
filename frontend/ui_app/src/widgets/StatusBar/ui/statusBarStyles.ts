import type { CSSProperties } from 'react';

export const panelModeBtnStyle = (active: boolean): CSSProperties => ({
    border: active ? '1px solid color-mix(in srgb, var(--color-accent-primary) 52%, transparent)' : '1px solid transparent',
    borderRadius: 'var(--radius-md)',
    background: active ? 'var(--color-accent-primary-dim)' : 'transparent',
    color: active ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 700,
    letterSpacing: '0.02em',
    padding: '3px 8px',
    cursor: 'pointer',
});
