import React from 'react';

export const PillSection = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
    <div
        style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '0 8px',
            margin: '0 4px',
            height: 26,
            borderRadius: 'var(--radius-md)',
            background: 'color-mix(in srgb, var(--color-bg-panel) 80%, transparent)',
            border: '1px solid var(--color-divider)',
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
            fontFamily: 'var(--font-mono)',
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
            width: 22,
            height: 22,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: isActive && activeBackground ? `color-mix(in srgb, ${activeColor} 15%, transparent)` : 'transparent',
            border: 'none',
            borderRadius: 'var(--radius-xs)',
            color: isActive ? activeColor : 'var(--color-text-secondary)',
            cursor: 'pointer',
            transition: 'all var(--transition-fast)',
        }}
    >
        {icon}
    </button>
);

