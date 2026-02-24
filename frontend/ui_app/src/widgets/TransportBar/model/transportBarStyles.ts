import type React from 'react';
import { TRANSPORT_UI } from '../ui/TransportUiTokens';

export const valueChipStyle: React.CSSProperties = {
    fontFamily: 'var(--font-role-data)',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 600,
    color: 'var(--color-text-primary)',
    background: TRANSPORT_UI.controlBg,
    borderRadius: TRANSPORT_UI.controlRadius,
    padding: '0 8px',
    minWidth: 56,
    height: TRANSPORT_UI.controlHeight,
    lineHeight: `${TRANSPORT_UI.controlHeight}px`,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    border: TRANSPORT_UI.controlBorder,
    cursor: 'pointer',
};
