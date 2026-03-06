import { memo } from 'react';
import { useFlowSynthStore } from '../model/useFlowSynthStore';
import { FlowCanvas } from './FlowCanvas';

/**
 * ENTERPRISE: FlowSynth inline view — replaces the timeline area.
 *
 * Traffic lights:
 * - Red: Close Flow Synth (show timeline)
 * - Yellow: Pop out to floating window
 *
 * This component is rendered by DawShellMainView when Flow is open in inline mode.
 */

// ── ENTERPRISE: Named constants (BUG-045 pattern) ────────────────────────────
/** Traffic light button diameter. */
const TRAFFIC_LIGHT_SIZE = 12;
/** Traffic light container offsets from edges. */
const TRAFFIC_LIGHT_TOP = 8;
const TRAFFIC_LIGHT_LEFT = 12;
const TRAFFIC_LIGHT_GAP = 6;
const TRAFFIC_LIGHT_Z = 30;
/** Preset bar offsets. */
const PRESET_BAR_TOP = 8;
const PRESET_BAR_RIGHT = 12;
const PRESET_BAR_GAP = 6;
const PRESET_BAR_Z = 20;
/** Preset bar styling. */
const PRESET_BAR_MIN_WIDTH = 80;
const PRESET_BAR_BORDER_RADIUS = 4;
const PRESET_BAR_BACKDROP_BLUR = 'blur(8px)';
const PRESET_BAR_BG = 'color-mix(in srgb, var(--color-bg-elevated) 80%, transparent)';
/** Traffic light colors (macOS standard). */
const TL_RED_BG = '#ff5f57';
const TL_RED_BORDER = '#e0443e';
const TL_YELLOW_BG = '#ffbd2e';
const TL_YELLOW_BORDER = '#dea123';
/** Hover transition. */
const TL_HOVER_TRANSITION = 'filter 0.15s';

// ── Floating Preset Bar (inline version, sits top-right) ──────────────
function InlinePresetBar() {
    const presetName = useFlowSynthStore((s) => s.presetName);
    const presetIndex = useFlowSynthStore((s) => s.presetIndex);
    const nextPreset = useFlowSynthStore((s) => s.nextPreset);
    const prevPreset = useFlowSynthStore((s) => s.prevPreset);

    return (
        <div
            style={{
                position: 'absolute',
                top: PRESET_BAR_TOP,
                right: PRESET_BAR_RIGHT,
                display: 'flex',
                alignItems: 'center',
                gap: PRESET_BAR_GAP,
                zIndex: PRESET_BAR_Z,
                pointerEvents: 'auto',
            }}
        >
            <button
                onClick={prevPreset}
                style={{
                    background: PRESET_BAR_BG,
                    border: '1px solid var(--color-divider)',
                    borderRadius: PRESET_BAR_BORDER_RADIUS,
                    color: 'var(--color-text-secondary)',
                    cursor: 'pointer',
                    padding: '2px 6px',
                    fontSize: 'var(--font-size-xs)',
                    backdropFilter: PRESET_BAR_BACKDROP_BLUR,
                }}
                title="Previous Preset"
            >
                ◀
            </button>
            <span
                style={{
                    color: 'var(--color-text-primary)',
                    fontSize: 'var(--font-size-xs)',
                    fontWeight: 600,
                    letterSpacing: '0.02em',
                    minWidth: PRESET_BAR_MIN_WIDTH,
                    textAlign: 'center',
                    background: PRESET_BAR_BG,
                    border: '1px solid var(--color-divider)',
                    borderRadius: PRESET_BAR_BORDER_RADIUS,
                    padding: '2px 8px',
                    backdropFilter: PRESET_BAR_BACKDROP_BLUR,
                }}
            >
                {presetIndex + 1}. {presetName}
            </span>
            <button
                onClick={nextPreset}
                style={{
                    background: PRESET_BAR_BG,
                    border: '1px solid var(--color-divider)',
                    borderRadius: PRESET_BAR_BORDER_RADIUS,
                    color: 'var(--color-text-secondary)',
                    cursor: 'pointer',
                    padding: '2px 6px',
                    fontSize: 'var(--font-size-xs)',
                    backdropFilter: PRESET_BAR_BACKDROP_BLUR,
                }}
                title="Next Preset"
            >
                ▶
            </button>
        </div>
    );
}

export const FlowSynthInlineView = memo(function FlowSynthInlineView() {
    const isOpen = useFlowSynthStore((s) => s.isOpen);
    const displayMode = useFlowSynthStore((s) => s.displayMode);
    const closeFlowEditor = useFlowSynthStore((s) => s.closeFlowEditor);
    const setDisplayMode = useFlowSynthStore((s) => s.setDisplayMode);

    if (!isOpen || displayMode !== 'inline') return null;

    return (
        <div
            style={{
                width: '100%',
                height: '100%',
                position: 'relative',
                overflow: 'hidden',
                background: 'var(--color-bg-canvas)',
            }}
        >
            {/* ── Traffic light buttons (top-left) ── */}
            <div
                style={{
                    position: 'absolute',
                    top: TRAFFIC_LIGHT_TOP,
                    left: TRAFFIC_LIGHT_LEFT,
                    display: 'flex',
                    alignItems: 'center',
                    gap: TRAFFIC_LIGHT_GAP,
                    zIndex: TRAFFIC_LIGHT_Z,
                }}
            >
                {/* Red: Close Flow Synth → show timeline */}
                <button
                    onClick={closeFlowEditor}
                    title="Close Flow Synth"
                    style={{
                        width: TRAFFIC_LIGHT_SIZE,
                        height: TRAFFIC_LIGHT_SIZE,
                        borderRadius: '50%',
                        background: TL_RED_BG,
                        border: `1px solid ${TL_RED_BORDER}`,
                        cursor: 'pointer',
                        padding: 0,
                        transition: TL_HOVER_TRANSITION,
                    }}
                    onMouseEnter={(e) => { (e.target as HTMLElement).style.filter = 'brightness(1.2)'; }}
                    onMouseLeave={(e) => { (e.target as HTMLElement).style.filter = ''; }}
                />
                {/* Yellow: Pop out to floating window */}
                <button
                    onClick={() => setDisplayMode('floating')}
                    title="Pop out to floating window"
                    style={{
                        width: TRAFFIC_LIGHT_SIZE,
                        height: TRAFFIC_LIGHT_SIZE,
                        borderRadius: '50%',
                        background: TL_YELLOW_BG,
                        border: `1px solid ${TL_YELLOW_BORDER}`,
                        cursor: 'pointer',
                        padding: 0,
                        transition: TL_HOVER_TRANSITION,
                    }}
                    onMouseEnter={(e) => { (e.target as HTMLElement).style.filter = 'brightness(1.2)'; }}
                    onMouseLeave={(e) => { (e.target as HTMLElement).style.filter = ''; }}
                />
            </div>

            {/* ── Preset Bar (top-right) ── */}
            <InlinePresetBar />

            {/* ── Flow Canvas (full area) ── */}
            <FlowCanvas />
        </div>
    );
});

export default FlowSynthInlineView;
