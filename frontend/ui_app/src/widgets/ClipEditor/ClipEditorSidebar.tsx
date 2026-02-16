import type { CSSProperties, ReactNode } from 'react';

const sidebarStyle: CSSProperties = {
    width: 182,
    flexShrink: 0,
    borderRight: '1px solid var(--color-divider)',
    background: 'var(--color-bg-panel)',
    padding: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    minHeight: 0,
    overflowY: 'auto',
};

const sectionStyle: CSSProperties = {
    border: '1px solid var(--color-control-border)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--color-bg-secondary)',
    padding: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
};

const sectionTitleStyle: CSSProperties = {
    fontSize: 'var(--font-size-xs)',
    fontWeight: 700,
    color: 'var(--color-text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
};

const metaLabelStyle: CSSProperties = {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--color-text-tertiary)',
};

const metaValueStyle: CSSProperties = {
    color: 'var(--color-text-primary)',
    fontFamily: 'var(--font-mono)',
};

export const ClipEditorSidebar = ({ children }: { children: ReactNode }) => {
    return <aside style={sidebarStyle}>{children}</aside>;
};

export const ClipEditorSection = ({ title, children }: { title: string; children: ReactNode }) => {
    return (
        <div style={sectionStyle}>
            <div style={sectionTitleStyle}>{title}</div>
            {children}
        </div>
    );
};

export const ClipEditorMetaRow = ({ label, value }: { label: string; value: ReactNode }) => {
    return (
        <span style={metaLabelStyle}>
            {label}: <span style={metaValueStyle}>{value}</span>
        </span>
    );
};
