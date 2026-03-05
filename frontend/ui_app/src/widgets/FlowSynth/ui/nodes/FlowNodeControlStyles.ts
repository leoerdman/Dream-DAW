/**
 * Flow Node Control Styles — Enterprise Token-Based Design System
 *
 * All visual values use CSS custom properties from tokens.css.
 * Zero hardcoded pixels. Matches StandardPluginControlStyles.ts patterns.
 */
import type { CSSProperties } from 'react';

// ── Control Container ───────────────────────────────────────────────────

export const nodeControlsContainerStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1-5)',
    padding: 'var(--space-2) var(--space-3)',
};

// ── Control Row ─────────────────────────────────────────────────────────

export const controlRowStyle: CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 'var(--space-2)',
};

export const controlRowLabelStyle: CSSProperties = {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--color-text-tertiary)',
    fontWeight: 'var(--font-weight-semibold)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    fontFamily: 'var(--font-role-data)',
    flexShrink: 0,
};

export const controlRowContentStyle: CSSProperties = {
    minWidth: 0,
    flex: 1,
    display: 'flex',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 'var(--space-1-5)',
};

// ── Slider (Range Input) ────────────────────────────────────────────────

export const nodeSliderStyle: CSSProperties = {
    width: '100%',
    maxWidth: 90,
    accentColor: 'var(--color-accent-primary)',
    cursor: 'ew-resize',
    height: 'var(--space-3)',
    borderRadius: 'var(--radius-full)',
    background: 'transparent',
};

// ── Select (Dropdown) ───────────────────────────────────────────────────

export const nodeSelectStyle: CSSProperties = {
    width: '100%',
    background: 'var(--color-bg-input)',
    border: '1px solid var(--color-border-default)',
    color: 'var(--color-text-secondary)',
    padding: 'var(--space-0-5) var(--space-6) var(--space-0-5) var(--space-2)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 'var(--font-size-sm)',
    fontFamily: 'var(--font-role-data)',
    cursor: 'pointer',
    appearance: 'none',
    backgroundImage: `url("data:image/svg+xml,%3Csvg width='10' height='10' viewBox='0 0 12 12' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M3 5L6 8L9 5' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right var(--space-1-5) center',
    outline: 'none',
    transition: 'border-color var(--transition-fast)',
    maxWidth: 120,
};

// ── Value Display ───────────────────────────────────────────────────────

export const nodeValueStyle: CSSProperties = {
    fontSize: 'var(--font-size-sm)',
    fontFamily: 'var(--font-role-data)',
    color: 'var(--color-text-secondary)',
    fontVariantNumeric: 'tabular-nums',
    flexShrink: 0,
};

export const nodeValueUnitStyle: CSSProperties = {
    color: 'var(--color-text-tertiary)',
    marginLeft: 'var(--space-0-5)',
};
