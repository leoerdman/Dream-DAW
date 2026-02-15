// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — FileMenu
// ═══════════════════════════════════════════════════════════════════════════
//
// Dropdown menu for File operations: New, Open, Open Recent, Save, Save As.
// Triggered from a small "☰" or "Dream DAW" branding button in TransportBar.
//
// Uses native OS dialogs for file open/save via Rust IPC.
//
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useRef, useCallback } from 'react';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';

/** Recent project entry from the Rust backend. */
interface RecentProject {
    name: string;
    path: string;
    last_opened: string;
}

interface FileMenuProps {
    /** Called after project is loaded/created — triggers UI refresh. */
    onProjectChange?: () => void;
}

export const FileMenu = ({ onProjectChange }: FileMenuProps) => {
    const [open, setOpen] = useState(false);
    const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
    const [recentHover, setRecentHover] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    // Close menu when clicking outside
    useEffect(() => {
        if (!open) return;
        const handleClick = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [open]);

    // Load recent projects when menu opens
    useEffect(() => {
        if (open) {
            engineApi.getRecentProjects()
                .then(setRecentProjects)
                .catch(err => console.error('[FileMenu] Failed to load recent:', err));
        }
    }, [open]);

    const fetchProject = useEngineStore.getState().fetchProject;
    const syncProjectHistory = useEngineStore.getState().syncProjectHistory;

    const handleNew = useCallback(async () => {
        setOpen(false);
        try {
            await engineApi.newProject();
            await fetchProject('file-menu:new');
            await syncProjectHistory();
            onProjectChange?.();
            console.log('[FileMenu] New project created');
        } catch (err) {
            console.error('[FileMenu] New project failed:', err);
        }
    }, [onProjectChange, fetchProject, syncProjectHistory]);

    const handleOpen = useCallback(async () => {
        setOpen(false);
        try {
            const path = await engineApi.pickProjectFile();
            if (!path) return; // Cancelled
            const isAbleton = path.toLowerCase().endsWith('.als');
            if (isAbleton) {
                await engineApi.importAbletonProject(path);
                // Eagerly activate external plugins in background (fire-and-forget)
                engineApi.eagerActivateExternalPlugins().catch((e) =>
                    console.warn('[FileMenu] Eager plugin activation:', e),
                );
            } else {
                await engineApi.openProject(path);
            }
            await fetchProject('file-menu:open');
            await syncProjectHistory();
            onProjectChange?.();
            console.log('[FileMenu] Opened project:', path);
        } catch (err) {
            console.error('[FileMenu] Open failed:', err);
        }
    }, [onProjectChange, fetchProject, syncProjectHistory]);

    const handleOpenRecent = useCallback(async (path: string) => {
        setOpen(false);
        try {
            const isAbleton = path.toLowerCase().endsWith('.als');
            if (isAbleton) {
                await engineApi.importAbletonProject(path);
                engineApi.eagerActivateExternalPlugins().catch((e) =>
                    console.warn('[FileMenu] Eager plugin activation:', e),
                );
            } else {
                await engineApi.openProject(path);
            }
            await fetchProject('file-menu:open-recent');
            await syncProjectHistory();
            onProjectChange?.();
            console.log('[FileMenu] Opened recent:', path);
        } catch (err) {
            console.error('[FileMenu] Open recent failed:', err);
        }
    }, [onProjectChange, fetchProject, syncProjectHistory]);

    const handleSaveAs = useCallback(async () => {
        setOpen(false);
        try {
            const flush = window.__dreamFlushPendingEdits;
            if (typeof flush === 'function') {
                await flush();
            }
            const path = await engineApi.saveProjectDialog();
            if (!path) return; // Cancelled
            await engineApi.saveProjectAs(path);
            await syncProjectHistory();
            console.log('[FileMenu] Project saved as:', path);
        } catch (err) {
            console.error('[FileMenu] Save As failed:', err);
        }
    }, [syncProjectHistory]);

    const handleSave = useCallback(async () => {
        setOpen(false);
        try {
            const flush = window.__dreamFlushPendingEdits;
            if (typeof flush === 'function') {
                await flush();
            }
            await engineApi.saveProject();
            await syncProjectHistory();
            console.log('[FileMenu] Project saved');
        } catch (err) {
            // If no path set, fallback to Save As
            console.log('[FileMenu] Save failed, trying Save As...', err);
            handleSaveAs();
        }
    }, [handleSaveAs, syncProjectHistory]);

    return (
        <div ref={menuRef} style={{ position: 'relative' }}>
            {/* ── Trigger Button ── */}
            <button
                id="file-menu-trigger"
                onClick={() => setOpen(!open)}
                title="File Menu"
                style={{
                    background: open ? 'var(--color-bg-input)' : 'transparent',
                    border: 'none',
                    borderRadius: 'var(--radius-xs)',
                    color: 'var(--color-text-secondary)',
                    fontSize: 'var(--font-size-xs)',
                    fontWeight: 600,
                    padding: '2px 8px',
                    cursor: 'pointer',
                    transition: 'all var(--transition-fast)',
                    letterSpacing: '0.5px',
                }}
                onMouseEnter={e => (e.currentTarget.style.color = 'var(--color-text-primary)')}
                onMouseLeave={e => {
                    if (!open) e.currentTarget.style.color = 'var(--color-text-secondary)';
                }}
            >
                File
            </button>

            {/* ── Dropdown ── */}
            {open && (
                <div
                    style={{
                        position: 'absolute',
                        top: '100%',
                        left: 0,
                        marginTop: 4,
                        minWidth: 220,
                        background: 'var(--color-bg-elevated)',
                        border: '1px solid var(--color-border-subtle)',
                        borderRadius: 'var(--radius-md)',
                        boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3)',
                        backdropFilter: 'blur(20px)',
                        padding: '4px 0',
                        zIndex: 9999,
                        overflow: 'visible',
                    }}
                >
                    <MenuItem
                        label="New Project"
                        shortcut="⌘N"
                        onClick={handleNew}
                    />

                    <MenuSeparator />

                    <MenuItem
                        label="Open…"
                        shortcut="⌘O"
                        onClick={handleOpen}
                    />

                    {/* ── Open Recent ▸ ── */}
                    <div
                        style={{ position: 'relative' }}
                        onMouseEnter={() => setRecentHover(true)}
                        onMouseLeave={() => setRecentHover(false)}
                    >
                        <MenuItem
                            label="Open Recent"
                            shortcut="▸"
                            onClick={() => setRecentHover(!recentHover)}
                        />

                        {recentHover && recentProjects.length > 0 && (
                            <div
                                style={{
                                    position: 'absolute',
                                    left: '100%',
                                    top: -4,
                                    minWidth: 260,
                                    background: 'var(--color-bg-elevated)',
                                    border: '1px solid var(--color-border-subtle)',
                                    borderRadius: 'var(--radius-md)',
                                    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                                    backdropFilter: 'blur(20px)',
                                    padding: '4px 0',
                                    zIndex: 10000,
                                }}
                            >
                                {recentProjects.map((rp, idx) => (
                                    <MenuItem
                                        key={idx}
                                        label={rp.name || pathBasename(rp.path)}
                                        subLabel={rp.path}
                                        onClick={() => handleOpenRecent(rp.path)}
                                    />
                                ))}
                            </div>
                        )}

                        {recentHover && recentProjects.length === 0 && (
                            <div
                                style={{
                                    position: 'absolute',
                                    left: '100%',
                                    top: -4,
                                    minWidth: 180,
                                    background: 'var(--color-bg-elevated)',
                                    border: '1px solid var(--color-border-subtle)',
                                    borderRadius: 'var(--radius-md)',
                                    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                                    backdropFilter: 'blur(20px)',
                                    padding: '8px 12px',
                                    zIndex: 10000,
                                }}
                            >
                                <span style={{
                                    fontSize: 'var(--font-size-xs)',
                                    color: 'var(--color-text-tertiary)',
                                    fontStyle: 'italic',
                                }}>
                                    No recent projects
                                </span>
                            </div>
                        )}
                    </div>

                    <MenuSeparator />

                    <MenuItem
                        label="Save"
                        shortcut="⌘S"
                        onClick={handleSave}
                    />
                    <MenuItem
                        label="Save As…"
                        shortcut="⇧⌘S"
                        onClick={handleSaveAs}
                    />
                </div>
            )}
        </div>
    );
};

// ── Sub-components ──────────────────────────────────────────────────────

const MenuItem = ({
    label,
    shortcut,
    subLabel,
    onClick,
}: {
    label: string;
    shortcut?: string;
    subLabel?: string;
    onClick: () => void;
}) => (
    <button
        onClick={onClick}
        style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            padding: '6px 12px',
            background: 'transparent',
            border: 'none',
            color: 'var(--color-text-primary)',
            fontSize: 'var(--font-size-xs)',
            fontWeight: 400,
            cursor: 'pointer',
            textAlign: 'left',
            transition: 'background var(--transition-fast)',
            gap: 16,
        }}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-accent-primary-dim)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
        <span
            style={{
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
            }}
            title={subLabel}
        >
            {label}
        </span>
        {shortcut && (
            <span style={{
                fontSize: 'var(--font-size-2xs)',
                color: 'var(--color-text-tertiary)',
                fontFamily: 'var(--font-mono)',
                whiteSpace: 'nowrap',
            }}>
                {shortcut}
            </span>
        )}
    </button>
);

const MenuSeparator = () => (
    <div style={{
        height: 1,
        background: 'var(--color-border-subtle)',
        margin: '4px 8px',
    }} />
);

/** Extracts filename from a full path. */
function pathBasename(path: string): string {
    return path.split('/').pop() || path;
}
