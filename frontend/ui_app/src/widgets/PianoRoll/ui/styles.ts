import type React from 'react';

export const selectStyle: React.CSSProperties = {
    padding: '2px 4px',
    background: 'var(--color-bg-input)',
    color: 'var(--color-text-secondary)',
    border: '1px solid var(--color-control-border)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 'var(--font-size-2xs)',
    cursor: 'pointer',
    outline: 'none',
    fontFamily: 'var(--font-family)',
};

export const miniBtnStyle: React.CSSProperties = {
    border: '1px solid var(--color-control-border)',
    borderRadius: 'var(--radius-xs)',
    background: 'var(--color-bg-input)',
    color: 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-family)',
    padding: '4px 6px',
    cursor: 'pointer',
};

export const actionBtnStyle: React.CSSProperties = {
    border: '1px solid var(--color-control-border)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--color-bg-secondary)',
    color: 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-2xs)',
    fontFamily: 'var(--font-family)',
    fontWeight: 'var(--font-weight-semibold)' as unknown as number,
    padding: '3px 8px',
    cursor: 'pointer',
};
