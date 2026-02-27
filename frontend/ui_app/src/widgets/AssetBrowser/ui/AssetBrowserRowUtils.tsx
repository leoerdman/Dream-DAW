import React from 'react';

const HIGHLIGHT_STYLE: React.CSSProperties = { color: 'var(--color-accent-primary)', fontWeight: 700 };

export function renderHighlightedMatch(name: string, query: string): React.ReactNode {
    if (!query.trim()) return name;
    const q = query.trim().toLowerCase();
    const lower = name.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx < 0) {
        const initials = q.split('');
        const parts: React.ReactNode[] = [];
        let cursor = 0;
        for (const ch of initials) {
            const pos = lower.indexOf(ch, cursor);
            if (pos < 0) return name;
            if (pos > cursor) parts.push(name.slice(cursor, pos));
            parts.push(
                <span key={pos} style={HIGHLIGHT_STYLE}>
                    {name[pos]}
                </span>,
            );
            cursor = pos + 1;
        }
        if (cursor < name.length) parts.push(name.slice(cursor));
        return <>{parts}</>;
    }
    return (
        <>
            {name.slice(0, idx)}
            <span style={HIGHLIGHT_STYLE}>
                {name.slice(idx, idx + q.length)}
            </span>
            {name.slice(idx + q.length)}
        </>
    );
}
