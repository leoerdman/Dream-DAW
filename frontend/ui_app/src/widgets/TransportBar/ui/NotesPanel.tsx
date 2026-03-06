import { useEffect, useRef, useState, useCallback } from 'react';
import { Pin, X } from 'lucide-react';
import * as engineApi from '@/shared/api/engine';
import type { CSSProperties, MouseEvent, MutableRefObject } from 'react';

const NOTES_PIN_KEY = 'dream-daw-notes-pinned';

// P3 FIX: Named constants for timeouts and dimensions.
/** Debounce interval for auto-save after typing (ms). */
const AUTOSAVE_DEBOUNCE_MS = 500;
/** Duration to show "Saved" indicator before fading (ms). */
const SAVED_INDICATOR_MS = 1500;
/** Notes panel dimensions (px). */
const PANEL_WIDTH = 320;
const PANEL_HEIGHT = 300;
/** Header padding. */
const HEADER_PADDING = '6px 10px';
/** Textarea padding. */
const TEXTAREA_PADDING = '10px 12px';
/** Saved indicator font size. */
const SAVED_FONT_SIZE = 10;
/** Pin/close button size. */
const ICON_BTN_SIZE = 20;

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
                console.warn('[Dream] Failed to load notes:', err);
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
                    console.warn('[Dream] Failed to save notes:', err);
                    setSaveStatus('idle');
                });
        }, AUTOSAVE_DEBOUNCE_MS);
    }, []);

    // Flush pending save on unmount using ref (never stale)
    useEffect(() => {
        return () => {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
                engineApi.setProjectNotes(latestTextRef.current).catch((err) => {
                    // BUG-R4-002 FIX: Log error instead of silently swallowing.
                    console.warn('[Dream] Failed to save notes on unmount:', err);
                });
            }
        };
    }, []);

    // Reset "saved" indicator after 1.5s
    useEffect(() => {
        if (saveStatus !== 'saved') return;
        const t = setTimeout(() => setSaveStatus('idle'), SAVED_INDICATOR_MS);
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

// eslint-disable-next-line react-refresh/only-export-components
export function readNotesPinned(): boolean {
    try {
        const raw = window.localStorage.getItem(NOTES_PIN_KEY);
        return raw === null ? true : raw === 'true'; // default: pinned
    } catch {
        return true;
    }
}

// eslint-disable-next-line react-refresh/only-export-components
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
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--color-bg-panel)',
    border: 'var(--space-px) solid var(--color-divider)',
    borderRadius: 'var(--radius-lg)',
    boxShadow: '0 2px 8px var(--color-overlay-dark)',
    zIndex: 'var(--z-tooltip)',
    overflow: 'hidden',
});

const headerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: HEADER_PADDING,
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
    fontSize: SAVED_FONT_SIZE,
    color: 'var(--color-status-success)',
    opacity: 0.7,
};

const pinBtnStyle = (active: boolean): CSSProperties => ({
    width: ICON_BTN_SIZE,
    height: ICON_BTN_SIZE,
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
    width: ICON_BTN_SIZE,
    height: ICON_BTN_SIZE,
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
    padding: TEXTAREA_PADDING,
    fontFamily: 'var(--font-role-body)',
    fontSize: 'var(--font-size-sm)',
    lineHeight: 1.6,
    color: 'var(--color-text-primary)',
    background: 'transparent',
    caretColor: 'var(--color-accent-primary)',
    overflowY: 'auto',
};
