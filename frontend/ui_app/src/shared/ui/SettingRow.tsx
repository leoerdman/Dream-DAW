import { memo, type CSSProperties, type ReactNode } from 'react';

/* ═══════════════════════════════════════════════════════════════
   SettingRow — Enterprise shared label + control row.
   Replaces 3+ inline setting-row patterns across ExportModal,
   ExportDialog, and SettingsPanel.
   ═══════════════════════════════════════════════════════════════ */

interface SettingRowProps {
    label: string;
    children: ReactNode;
    /** Optional description below the label */
    description?: string;
    /** Layout orientation — horizontal (default) or vertical */
    direction?: 'horizontal' | 'vertical';
}

const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'var(--space-2)',
    minHeight: 'var(--space-8)',
};

const verticalRowStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1)',
};

const labelStyle: CSSProperties = {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--color-text-secondary)',
    flexShrink: 0,
    userSelect: 'none',
};

const descriptionStyle: CSSProperties = {
    fontSize: 'var(--font-size-2xs)',
    color: 'var(--color-text-tertiary)',
    lineHeight: 'var(--line-height-normal)',
};

const controlContainerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-1)',
    flexWrap: 'wrap',
};

export const SettingRow = memo(function SettingRow({
    label,
    children,
    description,
    direction = 'horizontal',
}: SettingRowProps) {
    if (direction === 'vertical') {
        return (
            <div style={verticalRowStyle}>
                <span style={labelStyle}>{label}</span>
                {description && <span style={descriptionStyle}>{description}</span>}
                <div style={controlContainerStyle}>{children}</div>
            </div>
        );
    }

    return (
        <div style={rowStyle}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-0-5)' }}>
                <span style={labelStyle}>{label}</span>
                {description && <span style={descriptionStyle}>{description}</span>}
            </div>
            <div style={controlContainerStyle}>{children}</div>
        </div>
    );
});
