import { Bot, Download, Eye, EyeOff, Settings, StickyNote } from 'lucide-react';
import { PillSection } from './TransportAtoms';
import { PerformanceMonitor } from './PerformanceMonitor';
import { iconBtnStyle } from './TransportSectionStyles';
import type { TransportRightSectionProps } from './TransportSectionTypes';

export function TransportRightSection(props: TransportRightSectionProps) {
    const { midiLedRef, pdcOpen, setPdcOpen, notesOpen, setNotesOpen, assistantOpen, onAssistantToggle, onOpenExport, onSettingsClick } = props;
    const prefetchSettings = () => {
        void import('@/widgets/SettingsPanel/SettingsPanel');
    };
    return (
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
            <PerformanceMonitor />
            <PillSection>
                <span ref={midiLedRef} style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-status-success)', opacity: 0.35, boxShadow: '0 0 var(--space-2) color-mix(in srgb, var(--color-status-success) 75%, transparent)', transition: 'opacity 40ms linear' }} />
                <span style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-midi-indicator)' }}>MIDI</span>
                <button onClick={() => setPdcOpen((v) => !v)} title="Debug Panel" aria-label="Debug Panel" style={iconBtnStyle(pdcOpen ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)', pdcOpen ? 'color-mix(in srgb, var(--color-accent-primary) 14%, transparent)' : 'transparent')}>{pdcOpen ? <EyeOff size={15} /> : <Eye size={15} />}</button>
                <button onClick={() => setNotesOpen((v) => !v)} title="Project Notes" aria-label="Project Notes" style={iconBtnStyle(notesOpen ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)', notesOpen ? 'color-mix(in srgb, var(--color-accent-primary) 14%, transparent)' : 'transparent')}><StickyNote size={15} /></button>
                <button onClick={() => onAssistantToggle?.()} title="AI Assistant" aria-label="AI Assistant" style={iconBtnStyle(assistantOpen ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)', assistantOpen ? 'color-mix(in srgb, var(--color-accent-primary) 14%, transparent)' : 'transparent')}><Bot size={15} /></button>
                <button onClick={() => onOpenExport?.()} title="Export Audio (⇧⌘R)" aria-label="Export Audio" style={iconBtnStyle('var(--color-text-secondary)', 'transparent')}><Download size={15} /></button>
                <button onClick={onSettingsClick} onMouseEnter={prefetchSettings} onFocus={prefetchSettings} title="Settings (⌘,)" aria-label="Settings" style={iconBtnStyle('var(--color-text-secondary)', 'transparent')}><Settings size={15} /></button>
            </PillSection>
        </div>
    );
}
