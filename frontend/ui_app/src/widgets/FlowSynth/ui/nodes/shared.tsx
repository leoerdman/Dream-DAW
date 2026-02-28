import React from 'react';

interface ControlRowProps {
    label: string;
    children: React.ReactNode;
}

export function ControlRow({ label, children }: ControlRowProps) {
    return (
        <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 'var(--space-2)',
        }}>
            <span style={{
                fontSize: 'var(--font-size-xs)',
                color: 'var(--color-text-tertiary)',
                fontWeight: 'var(--font-weight-semibold)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                fontFamily: 'var(--font-role-data)',
                flexShrink: 0,
            }}>
                {label}
            </span>
            <div style={{ minWidth: 0, flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
                {children}
            </div>
        </div>
    );
}

interface NodeSelectProps {
    value: string;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
}

export function NodeSelect({ value, options, onChange }: NodeSelectProps) {
    return (
        <select
            value={value}
            onChange={(e) => { e.stopPropagation(); onChange(e.target.value); }}
            onPointerDown={(e) => e.stopPropagation()}
            style={{
                width: '100%',
                background: 'var(--color-bg-input)',
                border: '1px solid var(--color-border-default)',
                color: 'var(--color-text-secondary)',
                padding: '3px 24px 3px 8px',
                borderRadius: 'var(--radius-sm)',
                fontSize: 'var(--font-size-sm)',
                fontFamily: 'var(--font-role-data)',
                cursor: 'pointer',
                appearance: 'none',
                backgroundImage: `url("data:image/svg+xml,%3Csvg width='10' height='10' viewBox='0 0 12 12' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M3 5L6 8L9 5' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'right 6px center',
                outline: 'none',
                transition: 'border-color 0.15s',
                maxWidth: 120,
            }}
        >
            {options.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
        </select>
    );
}

interface NodeValueProps {
    value: string | number;
    unit?: string;
}

export function NodeValue({ value, unit }: NodeValueProps) {
    return (
        <span style={{
            fontSize: 'var(--font-size-sm)',
            fontFamily: 'var(--font-role-data)',
            color: 'var(--color-text-secondary)',
            fontVariantNumeric: 'tabular-nums',
        }}>
            {value}{unit && <span style={{ color: 'var(--color-text-tertiary)', marginLeft: 2 }}>{unit}</span>}
        </span>
    );
}
