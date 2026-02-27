import { X } from 'lucide-react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useShallow } from 'zustand/react/shallow';

export function ProjectTabBar() {
    const { openProjects, activeProjectId, setActiveProject, closeProjectTab, addProjectTab } = useEngineStore(useShallow(s => ({
        openProjects: s.openProjects,
        activeProjectId: s.activeProjectId,
        setActiveProject: s.setActiveProject,
        closeProjectTab: s.closeProjectTab,
        addProjectTab: s.addProjectTab,
    })));

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
            {openProjects.map(tab => {
                const isActive = tab.id === activeProjectId;
                return (
                    <div
                        key={tab.id}
                        onClick={() => void setActiveProject(tab.id)}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            height: 26,
                            padding: '0 12px',
                            background: isActive
                                ? 'var(--color-bg-elevated)'
                                : 'transparent',
                            borderTopLeftRadius: 'var(--radius-md)',
                            borderTopRightRadius: 'var(--radius-md)',
                            // Use transparent border for inactive tabs to prevent layout shift
                            border: isActive
                                ? 'var(--space-px) solid color-mix(in srgb, var(--color-divider) 50%, transparent)'
                                : 'var(--space-px) solid transparent',
                            borderBottom: 'none',
                            color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                            fontSize: 'var(--font-size-xs)',
                            fontWeight: isActive ? 600 : 500,
                            pointerEvents: 'auto',
                            boxShadow: 'none',
                            marginLeft: 8,
                            cursor: 'pointer',
                        }}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <span style={{ opacity: isActive ? 0.9 : 0.7 }}>
                                {tab.name}
                            </span>
                            <span
                                style={{
                                    color: tab.isDirty ? 'white' : 'transparent',
                                    fontSize: 16,
                                    lineHeight: 1,
                                    width: 10,
                                    userSelect: 'none',
                                    fontWeight: 600,
                                    opacity: isActive ? 1 : 0.5,
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
                                color: isActive
                                    ? 'var(--color-text-tertiary)'
                                    : 'color-mix(in srgb, var(--color-text-tertiary) 50%, transparent)',
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
                                e.currentTarget.style.color = isActive
                                    ? 'var(--color-text-tertiary)'
                                    : 'color-mix(in srgb, var(--color-text-tertiary) 50%, transparent)';
                            }}
                            title="Close Project"
                            onClick={(e) => {
                                e.stopPropagation();
                                void closeProjectTab(tab.id);
                            }}
                        >
                            <X size={12} />
                        </button>
                    </div>
                );
            })}

            {openProjects.length < 2 && (
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
                    onClick={(e) => {
                        e.stopPropagation();
                        void addProjectTab();
                    }}
                >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="12" y1="5" x2="12" y2="19"></line>
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                </button>
            )}
        </div>
    );
}
