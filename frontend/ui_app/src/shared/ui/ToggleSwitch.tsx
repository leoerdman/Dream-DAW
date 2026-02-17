import { memo, type CSSProperties } from 'react';

/* ═══════════════════════════════════════════════════════════════
   ToggleSwitch — Enterprise shared toggle component.
   Replaces 2+ inline toggle implementations across the codebase.
   All dimensions use design tokens from tokens.css.
   ═══════════════════════════════════════════════════════════════ */

interface ToggleSwitchProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
    /** Optional label rendered to the left of the toggle */
    label?: string;
    /** Size variant — default is 'md' */
    size?: 'sm' | 'md';
}

const SIZES = {
    sm: { track: { w: 28, h: 16 }, knob: 12, travel: 12, offset: 2 },
    md: { track: { w: 36, h: 20 }, knob: 16, travel: 16, offset: 2 },
} as const;

export const ToggleSwitch = memo(function ToggleSwitch({
    checked,
    onChange,
    disabled = false,
    label,
    size = 'md',
}: ToggleSwitchProps) {
    const s = SIZES[size];

    const trackStyle: CSSProperties = {
        position: 'relative',
        width: s.track.w,
        height: s.track.h,
        borderRadius: 'var(--radius-full)',
        background: checked
            ? 'var(--color-accent-primary)'
            : 'var(--color-control-bg)',
        border: `var(--border-width-1) solid ${checked ? 'var(--color-accent-primary)' : 'var(--color-control-border)'}`,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 'var(--opacity-disabled)' : 1,
        transition: `background var(--transition-fast), border-color var(--transition-fast)`,
        flexShrink: 0,
    };

    const knobStyle: CSSProperties = {
        position: 'absolute',
        top: s.offset,
        left: checked ? s.travel + s.offset : s.offset,
        width: s.knob,
        height: s.knob,
        borderRadius: 'var(--radius-full)',
        background: 'var(--color-text-bright)',
        boxShadow: 'var(--shadow-sm)',
        transition: `left var(--transition-fast)`,
    };

    return (
        <label
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                userSelect: 'none',
            }}
        >
            {label && (
                <span style={{
                    fontSize: 'var(--font-size-xs)',
                    color: 'var(--color-text-secondary)',
                }}>
                    {label}
                </span>
            )}
            <div
                style={trackStyle}
                onClick={() => { if (!disabled) onChange(!checked); }}
                role="switch"
                aria-checked={checked}
                aria-disabled={disabled}
            >
                <div style={knobStyle} />
            </div>
        </label>
    );
});
