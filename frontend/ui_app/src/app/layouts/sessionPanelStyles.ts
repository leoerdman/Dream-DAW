import type { CSSProperties } from 'react';

export const sessionMixerBtnStyle = (active: boolean): CSSProperties => ({
    minWidth: 24,
    height: 18,
    borderRadius: 'var(--radius-sm)',
    border: active ? 'var(--space-px) solid color-mix(in srgb, var(--color-accent-primary) 55%, transparent)' : 'var(--space-px) solid var(--token-color-hex-4b4b4b)',
    background: active ? 'var(--color-accent-primary-dim)' : 'var(--color-bg-header)',
    color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 'var(--font-weight-bold)',
    cursor: 'pointer',
});

export const sessionClipTransportBtnStyle = (active: boolean): CSSProperties => ({
    minWidth: 16,
    height: 14,
    borderRadius: 'var(--radius-sm)',
    border: active ? 'var(--space-px) solid color-mix(in srgb, var(--color-accent-primary) 38%, var(--color-border-subtle))' : 'var(--space-px) solid var(--color-overlay-medium)',
    background: active ? 'color-mix(in srgb, var(--color-accent-primary) 28%, var(--color-bg-header))' : 'var(--color-overlay-dark)',
    color: active ? 'var(--color-text-primary)' : 'color-mix(in srgb, var(--color-text-primary) 78%, transparent)',
    fontSize: 'var(--font-size-2xs)',
    fontWeight: 'var(--font-weight-bold)',
    lineHeight: 1,
    padding: 0,
    cursor: 'pointer',
});
