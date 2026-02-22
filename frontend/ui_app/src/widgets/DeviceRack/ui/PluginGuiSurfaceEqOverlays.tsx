import React from 'react';
import {
    EQ_FILTER_ICONS,
    EQ_FILTER_LABELS,
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
                const iconPath = EQ_FILTER_ICONS[band.filterType] ?? EQ_FILTER_ICONS.peaking;
                const DOT_SIZE = 18;
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
                            e.stopPropagation();
                            onParamChange(`B${band.idx}En`, 0);
                        }}
                    >
                        {isActive && (
                            <div
                                style={{
                                    position: 'absolute',
                                    left: '50%',
                                    top: '50%',
                                    width: 32,
                                    height: 32,
                                    transform: 'translate(-50%, -50%)',
                                    borderRadius: '50%',
                                    border: `1px solid ${band.color}`,
                                    opacity: 0.5,
                                }}
                            />
                        )}
                        <div
                            style={{
                                width: DOT_SIZE,
                                height: DOT_SIZE,
                                borderRadius: '50%',
                                background: 'rgba(0,0,0,0.75)',
                                border: `2px solid ${band.color}`,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}
                        >
                            <svg width={12} height={12} viewBox="0 0 10 10" style={{ overflow: 'visible' }}>
                                <path
                                    d={iconPath}
                                    fill="none"
                                    stroke={band.color}
                                    strokeWidth="1.4"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                />
                            </svg>
                        </div>
                        {isActive && (
                            <div
                                style={{
                                    position: 'absolute',
                                    bottom: '100%',
                                    left: '50%',
                                    transform: 'translateX(-50%)',
                                    marginBottom: 4,
                                    color: band.color,
                                    fontSize: 10,
                                    fontWeight: 600,
                                    fontFamily: 'Inter, sans-serif',
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

    const MENU_HEIGHT = 200;
    const SAFE_MARGIN = 60;
    const flipUp = eqContextMenu.y + MENU_HEIGHT > window.innerHeight - SAFE_MARGIN;

    return (
        <div
            style={{
                position: 'fixed',
                left: eqContextMenu.x,
                ...(flipUp
                    ? { bottom: window.innerHeight - eqContextMenu.y }
                    : { top: eqContextMenu.y }),
                zIndex: 9999,
                background: 'var(--color-bg-elevated, #1e2128)',
                border: '1px solid rgba(90,178,255,0.2)',
                borderRadius: 6,
                padding: '4px 0',
                boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
                minWidth: 120,
            }}
            onMouseDown={(e) => e.stopPropagation()}
        >
            {Object.entries(EQ_FILTER_LABELS).map(([type, label]) => (
                <div
                    key={type}
                    style={{
                        padding: '5px 14px',
                        fontSize: 12,
                        color:
                            bands[eqContextMenu.bandIdx].filterType === type
                                ? '#5ab2ff'
                                : 'rgba(220,230,240,0.85)',
                        cursor: 'pointer',
                        fontWeight: bands[eqContextMenu.bandIdx].filterType === type ? 700 : 400,
                    }}
                    onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.background = 'rgba(90,178,255,0.12)';
                    }}
                    onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.background = 'transparent';
                    }}
                    onClick={() => {
                        const FILTER_TYPE_MAP: Record<string, number> = {
                            highpass: 0,
                            lowpass: 1,
                            lowshelf: 2,
                            highshelf: 3,
                            peaking: 4,
                            notch: 5,
                        };
                        setEqBandFilterTypes((prev) => {
                            const next = [...prev];
                            next[eqContextMenu.bandIdx] = type;
                            return next;
                        });
                        const typeValue = FILTER_TYPE_MAP[type] ?? 4;
                        onParamChange(`B${eqContextMenu.bandIdx}Type`, typeValue);
                        setEqContextMenu(null);
                    }}
                >
                    {label}
                </div>
            ))}
        </div>
    );
}
