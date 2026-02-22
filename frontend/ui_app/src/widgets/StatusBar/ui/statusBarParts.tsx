import type { CSSProperties, ReactNode } from 'react';

export const StatusLabel = ({ children }: { children: ReactNode }) => (
    <span style={{ color: 'var(--color-text-tertiary)', fontWeight: 400 }}>{children}</span>
);

export const StatusValue = ({ children }: { children: ReactNode }) => (
    <span style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)', fontWeight: 500 }}>
        {children}
    </span>
);

export const StatusText = ({ children, title }: { children: ReactNode; title?: string }) => (
    <span style={{ color: 'var(--color-text-secondary)', fontWeight: 500 }} title={title}>
        {children}
    </span>
);

export const StatusGroup = ({ children }: { children: ReactNode }) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>{children}</span>
);

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
