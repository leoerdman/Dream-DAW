import React from 'react';

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
                <span key={pos} style={{ color: 'var(--color-accent-primary)', fontWeight: 700 }}>
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
            <span style={{ color: 'var(--color-accent-primary)', fontWeight: 700 }}>
                {name.slice(idx, idx + q.length)}
            </span>
            {name.slice(idx + q.length)}
        </>
    );
}
