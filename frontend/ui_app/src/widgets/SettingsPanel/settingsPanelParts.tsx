import type { ReactNode } from 'react';
import {
    actionBtnSmStyle,
    sectionDescriptionStyle,
    sectionStyle,
    sectionTitleStyle,
    selectStyle,
} from './settingsPanelStyles';

export const SettingRow = ({ label, children }: { label: string; children: ReactNode }) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)', padding: 'var(--space-2) 0' }}>
        <label style={{ fontSize: 'var(--font-size-base)', color: 'var(--color-text-secondary)', fontWeight: 500, lineHeight: 1.35 }}>{label}</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{children}</div>
    </div>
);

export const FolderRow = ({ label, path, onBrowse }: { label: string; path: string; onBrowse?: () => void }) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'var(--space-2-5) 0' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 'var(--font-weight-medium)', color: 'var(--color-text-primary)' }}>{label}</div>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)', marginTop: 2, fontFamily: 'var(--font-role-data)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path}</div>
        </div>
        <button onClick={onBrowse} style={actionBtnSmStyle}>Browse…</button>
    </div>
);

export const Select = ({
    value,
    options,
    onChange,
    onMouseDown,
}: {
    value: string;
    options: readonly string[];
    onChange: (v: string) => void;
    onMouseDown?: () => void;
}) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} onMouseDown={onMouseDown} style={selectStyle}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
);

export const Toggle = ({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) => (
    <button
        type="button"
        aria-pressed={value}
        onClick={() => onChange(!value)}
        style={{
            minWidth: 56,
            height: 24,
            borderRadius: 'var(--radius-full)',
            border: 'var(--space-px) solid color-mix(in srgb, var(--color-text-primary) 14%, transparent)',
            cursor: 'pointer',
            background: value ? 'color-mix(in srgb, var(--color-accent-primary) 26%, transparent)' : 'var(--color-bg-elevated)',
            position: 'relative',
            transition: 'background var(--transition-normal), border-color var(--transition-normal)',
            padding: 0,
        }}
    >
        <div
            style={{
                width: 18,
                height: 18,
                borderRadius: '50%',
                background: value ? 'var(--color-accent-primary)' : 'var(--color-text-tertiary)',
                position: 'absolute',
                top: 2,
                left: value ? 34 : 2,
                transition: 'left var(--transition-normal), background var(--transition-normal)',
                boxShadow: '0 var(--space-px) var(--token-size-px-3) var(--color-overlay-medium)',
            }}
        />
        <span
            style={{
                position: 'absolute',
                left: value ? 8 : 26,
                top: '50%',
                transform: 'translateY(-50%)',
                fontSize: 'var(--font-size-xs)',
                color: 'var(--color-text-secondary)',
                fontFamily: 'var(--font-role-data)',
                lineHeight: 1,
                userSelect: 'none',
            }}
        >
            {value ? 'On' : 'Off'}
        </span>
    </button>
);

export const SettingsSection = ({
    title,
    description,
    children,
}: {
    title: string;
    description?: string;
    children: ReactNode;
}) => (
    <section style={sectionStyle}>
        <div style={sectionTitleStyle}>{title}</div>
        {description ? <div style={sectionDescriptionStyle}>{description}</div> : null}
        {children}
    </section>
);
