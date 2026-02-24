import type React from 'react';
import { TRANSPORT_UI } from './TransportUiTokens';

export const iconBtnStyle = (color: string, background: string): React.CSSProperties => ({
    width: TRANSPORT_UI.controlHeight,
    height: TRANSPORT_UI.controlHeight,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: background === 'transparent' ? TRANSPORT_UI.controlBg : background,
    border: TRANSPORT_UI.controlBorder,
    borderRadius: TRANSPORT_UI.controlRadius,
    color,
    cursor: 'pointer',
});

export const keyMenuItemStyle = (active: boolean): React.CSSProperties => ({
    width: '100%',
    border: 'none',
    borderRadius: 'var(--radius-xs)',
    background: active ? 'color-mix(in srgb, var(--color-accent-primary) 14%, transparent)' : 'transparent',
    color: 'var(--color-text-primary)',
    textAlign: 'left',
    padding: 'var(--space-1) var(--space-1-5)',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-role-data)',
    fontWeight: active ? 700 : 500,
    cursor: 'pointer',
});
