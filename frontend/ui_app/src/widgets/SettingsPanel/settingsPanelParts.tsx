import type { CSSProperties, ReactNode } from 'react';

export const SettingRow = ({ label, children }: { label: string; children: ReactNode }) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--color-divider-light)' }}>
        <label style={{ fontSize: 'var(--font-size-base)', color: 'var(--color-text-secondary)', fontWeight: 500 }}>{label}</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{children}</div>
    </div>
);

export const FolderRow = ({ label, path, onBrowse }: { label: string; path: string; onBrowse?: () => void }) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--color-divider-light)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 'var(--font-weight-medium)' as unknown as number, color: 'var(--color-text-primary)' }}>{label}</div>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)', marginTop: 2, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path}</div>
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
    options: string[];
    onChange: (v: string) => void;
    onMouseDown?: () => void;
}) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} onMouseDown={onMouseDown} style={selectStyle}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
);

export const Toggle = ({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) => (
    <button
        onClick={() => onChange(!value)}
        style={{
            width: 36, height: 20, borderRadius: 'var(--radius-full)', border: 'none', cursor: 'pointer',
            background: value ? 'var(--color-accent-primary)' : 'var(--color-bg-elevated)', position: 'relative',
            transition: 'background var(--transition-normal)',
        }}
    >
        <div
            style={{
                width: 16, height: 16, borderRadius: '50%', background: 'var(--color-text-on-accent)', position: 'absolute', top: 2,
                left: value ? 18 : 2, transition: 'left var(--transition-normal)', boxShadow: '0 1px 3px var(--color-overlay-medium)',
            }}
        />
    </button>
);

export const overlayStyle: CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 'var(--z-modal)' as unknown as number, background: 'var(--color-overlay-modal)',
    backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center',
};

export const modalStyle: CSSProperties = {
    width: 680, height: 720, background: 'var(--color-bg-surface)', borderRadius: 'var(--radius-2xl)', border: '1px solid var(--color-divider)',
    display: 'flex', overflow: 'hidden', boxShadow: 'var(--shadow-panel)',
};

export const sidebarStyle: CSSProperties = {
    width: 170, flexShrink: 0, background: 'var(--color-bg-sidebar)', borderRight: '1px solid var(--color-divider)',
    display: 'flex', flexDirection: 'column', gap: 2, padding: '0 0 16px',
};

export const tabBtnStyle: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', margin: '0 8px', borderRadius: 'var(--radius-lg)', border: 'none',
    cursor: 'pointer', fontSize: 'var(--font-size-base)', fontWeight: 'var(--font-weight-medium)' as unknown as number, textAlign: 'left', transition: 'background var(--transition-fast)',
};

export const contentStyle: CSSProperties = { flex: 1, padding: '20px 24px', overflow: 'auto', position: 'relative' };
export const closeBtnStyle: CSSProperties = {
    position: 'absolute', top: 12, right: 12, width: 24, height: 24, borderRadius: '50%', border: 'none', cursor: 'pointer', background: 'var(--color-bg-elevated)',
    color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-base)', fontWeight: 'var(--font-weight-semibold)' as unknown as number, display: 'flex', alignItems: 'center', justifyContent: 'center',
};
export const titleStyle: CSSProperties = { fontSize: 'var(--font-size-xl)', fontWeight: 'var(--font-weight-bold)' as unknown as number, marginBottom: 16, color: 'var(--color-text-primary)' };
export const selectStyle: CSSProperties = {
    padding: '4px 8px', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-divider)',
    color: 'var(--color-text-primary)', fontSize: 'var(--font-size-sm)', outline: 'none', cursor: 'pointer',
};
export const inputStyle: CSSProperties = {
    width: 60, padding: '3px 6px', borderRadius: 'var(--radius-md)', textAlign: 'right', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-divider)',
    color: 'var(--color-text-primary)', fontSize: 'var(--font-size-sm)', outline: 'none',
};
export const valueStyle: CSSProperties = { fontSize: 'var(--font-size-sm)', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' };
export const chipStyle: CSSProperties = {
    padding: '5px 12px', borderRadius: 'var(--radius-lg)', border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-sm)',
    fontWeight: 'var(--font-weight-semibold)' as unknown as number, transition: 'all var(--transition-fast)',
};
export const actionBtnStyle: CSSProperties = {
    padding: '8px 16px', borderRadius: 'var(--radius-lg)', background: 'var(--color-accent-primary)', color: 'var(--color-text-on-accent)',
    border: 'none', cursor: 'pointer', fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)' as unknown as number,
};
export const actionBtnSmStyle: CSSProperties = {
    padding: '4px 10px', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-elevated)', color: 'var(--color-text-secondary)',
    border: '1px solid var(--color-divider)', cursor: 'pointer', fontSize: 'var(--font-size-xs)', fontWeight: 'var(--font-weight-medium)' as unknown as number,
};
export const dividerStyle: CSSProperties = { height: 1, background: 'var(--color-divider)', margin: '12px 0' };
