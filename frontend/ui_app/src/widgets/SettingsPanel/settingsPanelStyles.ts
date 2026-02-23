import type { CSSProperties } from 'react';

export const overlayStyle: CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 'var(--z-modal)' as unknown as number, background: 'var(--color-overlay-modal)',
    backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center',
};

export const modalStyle: CSSProperties = {
    width: 680, height: 720, background: 'var(--color-bg-surface)', borderRadius: 'var(--radius-2xl)', border: '1px solid var(--color-divider)',
    display: 'flex', overflow: 'hidden', boxShadow: 'var(--shadow-panel)',
};

export const sidebarStyle: CSSProperties = {
    width: 170, flexShrink: 0, background: 'var(--color-bg-sidebar)', borderRight: '1px solid var(--color-divider)',
    display: 'flex', flexDirection: 'column', gap: 2, padding: '0 0 16px',
};

export const tabBtnStyle: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', margin: '0 8px', borderRadius: 'var(--radius-lg)', border: 'none',
    cursor: 'pointer', fontSize: 'var(--font-size-base)', fontWeight: 'var(--font-weight-medium)' as unknown as number, textAlign: 'left', transition: 'background var(--transition-fast)',
};

export const contentStyle: CSSProperties = { flex: 1, padding: '20px 24px', overflow: 'auto', position: 'relative' };
export const closeBtnStyle: CSSProperties = {
    position: 'absolute', top: 12, right: 12, width: 24, height: 24, borderRadius: '50%', border: 'none', cursor: 'pointer', background: 'var(--color-bg-elevated)',
    color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-base)', fontWeight: 'var(--font-weight-semibold)' as unknown as number, display: 'flex', alignItems: 'center', justifyContent: 'center',
};
export const titleStyle: CSSProperties = { fontSize: 'var(--font-size-xl)', fontWeight: 'var(--font-weight-bold)' as unknown as number, marginBottom: 16, color: 'var(--color-text-primary)' };
export const selectStyle: CSSProperties = {
    padding: '4px 8px', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-divider)',
    color: 'var(--color-text-primary)', fontSize: 'var(--font-size-sm)', outline: 'none', cursor: 'pointer',
};
export const inputStyle: CSSProperties = {
    width: 60, padding: '3px 6px', borderRadius: 'var(--radius-md)', textAlign: 'right', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-divider)',
    color: 'var(--color-text-primary)', fontSize: 'var(--font-size-sm)', outline: 'none',
};
export const valueStyle: CSSProperties = { fontSize: 'var(--font-size-sm)', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' };
export const chipStyle: CSSProperties = {
    padding: '5px 12px', borderRadius: 'var(--radius-lg)', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-sm)',
    fontWeight: 'var(--font-weight-semibold)' as unknown as number, transition: 'all var(--transition-fast)',
};
export const actionBtnStyle: CSSProperties = {
    padding: '8px 16px', borderRadius: 'var(--radius-lg)', background: 'var(--color-accent-primary)', color: 'var(--color-text-on-accent)',
    border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)' as unknown as number,
};
export const actionBtnSmStyle: CSSProperties = {
    padding: '4px 10px', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)', color: 'var(--color-text-secondary)',
    border: '1px solid var(--color-divider)', cursor: 'pointer', fontSize: 'var(--font-size-xs)', fontWeight: 'var(--font-weight-medium)' as unknown as number,
};
export const dividerStyle: CSSProperties = { height: 1, background: 'var(--color-divider)', margin: '12px 0' };
