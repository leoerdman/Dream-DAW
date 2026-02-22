import type { ReactNode } from 'react';

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
