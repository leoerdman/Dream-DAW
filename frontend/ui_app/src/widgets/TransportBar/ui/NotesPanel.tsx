import { useEffect, useRef, useState, useCallback } from 'react';
import { Pin, X } from 'lucide-react';
import * as engineApi from '@/shared/api/engine';
import type { CSSProperties, MouseEvent, MutableRefObject } from 'react';

const NOTES_PIN_KEY = 'dream-daw-notes-pinned';

interface NotesPanelProps {
    panelRef: MutableRefObject<HTMLDivElement | null>;
    panelPos: { right: number; top: number };
    onDragStart: (e: MouseEvent<HTMLDivElement>) => void;
    onClose: () => void;
    /** When true, click-outside does NOT close the panel. */
    pinned: boolean;
    onPinnedChange: (pinned: boolean) => void;
}

export function NotesPanel({ panelRef, panelPos, onDragStart, onClose, pinned, onPinnedChange }: NotesPanelProps) {
    const [text, setText] = useState('');
    const [loaded, setLoaded] = useState(false);
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const latestTextRef = useRef(text);
    useEffect(() => {
        latestTextRef.current = text;
    }, [text]);

    // Load notes from project on mount
    useEffect(() => {
        let cancelled = false;
        engineApi.getProjectNotes()
            .then((notes) => {
                if (cancelled) return;
                setText(notes);
                setLoaded(true);
            })
            .catch((err) => {
                if (cancelled) return;
                console.warn('[NotesPanel] Failed to load notes:', err);
                setLoaded(true);
            });
        return () => { cancelled = true; };
    }, []);

    // Debounced auto-save (500ms after last keystroke)
    const handleChange = useCallback((value: string) => {
        setText(value);
        setSaveStatus('saving');
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            engineApi.setProjectNotes(value)
                .then(() => setSaveStatus('saved'))
                .catch((err) => {
                    console.warn('[NotesPanel] Failed to save notes:', err);
                    setSaveStatus('idle');
                });
        }, 500);
    }, []);

    // Flush pending save on unmount using ref (never stale)
    useEffect(() => {
        return () => {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
                engineApi.setProjectNotes(latestTextRef.current).catch((err) => {
                    // BUG-R4-002 FIX: Log error instead of silently swallowing.
                    console.warn('[NotesPanel] Failed to save notes on unmount:', err);
                });
            }
        };
    }, []);

    // Reset "saved" indicator after 1.5s
    useEffect(() => {
        if (saveStatus !== 'saved') return;
        const t = setTimeout(() => setSaveStatus('idle'), 1500);
        return () => clearTimeout(t);
    }, [saveStatus]);

    return (
        <div ref={panelRef} style={panelStyle(panelPos)}>
            {/* Header — drag handle */}
            <div onMouseDown={onDragStart} style={headerStyle}>
                <div style={titleStyle}>Notes</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {saveStatus === 'saved' && (
                        <span style={savedIndicatorStyle}>Saved</span>
                    )}
                    <button
                        onClick={() => onPinnedChange(!pinned)}
                        title={pinned ? 'Unpin (click outside will close)' : 'Pin (stay open)'}
                        style={pinBtnStyle(pinned)}
                    >
                        <Pin size={11} />
                    </button>
                    <button onClick={onClose} title="Close" style={closeBtnStyle}>
                        <X size={12} />
                    </button>
                </div>
            </div>

            {/* Text editor */}
            <textarea
                value={text}
                onChange={(e) => handleChange(e.target.value)}
                placeholder={loaded ? 'Write your project notes here…' : 'Loading…'}
                readOnly={!loaded}
                spellCheck={false}
                style={textareaStyle}
            />
        </div>
    );
}

// ── Helper: read/write pin state from localStorage ────────────────────

export function readNotesPinned(): boolean {
    try {
        const raw = window.localStorage.getItem(NOTES_PIN_KEY);
        return raw === null ? true : raw === 'true'; // default: pinned
    } catch {
        return true;
    }
}

export function writeNotesPinned(pinned: boolean): void {
    try {
        window.localStorage.setItem(NOTES_PIN_KEY, String(pinned));
    } catch { /* ignore */ }
}

// ── Styles ────────────────────────────────────────────────────────────

const panelStyle = (pos: { right: number; top: number }): CSSProperties => ({
    position: 'fixed',
    right: pos.right,
    top: pos.top,
    width: 320,
    height: 300,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--color-bg-panel)',
    border: 'var(--space-px) solid var(--color-divider)',
    borderRadius: 'var(--radius-lg)',
    boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
    zIndex: 'var(--z-tooltip)',
    overflow: 'hidden',
});

const headerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 10px',
    borderBottom: 'var(--space-px) solid var(--color-divider)',
    cursor: 'move',
    userSelect: 'none',
    flexShrink: 0,
};

const titleStyle: CSSProperties = {
    fontSize: 'var(--font-size-xs)',
    fontWeight: 'var(--font-weight-semibold)',
    color: 'var(--color-text-primary)',
    letterSpacing: '0.01em',
};

const savedIndicatorStyle: CSSProperties = {
    fontSize: 10,
    color: 'var(--color-status-success)',
    opacity: 0.7,
};

const pinBtnStyle = (active: boolean): CSSProperties => ({
    width: 20,
    height: 20,
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: active
        ? 'color-mix(in srgb, var(--color-accent-primary) 14%, transparent)'
        : 'transparent',
    color: active ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)',
    cursor: 'pointer',
    transform: active ? 'rotate(0deg)' : 'rotate(45deg)',
    transition: 'transform 150ms ease, color 100ms ease, background 100ms ease',
});

const closeBtnStyle: CSSProperties = {
    width: 20,
    height: 20,
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    color: 'var(--color-text-secondary)',
    cursor: 'pointer',
    opacity: 0.7,
};

const textareaStyle: CSSProperties = {
    flex: 1,
    resize: 'none',
    border: 'none',
    outline: 'none',
    padding: '10px 12px',
    fontFamily: 'var(--font-role-body)',
    fontSize: 'var(--font-size-sm)',
    lineHeight: 1.6,
    color: 'var(--color-text-primary)',
    background: 'transparent',
    caretColor: 'var(--color-accent-primary)',
    overflowY: 'auto',
};
