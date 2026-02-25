import type React from 'react';

export const selectStyle: React.CSSProperties = {
    padding: 'var(--space-0-5) var(--space-1)',
    background: 'var(--color-bg-input)',
    color: 'var(--color-text-secondary)',
    border: 'var(--space-px) solid var(--color-control-border)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 'var(--font-size-2xs)',
    cursor: 'pointer',
    outline: 'none',
    fontFamily: 'var(--font-role-body)',
};

export const miniBtnStyle: React.CSSProperties = {
    border: 'var(--space-px) solid var(--color-control-border)',
    borderRadius: 'var(--radius-xs)',
    background: 'var(--color-bg-input)',
    color: 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-role-body)',
    padding: 'var(--space-1) var(--space-1-5)',
    cursor: 'pointer',
};

export const actionBtnStyle: React.CSSProperties = {
    border: 'var(--space-px) solid var(--color-control-border)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--color-bg-secondary)',
    color: 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-2xs)',
    fontFamily: 'var(--font-role-body)',
    fontWeight: 'var(--font-weight-semibold)',
    padding: 'var(--token-size-px-3) var(--space-2)',
    cursor: 'pointer',
};
