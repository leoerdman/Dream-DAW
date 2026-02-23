import type { CSSProperties } from 'react';

export const sliderLabelStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1)',
    minWidth: 110,
};

export const sliderTextStyle: CSSProperties = {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--color-text-secondary)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 'var(--space-2)',
};

export const sliderValueStyle: CSSProperties = {
    color: 'var(--color-text-primary)',
    fontFamily: 'var(--font-mono)',
};

export const sliderInputStyle: CSSProperties = {
    width: '100%',
    accentColor: 'var(--color-accent-primary)',
    cursor: 'ew-resize',
    height: 'var(--space-3-5)',
    borderRadius: 'var(--radius-full)',
    background: 'transparent',
};

export const knobLabelStyle = (compact: boolean): CSSProperties => ({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: compact ? 'var(--space-0-5)' : 'var(--space-1)',
    minWidth: compact ? 48 : 76,
});

export const knobParamNameStyle: CSSProperties = {
    fontSize: 'var(--font-size-2xs)',
    color: 'var(--color-text-secondary)',
    textAlign: 'center',
    lineHeight: 1.1,
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
    maxWidth: 74,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
};

export const knobDialStyle = (isDragging: boolean): CSSProperties => ({
    width: '100%',
    height: '100%',
    position: 'relative',
    cursor: isDragging ? 'grabbing' : 'ns-resize',
    touchAction: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
});

export const knobValueStyle = (compact: boolean): CSSProperties => ({
    fontSize: compact ? 'var(--font-size-2xs)' : 'var(--font-size-xs)',
    color: 'var(--color-text-primary)',
    fontFamily: 'var(--font-mono)',
    cursor: 'text',
    userSelect: 'none',
    background: 'transparent',
    padding: '0 var(--space-0-5)',
    borderRadius: 'var(--radius-xs)',
});

export const knobValueInputStyle = (compact: boolean): CSSProperties => ({
    width: compact ? 52 : 62,
    height: compact ? 16 : 18,
    border: 'none',
    borderRadius: 'var(--radius-xs)',
    background: 'var(--color-bg-elevated)',
    color: 'var(--color-text-primary)',
    fontFamily: 'var(--font-mono)',
    fontSize: compact ? 'var(--font-size-2xs)' : 'var(--font-size-xs)',
    textAlign: 'center',
    padding: '0 var(--space-1)',
    outline: 'var(--space-px) solid var(--color-accent-primary)',
});

export const knobDragValueBadgeStyle: CSSProperties = {
    position: 'absolute',
    left: '50%',
    top: -16,
    transform: 'translateX(-50%)',
    fontSize: 'var(--font-size-2xs)',
    fontFamily: 'var(--font-mono)',
    color: 'var(--badge-color)',
    background: 'var(--badge-bg)',
    border: 'var(--badge-border)',
    borderRadius: 'var(--radius-md)',
    padding: 'var(--space-px) var(--space-1)',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
};

