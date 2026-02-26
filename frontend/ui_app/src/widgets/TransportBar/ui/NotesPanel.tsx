import { useEffect, useRef, useState, useCallback } from 'react';
import { X } from 'lucide-react';
import * as engineApi from '@/shared/api/engine';
import type { CSSProperties, MouseEvent, MutableRefObject } from 'react';

interface NotesPanelProps {
    panelRef: MutableRefObject<HTMLDivElement | null>;
    panelPos: { right: number; top: number };
    onDragStart: (e: MouseEvent<HTMLDivElement>) => void;
    onClose: () => void;
}

export function NotesPanel({ panelRef, panelPos, onDragStart, onClose }: NotesPanelProps) {
    const [text, setText] = useState('');
    const [loaded, setLoaded] = useState(false);
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // BUG-FIX: Use a ref for the latest text so the unmount cleanup
    // always has the current value, not a stale closure capture.
    const latestTextRef = useRef(text);
    latestTextRef.current = text;

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
                engineApi.setProjectNotes(latestTextRef.current).catch(() => { });
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {saveStatus === 'saved' && (
                        <span style={savedIndicatorStyle}>Saved</span>
                    )}
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
