import React from 'react';
import { createPortal } from 'react-dom';
import {
    EQ_FILTER_LABELS,
    EQ_FILTER_TYPE_TO_INDEX,
    DEFAULT_EQ_FILTER_TYPE_INDEX,
    bandDotY,
    freqToX,
    type EqBand8,
} from '@/widgets/DeviceRack/lib/eqMath';

export type EqContextMenu = { x: number; y: number; bandIdx: number };

type BandOverlaysProps = {
    bands: EqBand8[];
    dragEqBand: number | null;
    selectedEqBand: number | null;
    setSelectedEqBand: React.Dispatch<React.SetStateAction<number | null>>;
    beginEqBandGesture: (bandIdx: number) => void;
    setDragEqBand: React.Dispatch<React.SetStateAction<number | null>>;
    setEqContextMenu: React.Dispatch<React.SetStateAction<EqContextMenu | null>>;
    onParamChange: (paramName: string, value: number) => void;
    vbW: number;
    vbH: number;
};

export function EqBandOverlays({
    bands,
    dragEqBand,
    selectedEqBand,
    setSelectedEqBand,
    beginEqBandGesture,
    setDragEqBand,
    setEqContextMenu,
    onParamChange,
    vbW,
    vbH,
}: BandOverlaysProps): React.ReactNode {
    return (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            {bands.filter((b) => b.enabled).map((band) => {
                const bx = freqToX(band.freq);
                const by = bandDotY(band);
                const leftPct = (bx / vbW) * 100;
                const topPct = (by / vbH) * 100;
                const isActive = dragEqBand === band.idx || selectedEqBand === band.idx;
                // UX tweak: points are 1.5x larger for easier grab/context-click.
                const DOT_SIZE = isActive ? 12 : 9;
                const bandColor = band.color || 'var(--color-accent-primary)';
                return (
                    <div
                        key={band.idx}
                        style={{
                            position: 'absolute',
                            left: `${leftPct}%`,
                            top: `${topPct}%`,
                            transform: 'translate(-50%, -50%)',
                            pointerEvents: 'auto',
                            cursor: 'grab',
                        }}
                        onMouseDown={(e) => {
                            if (e.button === 2) return;
                            e.preventDefault();
                            e.stopPropagation();
                            setSelectedEqBand(band.idx);
                            beginEqBandGesture(band.idx);
                            setDragEqBand(band.idx);
                        }}
                        onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setEqContextMenu({ x: e.clientX, y: e.clientY, bandIdx: band.idx });
                        }}
                        onDoubleClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onParamChange(`B${band.idx}En`, 0);
                        }}
                    >
                        {/* Invisible 24px hit zone for easier grabbing */}
                        <div style={{
                            position: 'absolute',
                            left: '50%',
                            top: '50%',
                            width: 24,
                            height: 24,
                            transform: 'translate(-50%, -50%)',
                            borderRadius: '50%',
                        }} />
                        {isActive && (
                            <div
                                style={{
                                    position: 'absolute',
                                    left: '50%',
                                    top: '50%',
                                    width: 21,
                                    height: 21,
                                    transform: 'translate(-50%, -50%)',
                                    borderRadius: '50%',
                                    background: `color-mix(in srgb, ${bandColor} 18%, transparent)`,
                                    border: `var(--space-px) solid color-mix(in srgb, ${bandColor} 50%, transparent)`,
                                }}
                            />
                        )}
                        <div
                            style={{
                                width: DOT_SIZE,
                                height: DOT_SIZE,
                                borderRadius: '50%',
                                background: bandColor,
                                boxShadow: isActive
                                    ? `0 0 8px color-mix(in srgb, ${bandColor} 60%, transparent)`
                                    : `0 0 4px color-mix(in srgb, ${bandColor} 30%, transparent)`,
                                transition: 'width 0.15s ease, height 0.15s ease, box-shadow 0.15s ease',
                            }}
                        />
                        {isActive && (
                            <div
                                style={{
                                    position: 'absolute',
                                    bottom: '100%',
                                    left: '50%',
                                    transform: 'translateX(-50%)',
                                    marginBottom: 4,
                                    color: bandColor,
                                    fontSize: 'var(--font-size-2xs)',
                                    fontWeight: 600,
                                    fontFamily: 'var(--font-role-body)',
                                    whiteSpace: 'nowrap',
                                }}
                            >
                                {EQ_FILTER_LABELS[band.filterType] ?? 'Bell'}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

type ContextMenuProps = {
    eqContextMenu: EqContextMenu | null;
    bands: EqBand8[];
    setEqBandFilterTypes: React.Dispatch<React.SetStateAction<string[]>>;
    onParamChange: (paramName: string, value: number) => void;
    setEqContextMenu: React.Dispatch<React.SetStateAction<EqContextMenu | null>>;
};

export function EqBandContextMenu({
    eqContextMenu,
    bands,
    setEqBandFilterTypes,
    onParamChange,
    setEqContextMenu,
}: ContextMenuProps): React.ReactNode {
    if (!eqContextMenu) return null;
    // BUG-64 FIX: Guard against out-of-bounds bandIdx.
    const activeBand = bands[eqContextMenu.bandIdx];
    if (!activeBand) return null;

    const MENU_HEIGHT = 220;
    const MENU_WIDTH = 140;
    const SAFE_MARGIN = 16;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const left = Math.max(
        SAFE_MARGIN,
        Math.min(eqContextMenu.x, viewportW - MENU_WIDTH - SAFE_MARGIN),
    );
    const top = Math.max(
        SAFE_MARGIN,
        Math.min(eqContextMenu.y, viewportH - MENU_HEIGHT - SAFE_MARGIN),
    );

    return createPortal(
        <div
            style={{
                position: 'fixed',
                left,
                top,
                zIndex: 'var(--z-plugin-overlay, 9999)',
                background: 'var(--color-bg-elevated)',
                border: 'var(--space-px) solid color-mix(in srgb, var(--color-text-primary) 16%, transparent)',
                borderRadius: 'var(--radius-sm)',
                padding: 'var(--space-1) 0',
                boxShadow: '0 var(--space-2) var(--space-8) var(--token-color-rgba-0-0-0-0d6)',
                minWidth: 120,
                maxHeight: `min(${MENU_HEIGHT}px, calc(100vh - ${SAFE_MARGIN * 2}px))`,
                overflowY: 'auto',
            }}
            onMouseDown={(e) => e.stopPropagation()}
            data-eq-context-menu
        >
            {Object.entries(EQ_FILTER_LABELS).map(([type, label]) => (
                <div
                    key={type}
                    style={{
                        padding: 'var(--token-size-px-5) var(--space-3-5)',
                        fontSize: 'var(--font-size-xs)',
                        color:
                            activeBand.filterType === type
                                ? 'var(--color-text-primary)'
                                : 'color-mix(in srgb, var(--color-text-primary) 72%, transparent)',
                        cursor: 'pointer',
                        fontWeight: activeBand.filterType === type ? 700 : 400,
                    }}
                    onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.background = 'color-mix(in srgb, var(--color-text-primary) 10%, transparent)';
                    }}
                    onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.background = 'transparent';
                    }}
                    onClick={() => {
                        setEqBandFilterTypes((prev) => {
                            const next = [...prev];
                            next[eqContextMenu.bandIdx] = type;
                            return next;
                        });
                        const typeValue = EQ_FILTER_TYPE_TO_INDEX[type] ?? DEFAULT_EQ_FILTER_TYPE_INDEX;
                        onParamChange(`B${eqContextMenu.bandIdx}Type`, typeValue);
                        setEqContextMenu(null);
                    }}
                >
                    {label}
                </div>
            ))}
        </div>,
        document.body,
    );
}
