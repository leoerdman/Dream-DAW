import type { CSSProperties } from 'react';

export const modalStyle: CSSProperties = {
    width: 'min(760px, calc(100vw - 48px))',
    height: 'min(760px, calc(100vh - 48px))',
    background: 'var(--color-bg-surface)',
    borderRadius: 'var(--radius-2xl)',
    border: 'var(--space-px) solid var(--color-divider)',
    display: 'flex', overflow: 'hidden', boxShadow: 'var(--shadow-panel)',
    fontFamily: 'var(--font-role-body)',
    WebkitFontSmoothing: 'antialiased',
    MozOsxFontSmoothing: 'grayscale',
};

export const sidebarStyle: CSSProperties = {
    width: 170, flexShrink: 0, background: 'var(--color-bg-sidebar)', borderRight: 'var(--space-px) solid var(--color-divider)',
    display: 'flex', flexDirection: 'column', gap: 2, padding: '0 0 var(--space-4)',
};

export const tabBtnStyle: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, padding: 'var(--space-2) var(--space-3)', margin: '0 var(--space-2)', borderRadius: 'var(--radius-lg)', border: 'none',
    cursor: 'pointer', fontSize: 'var(--font-size-base)', fontWeight: 'var(--font-weight-medium)', textAlign: 'left', transition: 'background var(--transition-fast)',
    letterSpacing: 'normal', textTransform: 'none',
};

export const contentStyle: CSSProperties = { flex: 1, padding: 'var(--space-5) var(--space-6)', overflow: 'auto', position: 'relative' };
export const closeBtnStyle: CSSProperties = {
    position: 'absolute', top: 12, right: 12, width: 24, height: 24, borderRadius: '50%', border: 'none', cursor: 'pointer', background: 'var(--color-bg-elevated)',
    color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-base)', fontWeight: 'var(--font-weight-semibold)', display: 'flex', alignItems: 'center', justifyContent: 'center',
};
export const titleStyle: CSSProperties = {
    fontSize: 'var(--font-size-xl)',
    fontWeight: 'var(--font-weight-semibold)',
    marginBottom: 16,
    color: 'var(--color-text-primary)',
    fontFamily: 'var(--font-role-title)',
    letterSpacing: 'normal',
    textTransform: 'none',
};
export const selectStyle: CSSProperties = {
    padding: 'var(--space-1) var(--space-2)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)', border: 'var(--space-px) solid var(--color-divider)',
    color: 'var(--color-text-primary)', fontSize: 'var(--font-size-sm)', outline: 'none', cursor: 'pointer',
};
export const inputStyle: CSSProperties = {
    width: 60, padding: 'var(--token-size-px-3) var(--space-1-5)', borderRadius: 'var(--radius-md)', textAlign: 'right', background: 'var(--color-bg-elevated)', border: 'var(--space-px) solid var(--color-divider)',
    color: 'var(--color-text-primary)', fontSize: 'var(--font-size-sm)', outline: 'none',
};
export const valueStyle: CSSProperties = { fontSize: 'var(--font-size-sm)', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-role-data)' };
export const chipStyle: CSSProperties = {
    padding: 'var(--token-size-px-5) var(--space-3)', borderRadius: 'var(--radius-lg)', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-sm)',
    fontWeight: 'var(--font-weight-semibold)', transition: 'all var(--transition-fast)',
};
export const actionBtnStyle: CSSProperties = {
    padding: 'var(--space-2) var(--space-4)', borderRadius: 'var(--radius-lg)', background: 'var(--color-accent-primary)', color: 'var(--color-text-on-accent)',
    border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)',
};
export const actionBtnSmStyle: CSSProperties = {
    padding: 'var(--space-1) var(--space-2-5)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)', color: 'var(--color-text-secondary)',
    border: 'var(--space-px) solid var(--color-divider)', cursor: 'pointer', fontSize: 'var(--font-size-xs)', fontWeight: 'var(--font-weight-medium)',
};
export const dividerStyle: CSSProperties = { height: 1, background: 'var(--color-divider)', margin: 'var(--space-3) 0' };

export const sectionStyle: CSSProperties = {
    border: 'none',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--space-3) var(--space-3)',
    background: 'color-mix(in srgb, var(--color-bg-elevated) 86%, transparent)',
    marginBottom: 'var(--space-3)',
};

export const sectionTitleStyle: CSSProperties = {
    fontSize: 'var(--font-size-sm)',
    fontWeight: 'var(--font-weight-semibold)',
    fontFamily: 'var(--font-role-title)',
    color: 'var(--color-text-primary)',
    marginBottom: 'var(--space-2)',
    letterSpacing: 'normal',
    textTransform: 'none',
};

export const sectionDescriptionStyle: CSSProperties = {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--color-text-tertiary)',
    marginBottom: 'var(--space-2)',
};
