import { useEffect, useRef, useState } from 'react';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { getExternalPluginParamsForSlot } from '@/shared/api/engine';
import type { TrackInspectorLogicState } from '@/widgets/TrackInspector/model/useTrackInspectorLogic';
import type { ExternalPluginParamInfo } from '@/shared/api/engine';

interface TrackAutomationParameterDropdownProps {
    logic: TrackInspectorLogicState;
}

interface GroupedParams {
    slotName: string;
    params: { name: string; key: string }[];
}

export function TrackAutomationParameterDropdown({ logic }: TrackAutomationParameterDropdownProps) {
    const { paramSelectorCtxMenu, setParamSelectorCtxMenu } = logic;
    const menuRef = useRef<HTMLDivElement>(null);
    const [coords, setCoords] = useState<{ x: number; y: number; opacity: number; pointerEvents: 'none' | 'auto' }>({
        x: -9999,
        y: -9999,
        opacity: 0,
        pointerEvents: 'none',
    });

    const [groupedParams, setGroupedParams] = useState<GroupedParams[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!paramSelectorCtxMenu) {
            setCoords({ x: -9999, y: -9999, opacity: 0, pointerEvents: 'none' });
            return;
        }

        let cancelled = false;
        const fetchParams = async () => {
            setLoading(true);
            try {
                const track = useEngineStore.getState().tracks.byId[paramSelectorCtxMenu.trackId];
                if (!track || cancelled) return;

                const groups: GroupedParams[] = [];
                // Add fixed track parameters
                groups.push({
                    slotName: 'Track',
                    params: [
                        { name: 'Volume', key: 'volume' },
                        { name: 'Pan', key: 'pan' },
                        { name: 'Send A', key: 'send.a' },
                        { name: 'Send B', key: 'send.b' },
                    ],
                });

                // Collect all slots (instrument + effects)
                const allSlots = [
                    ...(track.instrument ? [track.instrument] : []),
                    ...track.effects,
                ];

                // Add plugin parameters
                for (const slot of allSlots) {
                    if (cancelled) return;
                    try {
                        const params: ExternalPluginParamInfo[] = await getExternalPluginParamsForSlot(track.id, slot.id);
                        if (cancelled) return;
                        if (params && params.length > 0) {
                            groups.push({
                                slotName: slot.name || 'Plugin',
                                params: params.map((p) => ({
                                    name: p.name,
                                    key: `${slot.id}:${p.index}`,
                                })),
                            });
                        }
                    } catch (e) {
                        console.error(`[Dream] Failed to fetch params for slot ${slot.id}`, e);
                    }
                }
                if (!cancelled) setGroupedParams(groups);
            } finally {
                setLoading(false);
            }
        };

        void fetchParams();

        const measureId = requestAnimationFrame(() => {
            if (!menuRef.current) return;
            const rect = menuRef.current.getBoundingClientRect();
            const margin = 8;
            const finalX = Math.max(margin, Math.min(paramSelectorCtxMenu.x, window.innerWidth - rect.width - margin));
            const finalY = Math.max(margin, Math.min(paramSelectorCtxMenu.y, window.innerHeight - rect.height - margin));
            setCoords({ x: finalX, y: finalY, opacity: 1, pointerEvents: 'auto' });
        });

        const handleClick = (e: PointerEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setParamSelectorCtxMenu(null);
            }
        };

        const timerId = setTimeout(() => {
            document.addEventListener('pointerdown', handleClick);
        }, 10);

        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setParamSelectorCtxMenu(null);
        };
        document.addEventListener('keydown', handleKey);

        return () => {
            cancelled = true;
            cancelAnimationFrame(measureId);
            clearTimeout(timerId);
            document.removeEventListener('pointerdown', handleClick);
            document.removeEventListener('keydown', handleKey);
        };
    }, [paramSelectorCtxMenu, setParamSelectorCtxMenu]);

    if (!paramSelectorCtxMenu) return null;

    return (
        <div
            ref={menuRef}
            onPointerDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
            style={{
                position: 'fixed',
                left: coords.x,
                top: coords.y,
                opacity: coords.opacity,
                pointerEvents: coords.pointerEvents,
                zIndex: 'var(--z-menu)',
                background: 'color-mix(in srgb, var(--color-bg-elevated) 98%, transparent)',
                backdropFilter: 'blur(16px)',
                WebkitBackdropFilter: 'blur(16px)',
                border: 'var(--space-px) solid color-mix(in srgb, var(--token-color-rgba-255-255-255-0d2) 100%, transparent)',
                borderRadius: 'var(--radius-lg)',
                padding: 'var(--space-1-5)',
                minWidth: 260,
                maxHeight: 400,
                overflowY: 'auto',
                boxShadow: '0 var(--space-4) var(--space-8) var(--color-overlay-dark), 0 0 0 var(--space-px) var(--token-color-rgba-0-0-0-0d5)',
                transition: 'opacity 0.1s ease',
            }}
            className="scrollbar-hide"
        >
            {loading ? (
                <div style={{ padding: 12, color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-md)', textAlign: 'center' }}>
                    Loading parameters...
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {groupedParams.map((group) => (
                        <div key={group.slotName} style={{ display: 'flex', flexDirection: 'column' }}>
                            <div
                                style={{
                                    fontSize: 'var(--font-size-xs)',
                                    color: 'var(--color-text-secondary)',
                                    padding: '4px 8px',
                                    fontWeight: 'var(--font-weight-semibold)',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.04em',
                                    borderBottom: '1px solid var(--color-divider)',
                                    marginBottom: 4,
                                }}
                            >
                                {group.slotName}
                            </div>
                            {group.params.map((param) => (
                                <button
                                    key={param.key}
                                    onClick={async () => {
                                        // BUG-FIX: Sync parameter change to audio engine.
                                        // 1. Read old state before mutation
                                        const store = useAutomationStore.getState();
                                        const lane = store.lanes[paramSelectorCtxMenu.laneId];
                                        const oldParamKey = lane?.paramKey;
                                        const trackId = lane?.trackId ?? paramSelectorCtxMenu.trackId;

                                        // 2. Update the lane's parameter in the store
                                        useAutomationStore.getState().setLaneParameter(paramSelectorCtxMenu.laneId, param.name, param.key);

                                        // 3. Clear old parameter's automation on engine
                                        if (oldParamKey && oldParamKey !== param.key) {
                                            try {
                                                const { setAutomationPointsWithDeltas } = await import('@/shared/api/engine');
                                                const { applyProjectDeltas } = useEngineStore.getState();
                                                const clearResponse = await setAutomationPointsWithDeltas(trackId, oldParamKey, []);
                                                applyProjectDeltas(clearResponse.deltas, 'automation:param-switch-clear');
                                            } catch (err) {
                                                console.error('[Dream] Failed to clear old automation param:', err);
                                                useStatusStore.getState().setError(`Automation clear failed: ${err instanceof Error ? err.message : String(err)}`);
                                            }
                                        }

                                        // 4. Push existing breakpoints to new param key on engine
                                        try {
                                            const { setAutomationPointsWithDeltas } = await import('@/shared/api/engine');
                                            const { applyProjectDeltas } = useEngineStore.getState();
                                            const updatedLane = useAutomationStore.getState().lanes[paramSelectorCtxMenu.laneId];
                                            const enginePoints = (updatedLane?.breakpoints ?? []).map((bp) => ({
                                                beat: bp.beat,
                                                value: bp.value,
                                                curveType: bp.curve === 'step' ? 'step' as const : bp.curve === 'bezier' ? 'bezier' as const : 'linear' as const,
                                                tension: bp.curve === 'bezier' ? (bp.tension ?? 0.5) : undefined,
                                            }));
                                            const pushResponse = await setAutomationPointsWithDeltas(trackId, param.key, enginePoints);
                                            applyProjectDeltas(pushResponse.deltas, 'automation:param-switch-push');
                                        } catch (err) {
                                            console.error('[Dream] Failed to push automation to new param:', err);
                                            useStatusStore.getState().setError(`Automation push failed: ${err instanceof Error ? err.message : String(err)}`);
                                        }

                                        setParamSelectorCtxMenu(null);
                                    }}
                                    style={{
                                        display: 'block',
                                        width: '100%',
                                        padding: '6px 16px',
                                        border: 'none',
                                        background: 'transparent',
                                        color: 'var(--color-text-primary)',
                                        fontSize: 'var(--font-size-sm)',
                                        textAlign: 'left',
                                        cursor: 'pointer',
                                        borderRadius: 'var(--radius-sm)',
                                    }}
                                    onMouseEnter={(e) => {
                                        e.currentTarget.style.background = 'var(--color-bg-hover)';
                                    }}
                                    onMouseLeave={(e) => {
                                        e.currentTarget.style.background = 'transparent';
                                    }}
                                >
                                    {param.name}
                                </button>
                            ))}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
