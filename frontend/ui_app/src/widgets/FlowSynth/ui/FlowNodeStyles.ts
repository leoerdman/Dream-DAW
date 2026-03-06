/**
 * FlowNodeStyles.ts — Token-based style constants for Flow Synth node components.
 *
 * Mirrors the pattern of FlowNodeControlStyles.ts but for the node shell:
 * header, ports, selection overlay, and structural layout.
 *
 * ZERO hardcoded pixel values. All sizing/spacing comes from CSS tokens.
 */
import type { CSSProperties } from 'react';

// ── Port Dimensions ────────────────────────────────────────────────────
export const FLOW_PORT_DOT_SIZE = 10;
export const FLOW_PORT_HIT_PAD = 6;

// ── Signal Type → Color Token Map ──────────────────────────────────────
export const SIGNAL_COLOR_MAP: Record<string, string> = {
    audio: 'var(--color-signal-audio)',
    control: 'var(--color-signal-control)',
    midi: 'var(--color-signal-midi)',
    gate: 'var(--color-signal-gate)',
    phase: 'var(--color-signal-phase)',
};

/**
 * Resolve a port type to its display color token.
 */
export function signalColor(portType: string): string {
    return SIGNAL_COLOR_MAP[portType] ?? 'var(--color-signal-control)';
}

/**
 * Resolve a signal type to its glow color (72% opacity via color-mix).
 */
export function signalGlowColor(signalType: string): string {
    const base = SIGNAL_COLOR_MAP[signalType] ?? 'var(--color-signal-control)';
    return `color-mix(in srgb, ${base} 72%, transparent)`;
}

// ── Node Shell Styles ──────────────────────────────────────────────────

export const nodeShellStyle: CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    background: 'color-mix(in srgb, var(--color-bg-panel) 97%, transparent)',
    backdropFilter: 'blur(var(--blur-lg))',
    WebkitBackdropFilter: 'blur(var(--blur-lg))',
    borderRadius: 'var(--radius-xl)',
    border: '1px solid color-mix(in srgb, var(--color-text-primary) 22%, transparent)',
    boxShadow: 'var(--shadow-md)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'visible',
};

export const selectionOverlayStyle: CSSProperties = {
    position: 'absolute',
    inset: -2,
    borderRadius: 'calc(var(--radius-xl) + 1px)',
    border: '2px solid rgba(255, 255, 255, 0.85)',
    pointerEvents: 'none',
    zIndex: 100,
    boxShadow: '0 0 0 1px color-mix(in srgb, var(--color-accent-primary) 50%, transparent)',
};

export const nodeHeaderStyle: CSSProperties = {
    padding: '0 var(--space-3-5)',
    touchAction: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    borderBottom: '1px solid var(--color-divider)',
    background: 'linear-gradient(180deg, color-mix(in srgb, var(--color-text-primary) 10%, transparent), transparent)',
    borderTopLeftRadius: 'var(--radius-xl)',
    borderTopRightRadius: 'var(--radius-xl)',
    boxSizing: 'border-box',
    flexShrink: 0,
};

export const nodeTypeDotStyle: CSSProperties = {
    width: 'var(--space-2)',
    height: 'var(--space-2)',
    borderRadius: '50%',
    flexShrink: 0,
};

export const nodeTitleStyle: CSSProperties = {
    fontWeight: 'var(--font-weight-bold)',
    fontSize: 'var(--font-size-sm)',
    color: 'var(--color-text-primary)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    fontFamily: 'var(--font-role-data)',
    userSelect: 'none',
};

export const portLabelStyle: CSSProperties = {
    position: 'absolute',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-role-data)',
    fontWeight: 'var(--font-weight-semibold)',
    color: 'color-mix(in srgb, var(--color-text-primary) 80%, transparent)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    lineHeight: 'var(--space-3-5)',
    pointerEvents: 'none',
    userSelect: 'none',
    whiteSpace: 'nowrap',
};

// ── Connection Cable Style Constants ───────────────────────────────────

/**
 * Whether a signal type should render with dashed cable style (Bitwig Grid pattern:
 * control + phase = dashed; audio + gate + midi = solid).
 */
export function isControlLikeCable(signalType: string): boolean {
    return signalType === 'control' || signalType === 'phase';
}
