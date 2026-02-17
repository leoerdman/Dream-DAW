import { memo, type CSSProperties } from 'react';

/* ═══════════════════════════════════════════════════════════════
   ChipGroup — Enterprise shared chip/pill selector.
   Replaces 3+ inline chip implementations across ExportModal,
   ExportDialog, and SettingsPanel.
   ═══════════════════════════════════════════════════════════════ */

export interface ChipOption<T extends string = string> {
    value: T;
    label: string;
    disabled?: boolean;
}

interface ChipGroupProps<T extends string = string> {
    options: ChipOption<T>[];
    value: T;
    onChange: (value: T) => void;
    /** Visual variant */
    variant?: 'outlined' | 'filled';
}

const chipGroupStyle: CSSProperties = {
    display: 'flex',
    gap: 'var(--space-1)',
    flexWrap: 'wrap',
};

const chipBase: CSSProperties = {
    fontSize: 'var(--font-size-xs)',
    fontWeight: 'var(--font-weight-medium)' as unknown as number,
    padding: 'var(--space-0-5) var(--space-2)',
    borderRadius: 'var(--radius-full)',
    cursor: 'pointer',
    transition: `background var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast)`,
    userSelect: 'none',
    border: 'var(--border-width-1) solid transparent',
    lineHeight: 'var(--line-height-tight)',
    whiteSpace: 'nowrap',
};

const getChipStyle = (active: boolean, disabled: boolean, variant: 'outlined' | 'filled'): CSSProperties => {
    if (disabled) {
        return {
            ...chipBase,
            background: 'var(--color-bg-tertiary)',
            color: 'var(--color-text-tertiary)',
            cursor: 'not-allowed',
            opacity: 'var(--opacity-disabled)' as unknown as number,
        };
    }
    if (active) {
        return {
            ...chipBase,
            background: variant === 'filled'
                ? 'var(--color-accent-primary)'
                : 'var(--color-accent-primary-dim)',
            color: variant === 'filled'
                ? 'var(--color-text-on-accent)'
                : 'var(--color-accent-primary)',
            borderColor: 'var(--color-accent-primary)',
        };
    }
    return {
        ...chipBase,
        background: variant === 'filled'
            ? 'var(--color-bg-elevated)'
            : 'transparent',
        color: 'var(--color-text-secondary)',
        borderColor: 'var(--color-control-border)',
    };
};

function ChipGroupInner<T extends string = string>({
    options,
    value,
    onChange,
    variant = 'outlined',
}: ChipGroupProps<T>) {
    return (
        <div style={chipGroupStyle} role="radiogroup">
            {options.map((opt) => (
                <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={opt.value === value}
                    disabled={opt.disabled}
                    style={getChipStyle(opt.value === value, !!opt.disabled, variant)}
                    onClick={() => {
                        if (!opt.disabled) onChange(opt.value);
                    }}
                >
                    {opt.label}
                </button>
            ))}
        </div>
    );
}

export const ChipGroup = memo(ChipGroupInner) as typeof ChipGroupInner;
