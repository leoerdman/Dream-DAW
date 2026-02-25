import { type CSSProperties } from 'react';
export { SampleClipEditor } from './SampleClipEditor';

export const EmptyClipEditor = () => (
    <div style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'radial-gradient(circle at 50% 20%, color-mix(in srgb, var(--color-bg-panel) 88%, var(--token-color-hex-2a3a55)) 0%, var(--color-bg-panel) 66%)',
    }}>
        <div style={cardStyle}>
            <div style={titleStyle}>No Clip Selected</div>
            <div style={textStyle}>Select a MIDI or audio clip on the timeline to open the editor.</div>
            <div style={hintStyle}>Shift+Tab switches Rack/Clip panel</div>
        </div>
    </div>
);

const cardStyle: CSSProperties = {
    textAlign: 'center',
    padding: 'var(--token-size-px-18) var(--token-size-px-26)',
    border: 'var(--space-px) solid color-mix(in srgb, var(--color-accent-primary) 24%, var(--color-divider))',
    borderRadius: 'var(--radius-xl)',
    background: 'color-mix(in srgb, var(--color-bg-header) 86%, var(--token-color-hex-0a111f))',
    boxShadow: '0 var(--space-2-5) var(--space-6) var(--color-overlay-dark)',
    maxWidth: 520,
};

const titleStyle: CSSProperties = {
    color: 'var(--color-text-primary)',
    fontSize: 'var(--font-size-2xl)',
    fontWeight: 'var(--font-weight-bold)',
    letterSpacing: '0.03em',
    marginBottom: 6,
};

const textStyle: CSSProperties = {
    color: 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-base)',
    lineHeight: 1.5,
};

const hintStyle: CSSProperties = {
    marginTop: 8,
    fontSize: 'var(--font-size-xs)',
    color: 'var(--color-text-tertiary)',
    fontFamily: 'var(--font-role-data)',
};
