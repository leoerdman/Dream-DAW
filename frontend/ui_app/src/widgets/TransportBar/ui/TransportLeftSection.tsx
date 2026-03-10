import { Music } from 'lucide-react';
import { ALL_DIVISIONS } from '@/shared/lib/gridSnap';
import { KEY_MODES, KEY_TONICS } from '../model/transportBarDomain';
import { ControlButton, PillSection } from './TransportAtoms';
import { TRANSPORT_UI } from './TransportUiTokens';
import { keyMenuItemStyle } from './TransportSectionStyles';
import type { TransportLeftSectionProps } from './TransportSectionTypes';

export function TransportLeftSection(props: TransportLeftSectionProps) {
    const {
        handleTapTempo,
        bpmEditing,
        bpmText,
        setBpmText,
        commitBpm,
        setBpmEditing,
        bpm,
        bpmRef,
        valueChipStyle,
        cycleTimeSignature,
        timeSigNum,
        timeSigDen,
        keyEnabled,
        keyTonic,
        keyMode,
        keyMenuRef,
        keyMenuOpen,
        setKeyMenuOpen,
        onToggleKeyEnabled,
        onSelectKeyTonic,
        onSelectKeyMode,
        gridRef,
        gridOpen,
        setGridOpen,
        gridDivision,
        gridTriplet,
        setGridDivision,
        metronomeEnabled,
        onToggleMetronome,
    } = props;
    const gridLabel = gridDivision === 'ADAPTIVE' ? 'Adaptive' : gridTriplet ? `${gridDivision}T` : gridDivision;
    return (
        <div style={{ display: 'flex', alignItems: 'center' }}>
            <PillSection>
                <ControlButton label="Tap" onClick={handleTapTempo} />
                {bpmEditing ? (
                    <input
                        ref={bpmRef}
                        type="text"
                        value={bpmText}
                        onChange={(e) => setBpmText(e.target.value)}
                        onBlur={commitBpm}
                        onKeyDown={(e) => e.key === 'Enter' && commitBpm()}
                        autoFocus
                        style={{
                            ...valueChipStyle,
                            width: 56,
                            minWidth: 56,
                            outline: 'none',
                            boxShadow: '0 0 0 var(--space-px) color-mix(in srgb, var(--color-accent-primary) 42%, transparent)',
                        }}
                    />
                ) : (
                    <button onClick={() => { setBpmEditing(true); setBpmText(bpm.toFixed(2)); }} style={valueChipStyle}>{bpm.toFixed(2)}</button>
                )}
                <button onClick={cycleTimeSignature} style={valueChipStyle} title="Time Signature">{timeSigNum}<span style={{ color: 'var(--color-text-secondary)', margin: '0 var(--space-px)' }}>/</span>{timeSigDen}</button>
            </PillSection>
            <PillSection>
                <div
                    ref={keyMenuRef}
                    style={{
                        position: 'relative',
                        display: 'flex',
                        alignItems: 'center',
                        height: TRANSPORT_UI.controlHeight,
                    }}
                >
                    <button
                        onClick={() => setKeyMenuOpen(!keyMenuOpen)}
                        title="Key Signature"
                        style={{
                            ...valueChipStyle,
                            minWidth: 132,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 8,
                            background: keyMenuOpen ? 'color-mix(in srgb, var(--color-accent-primary) 14%, var(--color-bg-header))' : TRANSPORT_UI.controlBg,
                        }}
                    >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <Music size={12} />
                            <span>{KEY_TONICS[keyTonic]} {KEY_MODES[keyMode]}</span>
                        </span>
                        <span style={{ opacity: 0.85, fontSize: 'var(--font-size-xs)' }}>▾</span>
                    </button>
                    {keyMenuOpen && (
                        <div
                            style={{
                                position: 'absolute',
                                left: 0,
                                top: 30,
                                minWidth: 360,
                                background: 'var(--color-bg-elevated)',
                                border: 'var(--space-px) solid var(--color-divider)',
                                borderRadius: 'var(--radius-md)',
                                boxShadow: '0 var(--space-2) var(--token-size-px-18) var(--color-overlay-dark)',
                                zIndex: 'var(--z-tooltip)',
                                padding: 8,
                                display: 'grid',
                                gridTemplateColumns: '1fr 1fr',
                                columnGap: 8,
                            }}
                        >
                            <button
                                onClick={onToggleKeyEnabled}
                                style={{
                                    gridColumn: '1 / span 2',
                                    ...valueChipStyle,
                                    minWidth: '100%',
                                    justifyContent: 'flex-start',
                                    marginBottom: 6,
                                }}
                            >
                                {keyEnabled ? 'Disable Key Signature' : 'Enable Key Signature'}
                            </button>
                            <div style={{ color: 'var(--color-text-primary)', fontSize: 'var(--font-size-2xs)', fontWeight: 700, padding: '0 var(--space-1)' }}>TONIC</div>
                            <div style={{ color: 'var(--color-text-primary)', fontSize: 'var(--font-size-2xs)', fontWeight: 700, padding: '0 var(--space-1)' }}>MODE</div>
                            <div style={{ display: 'grid', gap: 2 }}>
                                {KEY_TONICS.map((tonic, idx) => (
                                    <button
                                        key={tonic}
                                        onClick={() => {
                                            onSelectKeyTonic(idx);
                                            // ENTERPRISE FIX: Keep menu open after tonic selection
                                            // so user can also adjust mode without reopening.
                                        }}
                                        style={keyMenuItemStyle(idx === keyTonic)}
                                    >
                                        {idx === keyTonic ? '✓ ' : ''}{tonic}
                                    </button>
                                ))}
                            </div>
                            <div style={{ display: 'grid', gap: 2 }}>
                                {KEY_MODES.map((mode, idx) => (
                                    <button
                                        key={mode}
                                        onClick={() => {
                                            onSelectKeyMode(idx);
                                            setKeyMenuOpen(false);
                                        }}
                                        style={keyMenuItemStyle(idx === keyMode)}
                                    >
                                        {idx === keyMode ? '✓ ' : ''}{mode}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </PillSection>
            <PillSection style={{ gap: 6 }}>
                <span
                    style={{
                        fontSize: 'var(--font-size-xs)',
                        color: 'var(--color-text-secondary)',
                        fontFamily: 'var(--font-role-data)',
                        fontWeight: 600,
                        lineHeight: `${TRANSPORT_UI.controlHeight}px`,
                    }}
                >
                    Grid
                </span>
                <div
                    ref={gridRef}
                    style={{
                        position: 'relative',
                        display: 'flex',
                        alignItems: 'center',
                        height: TRANSPORT_UI.controlHeight,
                    }}
                >
                    <button
                        onClick={() => setGridOpen(!gridOpen)}
                        title="Grid Size"
                        style={{
                            ...valueChipStyle,
                            minWidth: 58,
                            background: gridOpen ? 'var(--color-accent-primary-dim)' : TRANSPORT_UI.controlBg,
                            gap: 4,
                        }}
                    >
                        <span>{gridLabel}</span>
                        <span style={{ opacity: 0.8, fontSize: 'var(--font-size-xs)' }}>▾</span>
                    </button>
                    {gridOpen && (
                        <div
                            style={{
                                position: 'absolute',
                                left: 0,
                                top: 28,
                                minWidth: 108,
                                background: 'var(--color-bg-elevated)',
                                border: 'var(--space-px) solid var(--color-divider)',
                                borderRadius: 'var(--radius-md)',
                                boxShadow: '0 var(--space-2) var(--token-size-px-18) var(--color-overlay-dark)',
                                zIndex: 'var(--z-tooltip)',
                                padding: 'var(--space-1) 0',
                            }}
                        >
                            {ALL_DIVISIONS.map((div) => {
                                const active = gridDivision === div;
                                const label = div === 'ADAPTIVE' ? 'Adaptive' : div;
                                return (
                                    <button
                                        key={div}
                                        onClick={() => {
                                            setGridDivision(div);
                                            setGridOpen(false);
                                        }}
                                        style={{
                                            width: '100%',
                                            textAlign: 'left',
                                            border: 'none',
                                            background: active ? 'var(--color-accent-primary-dim)' : 'transparent',
                                            color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                                            fontSize: 'var(--font-size-xs)',
                                            fontFamily: 'var(--font-role-data)',
                                            padding: 'var(--space-1) var(--space-2)',
                                            cursor: 'pointer',
                                        }}
                                    >
                                        {label}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            </PillSection>
            {/* ── Metronome Toggle + Context Menu ── */}
            <PillSection>
                <div
                    ref={props.metronomeMenuRef}
                    style={{ position: 'relative', display: 'flex', alignItems: 'center' }}
                >
                    <button
                        onClick={onToggleMetronome}
                        onContextMenu={(e) => {
                            e.preventDefault();
                            props.setMetronomeMenuOpen(!props.metronomeMenuOpen);
                        }}
                        title={metronomeEnabled ? 'Metronome ON – click to disable · Right-click for settings' : 'Metronome OFF – click to enable · Right-click for settings'}
                        aria-label="Toggle metronome"
                        aria-pressed={metronomeEnabled}
                        style={{
                            ...valueChipStyle,
                            minWidth: 30,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 0,
                            background: metronomeEnabled
                                ? 'var(--color-accent-primary-dim)'
                                : TRANSPORT_UI.controlBg,
                            color: metronomeEnabled
                                ? 'var(--color-accent-primary)'
                                : 'var(--color-text-tertiary)',
                            border: metronomeEnabled
                                ? 'var(--space-px) solid var(--color-accent-primary)'
                                : `var(--space-px) solid ${TRANSPORT_UI.controlBorder}`,
                        }}
                    >
                        {/* Inline SVG metronome icon — triangular pendulum */}
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 2 L5 22 H19 L12 2 Z" />
                            <line x1="12" y1="22" x2="18" y2="8" />
                        </svg>
                    </button>
                    {props.metronomeMenuOpen && (
                        <div
                            style={{
                                position: 'absolute',
                                left: 0,
                                top: 30,
                                minWidth: 180,
                                background: 'var(--color-bg-elevated)',
                                border: 'var(--space-px) solid var(--color-divider)',
                                borderRadius: 'var(--radius-md)',
                                boxShadow: '0 var(--space-2) var(--token-size-px-18) var(--color-overlay-dark)',
                                zIndex: 'var(--z-tooltip)',
                                padding: 'var(--space-2)',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 8,
                            }}
                        >
                            {/* ── Volume Fader ── */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <span style={{
                                    fontSize: 'var(--font-size-2xs)',
                                    color: 'var(--color-text-secondary)',
                                    fontWeight: 600,
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.05em',
                                }}>
                                    Volume
                                </span>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <input
                                        type="range"
                                        min={0}
                                        max={200}
                                        step={1}
                                        value={Math.round(props.metronomeVolume * 100)}
                                        onChange={(e) => {
                                            const pct = Number(e.target.value);
                                            props.onMetronomeVolumeChange(pct / 100);
                                        }}
                                        style={{
                                            flex: 1,
                                            height: 4,
                                            accentColor: 'var(--color-accent-primary)',
                                            cursor: 'pointer',
                                        }}
                                    />
                                    <span style={{
                                        fontSize: 'var(--font-size-xs)',
                                        fontFamily: 'var(--font-role-data)',
                                        color: 'var(--color-text-primary)',
                                        minWidth: 36,
                                        textAlign: 'right',
                                    }}>
                                        {Math.round(props.metronomeVolume * 100)}%
                                    </span>
                                </div>
                            </div>
                            {/* ── Sound Type ── */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <span style={{
                                    fontSize: 'var(--font-size-2xs)',
                                    color: 'var(--color-text-secondary)',
                                    fontWeight: 600,
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.05em',
                                }}>
                                    Sound
                                </span>
                                <div style={{
                                    fontSize: 'var(--font-size-xs)',
                                    color: 'var(--color-text-tertiary)',
                                    padding: '4px 0',
                                }}>
                                    Click (Sine)
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </PillSection>
        </div>
    );
}
