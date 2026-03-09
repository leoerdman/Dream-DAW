import { useState, useCallback } from 'react';
import { Bot, Upload, Eye, EyeOff, Settings, StickyNote, Activity } from 'lucide-react';
import { PillSection } from './TransportAtoms';
import { PerformanceMonitor } from './PerformanceMonitor';
import { DetailedPerformancePanel } from './DetailedPerformancePanel';
import { iconBtnStyle } from './TransportSectionStyles';
import type { TransportRightSectionProps } from './TransportSectionTypes';

export function TransportRightSection(props: TransportRightSectionProps) {
    const { midiLedRef, pdcOpen, setPdcOpen, notesOpen, setNotesOpen, assistantOpen, onAssistantToggle, onOpenExport, onSettingsClick } = props;
    const [perfPanelOpen, setPerfPanelOpen] = useState(false);
    const handleClosePerfPanel = useCallback(() => setPerfPanelOpen(false), []);
    const prefetchSettings = () => {
        void import('@/widgets/SettingsPanel/SettingsPanel');
    };
    return (
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
            <PerformanceMonitor />
            {/* Monitor button — opens detailed performance panel */}
            <button
                onClick={() => setPerfPanelOpen((v) => !v)}
                title="Detailed Performance Monitor"
                aria-label="Detailed Performance Monitor"
                style={{
                    ...iconBtnStyle(
                        perfPanelOpen ? 'var(--color-accent-primary)' : 'var(--color-text-tertiary)',
                        perfPanelOpen ? 'color-mix(in srgb, var(--color-accent-primary) 14%, transparent)' : 'color-mix(in srgb, var(--color-bg-secondary) 60%, transparent)',
                    ),
                    border: '1px solid color-mix(in srgb, var(--color-border) 30%, transparent)',
                    borderRadius: 'var(--radius-md)',
                    height: 22,
                    width: 26,
                    padding: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                <Activity size={13} />
            </button>
            {perfPanelOpen && <DetailedPerformancePanel onClose={handleClosePerfPanel} />}
            {/* MIDI activity indicator — not a button, just a status LED that blinks green on MIDI input */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '0 6px',
                    height: 22,
                    borderRadius: 'var(--radius-md)',
                    background: 'color-mix(in srgb, var(--color-bg-secondary) 60%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--color-border) 30%, transparent)',
                    userSelect: 'none',
                    flexShrink: 0,
                }}
                title="MIDI Activity — blinks when MIDI messages are received"
            >
                <span
                    ref={midiLedRef}
                    style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: 'var(--color-status-success)',
                        opacity: 0.35,
                        boxShadow: '0 0 3px color-mix(in srgb, var(--color-status-success) 60%, transparent)',
                        transition: 'opacity 40ms linear',
                        flexShrink: 0,
                    }}
                />
                <span style={{
                    fontSize: 'var(--font-size-2xs)',
                    fontWeight: 600,
                    letterSpacing: '0.03em',
                    color: 'var(--color-text-tertiary)',
                    fontFamily: 'var(--font-role-data)',
                }}>MIDI</span>
            </div>
            <PillSection>
                <button onClick={() => setPdcOpen((v) => !v)} title="Debug Panel" aria-label="Debug Panel" style={iconBtnStyle(pdcOpen ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)', pdcOpen ? 'color-mix(in srgb, var(--color-accent-primary) 14%, transparent)' : 'transparent')}>{pdcOpen ? <EyeOff size={15} /> : <Eye size={15} />}</button>
                <button onClick={() => setNotesOpen((v) => !v)} title="Project Notes (⌥N)" aria-label="Project Notes" style={iconBtnStyle(notesOpen ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)', notesOpen ? 'color-mix(in srgb, var(--color-accent-primary) 14%, transparent)' : 'transparent')}><StickyNote size={15} /></button>
                <button onClick={() => onAssistantToggle?.()} title="AI Assistant" aria-label="AI Assistant" style={iconBtnStyle(assistantOpen ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)', assistantOpen ? 'color-mix(in srgb, var(--color-accent-primary) 14%, transparent)' : 'transparent')}><Bot size={15} /></button>
                <button onClick={() => onOpenExport?.()} title="Export Audio (⇧⌘R)" aria-label="Export Audio" style={iconBtnStyle('var(--color-text-secondary)', 'transparent')}><Upload size={15} /></button>
                <button onClick={onSettingsClick} onMouseEnter={prefetchSettings} onFocus={prefetchSettings} title="Settings (⌘,)" aria-label="Settings" style={iconBtnStyle('var(--color-text-secondary)', 'transparent')}><Settings size={15} /></button>
            </PillSection>
        </div>
    );
}

