import React from 'react';

export const TRANSPORT_UI = {
    sectionHeight: 26,
    controlHeight: 24,
    controlRadius: 'var(--radius-sm)',
    controlBg: 'color-mix(in srgb, var(--color-bg-header) 88%, black 12%)',
    controlBorder: '1px solid color-mix(in srgb, var(--color-control-border) 60%, transparent)',
};

export const PillSection = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
    <div
        style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '0 4px',
            margin: '0 2px',
            height: TRANSPORT_UI.sectionHeight,
            borderRadius: 0,
            background: 'transparent',
            border: 'none',
            ...style,
        }}
    >
        {children}
    </div>
);

export const ControlButton = ({ label, onClick, dimmed }: { label: string; onClick: () => void; dimmed?: boolean }) => (
    <button
        onClick={onClick}
        className="btn-control"
        style={{
            height: TRANSPORT_UI.controlHeight,
            minHeight: TRANSPORT_UI.controlHeight,
            minWidth: TRANSPORT_UI.controlHeight,
            border: TRANSPORT_UI.controlBorder,
            borderRadius: TRANSPORT_UI.controlRadius,
            background: TRANSPORT_UI.controlBg,
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--font-size-xs)',
            fontWeight: 600,
            color: 'var(--color-text-primary)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 8px',
            lineHeight: 1,
            verticalAlign: 'middle',
            margin: 0,
            appearance: 'none',
            opacity: dimmed ? 0.35 : 1,
        }}
    >
        {label}
    </button>
);

export const TransportBtn = ({
    icon,
    title,
    isActive,
    activeColor,
    activeBackground = true,
    onClick,
    className,
}: {
    icon: React.ReactNode;
    title: string;
    isActive?: boolean;
    activeColor?: string;
    activeBackground?: boolean;
    onClick: () => void;
    className?: string;
}) => (
    <button
        onClick={onClick}
        title={title}
        className={className}
        style={{
            width: TRANSPORT_UI.controlHeight,
            height: TRANSPORT_UI.controlHeight,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: TRANSPORT_UI.controlBg,
            border: TRANSPORT_UI.controlBorder,
            borderRadius: TRANSPORT_UI.controlRadius,
            padding: 0,
            lineHeight: 1,
            verticalAlign: 'middle',
            margin: 0,
            appearance: 'none',
            color: isActive ? activeColor : 'var(--color-text-primary)',
            cursor: 'pointer',
            transition: 'all var(--transition-fast)',
        }}
    >
        {icon}
    </button>
);
