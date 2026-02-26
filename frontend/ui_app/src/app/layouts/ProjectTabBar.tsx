import { X } from 'lucide-react';
import { useProjectManager } from '@/shared/hooks/useProjectManager';
import { useEngineStore } from '@/shared/stores/useEngineStore';

export function ProjectTabBar() {
    const { filePath: projectFilePath } = useProjectManager();
    const isDirty = useEngineStore((s) => s.isDirty);

    const projectName = projectFilePath
        ? projectFilePath.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, '') ?? 'Untitled'
        : 'Untitled';

    return (
        <div
            data-tauri-drag-region
            style={{
                display: 'flex',
                height: 32,
                alignItems: 'flex-end',
                paddingLeft: 70, // macOS traffic lights padding offset
                background: 'color-mix(in srgb, var(--color-bg-elevated) 40%, transparent)', // Slightly lighter than pure black
                borderBottom: 'none',
                userSelect: 'none',
                flexShrink: 0,
                width: '100%',
                position: 'relative',
                zIndex: 100,
            }}
        >
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    height: 26,
                    padding: '0 12px',
                    background: 'var(--color-bg-elevated)', // Exactly matches Transport Bar
                    borderTopLeftRadius: 'var(--radius-md)',
                    borderTopRightRadius: 'var(--radius-md)',
                    border: 'var(--space-px) solid color-mix(in srgb, var(--color-divider) 50%, transparent)',
                    borderBottom: 'none',
                    color: 'var(--color-text-primary)',
                    fontSize: 'var(--font-size-xs)',
                    fontWeight: 500,
                    pointerEvents: 'auto',
                    boxShadow: '0 -1px 4px color-mix(in srgb, var(--color-background-elevated) 10%, transparent)',
                    marginLeft: 8,
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ opacity: 0.9 }}>{projectName}</span>
                    <span
                        style={{
                            color: isDirty ? 'white' : 'transparent',
                            fontSize: 16,
                            lineHeight: 1,
                            width: 10,
                            userSelect: 'none',
                            fontWeight: 600,
                        }}
                    >
                        *
                    </span>
                </div>
                <button
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 16,
                        height: 16,
                        borderRadius: 3,
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--color-text-tertiary)',
                        cursor: 'pointer',
                        padding: 0,
                        marginLeft: 4,
                    }}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'color-mix(in srgb, var(--color-text-primary) 10%, transparent)';
                        e.currentTarget.style.color = 'var(--color-text-primary)';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                        e.currentTarget.style.color = 'var(--color-text-tertiary)';
                    }}
                    title="Close Project"
                >
                    <X size={12} />
                </button>
            </div>

            <button
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 24,
                    height: 24,
                    borderRadius: 'var(--radius-sm)',
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--color-text-tertiary)',
                    cursor: 'pointer',
                    padding: 0,
                    marginLeft: 8,
                    marginBottom: 1,
                    pointerEvents: 'auto',
                }}
                onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'color-mix(in srgb, var(--color-text-primary) 10%, transparent)';
                    e.currentTarget.style.color = 'var(--color-text-primary)';
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = 'var(--color-text-tertiary)';
                }}
                title="New Project"
            >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
            </button>
        </div>
    );
}
