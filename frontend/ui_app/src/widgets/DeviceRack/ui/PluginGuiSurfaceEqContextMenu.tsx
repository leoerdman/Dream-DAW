import React from 'react';
import { EQ_FILTER_LABELS, EQ_FILTER_TYPE_TO_INDEX, type EqBand8 } from '@/widgets/DeviceRack/lib/eqMath';

type EqContextMenu = { x: number; y: number; bandIdx: number };

type Props = {
    eqContextMenu: EqContextMenu;
    bands: EqBand8[];
    setEqBandFilterTypes: React.Dispatch<React.SetStateAction<string[]>>;
    setEqContextMenu: React.Dispatch<React.SetStateAction<EqContextMenu | null>>;
    onParamChange: (paramName: string, value: number) => void;
};

export function PluginGuiSurfaceEqContextMenu({
    eqContextMenu,
    bands,
    setEqBandFilterTypes,
    setEqContextMenu,
    onParamChange,
}: Props): React.ReactNode {
    const MENU_HEIGHT = 200;
    const SAFE_MARGIN = 60;
    const flipUp = eqContextMenu.y + MENU_HEIGHT > window.innerHeight - SAFE_MARGIN;
    return (
        <div
            style={{
                position: 'fixed',
                left: eqContextMenu.x,
                ...(flipUp ? { bottom: window.innerHeight - eqContextMenu.y } : { top: eqContextMenu.y }),
                zIndex: 9999,
                background: 'var(--color-bg-elevated)',
                border: 'var(--space-px) solid color-mix(in srgb, var(--color-text-primary) 16%, transparent)',
                borderRadius: 6,
                padding: 'var(--space-1) 0',
                boxShadow: '0 var(--space-2) var(--space-8) var(--token-color-rgba-0-0-0-0d6)',
                minWidth: 120,
            }}
            onMouseDown={(e) => e.stopPropagation()}
        >
            {Object.entries(EQ_FILTER_LABELS).map(([type, label]) => (
                <div
                    key={type}
                    style={{
                        padding: 'var(--token-size-px-5) var(--space-3-5)',
                        fontSize: 12,
                        color: bands[eqContextMenu.bandIdx].filterType === type
                            ? 'var(--color-text-primary)'
                            : 'color-mix(in srgb, var(--color-text-primary) 72%, transparent)',
                        cursor: 'pointer',
                        fontWeight: bands[eqContextMenu.bandIdx].filterType === type ? 700 : 400,
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'color-mix(in srgb, var(--color-text-primary) 10%, transparent)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                    onClick={() => {
                        setEqBandFilterTypes((prev) => {
                            const next = [...prev];
                            next[eqContextMenu.bandIdx] = type;
                            return next;
                        });
                        onParamChange(`B${eqContextMenu.bandIdx}Type`, EQ_FILTER_TYPE_TO_INDEX[type] ?? 4);
                        setEqContextMenu(null);
                    }}
                >
                    {label}
                </div>
            ))}
        </div>
    );
}
