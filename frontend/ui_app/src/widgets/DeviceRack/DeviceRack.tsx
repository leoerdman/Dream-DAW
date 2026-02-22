import { useCallback } from 'react';
import * as engineApi from '@/shared/api/engineApi';
import type { DeviceSlot, QuickPreset } from './model/types';
import { useDeviceRackLogic } from './model/useDeviceRackLogic';
import { DeviceNode } from './ui/DeviceNode';
import { MeterStrip } from '../MeterStrip';
import { linearToMeterNorm } from '@/shared/lib/meterUtils';
import { normalizePickedPath, errorMessage } from '@/shared/lib/helpers';
import type { BrowserDragItem } from '@/shared/lib/arrangementTypes';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';

/**
 * DeviceRack — Bottom panel: instrument & effects signal chain.
 *
 * Each track has its own Instrument & Effects chain (currently empty until
 * the user drops a plugin from the browser).
 *
 * Architecture:
 *   • useDeviceRackLogic()  — all state, effects, and callbacks (~680 LOC)
 *   • DeviceRack (this file) — pure JSX rendering (~450 LOC)
 */

const autoCtxMenuItemStyle: React.CSSProperties = {
    display: 'block',
    width: '100%',
    padding: '5px 8px',
    border: 'none',
    background: 'transparent',
    color: 'var(--color-text-primary)',
    fontSize: 'var(--font-size-sm)',
    fontWeight: 500,
    textAlign: 'left',
    cursor: 'pointer',
    borderRadius: 'var(--radius-sm)',
    transition: 'background var(--transition-fast)',
};

// ── Component ──────────────────────────────────────────

interface DeviceRackProps {
    selectedTrackId: string;
    onDropPluginToTrack?: (item: BrowserDragItem, trackId: string) => Promise<void>;
}

export const DeviceRack = ({
    selectedTrackId,
    onDropPluginToTrack,
}: DeviceRackProps) => {
    const logic = useDeviceRackLogic(selectedTrackId, onDropPluginToTrack);

    const {
        chain,
        selectedTrack,
        selectedDeviceIds,
        pluginCapability,
        pluginRuntimeBySlot,
        inlineSettingsOpen,
        inLevelL,
        inLevelR,
        isDropActive,
        draggingItem,
        sidechainOptions,
        paramSnapshotsByDevice,
        openEditorsByTrack,
        autoCtxMenu,
        automationLanes,
        rackRef,
        activeParamGesturesRef,
        toggleDevice,
        selectDevice,
        setPluginParam,
        sendInternalParam,
        beginParamGesture,
        endParamGesture,
        applyQuickPreset,
        randomizeInternalPluginParams,
        resetInternalPluginParams,
        storeParamSnapshot,
        recallParamSnapshot,
        toggleParamSnapshot,
        applyQuickUtilityScene,
        ensureSlotRuntimeActive,
        setPluginSidechainSource,
        handleParamContextMenu,
        setAutoCtxMenu,
        setInlineSettingsOpen,
        addAutomationLane,
        removeAutomationLane,
        toggleGlobalAutomation,
        statusClear,
        statusError,
        fetchProject,
        togglePluginEditor,
    } = logic;

    const visibleChain = chain;

    const rackContent = (
        <>
            <div
                ref={rackRef}
                tabIndex={0}
                data-keyboard-scope="device-rack"
                data-selected-device-id={selectedDeviceIds[0] ?? ''}
                onMouseDown={() => rackRef.current?.focus()}
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    height: '100%',
                    background: 'var(--color-bg-panel)',
                    position: 'relative',
                    outline: isDropActive ? '2px solid var(--color-accent-primary)' : 'none',
                    boxShadow: isDropActive ? 'inset 0 0 0 1px color-mix(in srgb, var(--color-accent-primary) 35%, transparent)' : 'none',
                }}>

                {/* ── Device Chain (horizontal scroll) ── */}
                <div className="scrollbar-hide" onClick={(e) => {
                    if (e.target === e.currentTarget) selectDevice('', false);
                }} style={{
                    display: 'flex',
                    alignItems: 'stretch',
                    gap: 6,
                    padding: '10px',
                    flex: 1,
                    minHeight: 0,
                    overflowX: 'auto',
                    overflowY: 'hidden',
                }}>

                    {/* Input meter — real data */}
                    <MeterStrip levelL={inLevelL} levelR={inLevelR} isMidi={selectedTrack?.track_type === 'Midi'} />

                    {/* Device slots — drag to reorder */}
                    {visibleChain.length > 0 ? (
                        visibleChain.map((device, deviceIndex) => (
                            <div
                                key={device.id}
                                onDragOver={(e) => {
                                    e.preventDefault();
                                    e.dataTransfer.dropEffect = 'move';
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const midX = rect.left + rect.width / 2;
                                    const isLeftHalf = e.clientX < midX;
                                    (e.currentTarget as HTMLElement).style.borderLeft = isLeftHalf ? '3px solid #5ab2ff' : '';
                                    (e.currentTarget as HTMLElement).style.borderRight = !isLeftHalf ? '3px solid #5ab2ff' : '';
                                }}
                                onDragLeave={(e) => {
                                    (e.currentTarget as HTMLElement).style.borderLeft = '';
                                    (e.currentTarget as HTMLElement).style.borderRight = '';
                                }}
                                onDrop={(e) => {
                                    e.preventDefault();
                                    (e.currentTarget as HTMLElement).style.borderLeft = '';
                                    (e.currentTarget as HTMLElement).style.borderRight = '';
                                    const draggedId = e.dataTransfer.getData('application/x-dream-device-id');
                                    const fromIndex = parseInt(e.dataTransfer.getData('application/x-dream-device-index'), 10);
                                    if (!draggedId || isNaN(fromIndex) || fromIndex === deviceIndex) return;
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const midX = rect.left + rect.width / 2;
                                    const isLeftHalf = e.clientX < midX;
                                    let targetIdx = isLeftHalf ? deviceIndex : deviceIndex + 1;
                                    if (fromIndex < targetIdx) targetIdx = Math.max(0, targetIdx - 1);
                                    if (selectedTrack) {
                                        void engineApi.moveEffectSlot(selectedTrack.id, draggedId, targetIdx)
                                            .then(() => fetchProject())
                                            .catch((err) => console.error('[DeviceRack] moveEffectSlot failed:', err));
                                    }
                                }}
                                className="dream-device-drop-indicator"
                                style={{ display: 'flex', flexShrink: 0, height: '100%', transition: 'border 0.1s ease', position: 'relative' }}
                            >
                                <DeviceNode
                                    device={device}
                                    deviceIndex={deviceIndex}
                                    isSelected={selectedDeviceIds.includes(device.id)}
                                    editorSupported={pluginCapability[device.id]?.supported ?? true}
                                    editorReason={pluginCapability[device.id]?.reason}
                                    runtimeStatus={pluginRuntimeBySlot[device.id]}
                                    onToggle={() => toggleDevice(device)}
                                    onSelect={(e) => {
                                        selectDevice(device.id, e.shiftKey);
                                        rackRef.current?.focus();
                                        statusClear();
                                    }}
                                    onOpenSettings={() => {
                                        if (device.source === 'internal' && device.effectType === 'utility') {
                                            selectDevice(device.id, false);
                                            statusClear();
                                            return;
                                        }
                                        selectDevice(device.id, false);
                                        setInlineSettingsOpen((prev) => ({
                                            ...prev,
                                            [device.id]: !prev[device.id],
                                        }));
                                        statusClear();
                                    }}
                                    onParamChange={(name, value) => {
                                        setPluginParam(device.id, name, value);
                                        const gestureKey = selectedTrack
                                            ? `${selectedTrack.id}:${device.id}:${name.toLowerCase()}`
                                            : null;
                                        sendInternalParam(device, name, value, {
                                            gestureKey: gestureKey && activeParamGesturesRef.current.has(gestureKey)
                                                ? gestureKey
                                                : undefined,
                                        });
                                    }}
                                    onParamGestureStart={(paramName) => beginParamGesture(device.id, paramName)}
                                    onParamGestureEnd={(paramName) => endParamGesture(device.id, paramName)}
                                    onApplyQuickPreset={(preset) => applyQuickPreset(device, preset)}
                                    onRandomize={() => randomizeInternalPluginParams(device)}
                                    onReset={() => resetInternalPluginParams(device)}
                                    onStoreSnapshot={(slot) => storeParamSnapshot(device, slot)}
                                    onRecallSnapshot={(slot) => recallParamSnapshot(device, slot)}
                                    onToggleSnapshot={() => toggleParamSnapshot(device)}
                                    snapshotState={paramSnapshotsByDevice[device.id]}
                                    onApplyUtilityScene={(scene) => applyQuickUtilityScene(device, scene)}
                                    onParamContextMenu={(e, paramName) => handleParamContextMenu(e, paramName, device.id)}
                                    showSettings={device.effectType === 'utility' ? false : !!inlineSettingsOpen[device.id]}
                                    sidechainSourceTrackId={device.sidechainSourceTrackId ?? 'none'}
                                    sidechainOptions={sidechainOptions}
                                    onSidechainSourceChange={(sourceTrackId) => {
                                        void setPluginSidechainSource(device.id, sourceTrackId);
                                    }}
                                    onEnsureActive={async () => {
                                        await ensureSlotRuntimeActive(device.id);
                                    }}
                                    onDropSample={async (samplePath) => {
                                        if (!selectedTrack) return;
                                        try {
                                            const normalizedPath = normalizePickedPath(samplePath);
                                            if (!normalizedPath) {
                                                statusError('Failed to load sampler sample: invalid file path.');
                                                return;
                                            }
                                            await engineApi.setSamplerSample(selectedTrack.id, normalizedPath);
                                            selectDevice(device.id, false);
                                            statusClear();
                                            await fetchProject();
                                        } catch (err) {
                                            console.error('[DeviceRack] sampler device drop failed:', err);
                                            statusError(`Failed to load sampler sample: ${errorMessage(err)}`);
                                        }
                                    }}
                                    onLoadSample={async () => {
                                        if (!selectedTrack) return;
                                        try {
                                            const { open } = await import('@tauri-apps/plugin-dialog');
                                            const picked = await open({
                                                multiple: false,
                                                title: 'Load Sampler Sample',
                                                filters: [{ name: 'Audio', extensions: ['wav', 'aif', 'aiff', 'flac', 'mp3', 'ogg', 'm4a', 'aac'] }],
                                            });
                                            const normalizedPath = normalizePickedPath(picked);
                                            if (normalizedPath) {
                                                await engineApi.setSamplerSample(selectedTrack.id, normalizedPath);
                                                statusClear();
                                                await fetchProject();
                                            }
                                        } catch (err) {
                                            console.error('[DeviceRack] setSamplerSample failed:', err);
                                            statusError(`Failed to load sampler sample: ${errorMessage(err)}`);
                                        }
                                    }}
                                    isNativeEditorOpen={!!(selectedTrack && openEditorsByTrack[selectedTrack.id]?.has(device.id))}
                                    onOpenGUI={async () => {
                                        console.log('[DeviceRack] onOpenGUI clicked device:', device.id, 'name:', device.name, 'source:', device.source, 'pluginId:', device.pluginId);
                                        selectDevice(device.id, false);
                                        if (!selectedTrack) {
                                            console.warn('[DeviceRack] onOpenGUI: no selectedTrack, aborting');
                                            return;
                                        }
                                        const trackId = selectedTrack.id;
                                        try {
                                            if (device.source !== 'internal') {
                                                await ensureSlotRuntimeActive(device.id);
                                                await togglePluginEditor(trackId, device.id);
                                            } else {
                                                setInlineSettingsOpen((prev) => ({
                                                    ...prev,
                                                    [device.id]: !prev[device.id],
                                                }));
                                            }
                                            statusClear();
                                        } catch (err) {
                                            console.error('[DeviceRack] togglePluginEditor failed:', err);
                                            statusError(`Failed to open native plugin UI: ${errorMessage(err)}`);
                                        }
                                    }}
                                />
                                <MeterStrip levelL={linearToMeterNorm(device.vuLevelL ?? device.vuLevel)} levelR={linearToMeterNorm(device.vuLevelR ?? device.vuLevel)} />
                            </div>
                        ))
                    ) : (
                        /* ── Empty State ── */
                        <div style={{
                            flex: 1,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 8,
                            minHeight: 80,
                            color: 'var(--color-text-tertiary)',
                        }}>
                            <span style={{
                                fontSize: 'var(--font-size-2xl)',
                                opacity: 0.3,
                            }}>♪</span>
                            <span style={{
                                fontSize: 'var(--font-size-xs)',
                                fontWeight: 500,
                                letterSpacing: '0.03em',
                            }}>
                                Drop Files and Devices Here
                            </span>
                        </div>
                    )}

                    {/* Add device button */}
                    <button
                        onClick={() => {
                            window.dispatchEvent(new CustomEvent('dream:browser-set-search', {
                                detail: { categoryId: 'plugins', query: '' },
                            }));
                            statusClear();
                        }}
                        style={{
                            width: 64,
                            minWidth: 64,
                            height: '100%',
                            minHeight: 100,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 6,
                            background: 'transparent',
                            border: '1px dashed var(--color-border-subtle)',
                            borderRadius: 'var(--radius-sm)',
                            cursor: 'pointer',
                            color: 'var(--color-text-tertiary)',
                            fontSize: 'var(--font-size-2xs)',
                            fontWeight: 500,
                            flexShrink: 0,
                            transition: 'all var(--transition-fast)',
                        }}
                        onMouseEnter={e => {
                            e.currentTarget.style.borderColor = 'var(--color-accent-primary)';
                            e.currentTarget.style.color = 'var(--color-accent-primary)';
                        }}
                        onMouseLeave={e => {
                            e.currentTarget.style.borderColor = 'var(--color-border-subtle)';
                            e.currentTarget.style.color = 'var(--color-text-tertiary)';
                        }}
                    >
                        <span style={{ fontSize: 'var(--font-size-2xl)', lineHeight: 1 }}>+</span>
                        Add Device
                    </button>
                </div>

                {isDropActive && draggingItem?.type === 'plugin' && (
                    <div
                        style={{
                            position: 'absolute',
                            right: 10,
                            top: 10,
                            zIndex: 'var(--z-header)' as unknown as number,
                            border: '1px solid color-mix(in srgb, var(--color-accent-primary) 65%, #ffffff22)',
                            borderRadius: 'var(--radius-lg)',
                            padding: '5px 8px',
                            background: 'color-mix(in srgb, var(--color-bg-panel) 72%, var(--color-accent-primary) 28%)',
                            color: 'var(--color-text-primary)',
                            fontSize: 'var(--font-size-xs)',
                            fontWeight: 'var(--font-weight-bold)' as unknown as number,
                            letterSpacing: '0.03em',
                            pointerEvents: 'none',
                            textTransform: 'uppercase',
                        }}
                    >
                        Drop Plugin: {draggingItem.name}
                    </div>
                )}

            </div>
        </>
    );

    // ── Automation context menu popup ──
    const renderCtxMenuPopup = () => {
        if (!autoCtxMenu) return null;
        const existingLane = Object.values(automationLanes).find(
            (l) =>
                l.trackId === selectedTrackId &&
                l.paramKey === `${autoCtxMenu.deviceId}:${autoCtxMenu.paramName}`,
        );

        return (
            <div
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                    position: 'fixed',
                    left: autoCtxMenu.x,
                    top: autoCtxMenu.y,
                    zIndex: 'var(--z-menu)' as unknown as number,
                    background: 'var(--color-bg-elevated)',
                    border: '1px solid var(--color-divider)',
                    borderRadius: 'var(--radius-sm)',
                    padding: 4,
                    minWidth: 200,
                    boxShadow: '0 8px 24px var(--color-overlay-dark)',
                }}
            >
                <div
                    style={{
                        fontSize: 'var(--font-size-xs)',
                        color: 'var(--color-text-tertiary)',
                        padding: '4px 8px',
                        fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                    }}
                >
                    Automation: {autoCtxMenu.paramName}
                </div>
                {existingLane ? (
                    <button
                        onClick={() => {
                            removeAutomationLane(existingLane.id);
                            setAutoCtxMenu(null);
                        }}
                        style={autoCtxMenuItemStyle}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'var(--color-bg-hover)';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent';
                        }}
                    >
                        ✕ Remove Automation Lane
                    </button>
                ) : (
                    <button
                        onClick={() => {
                            addAutomationLane(
                                selectedTrackId,
                                autoCtxMenu.paramName,
                                `${autoCtxMenu.deviceId}:${autoCtxMenu.paramName}`,
                            );
                            if (!useAutomationStore.getState().globalVisible) {
                                toggleGlobalAutomation();
                            }
                            setAutoCtxMenu(null);
                        }}
                        style={autoCtxMenuItemStyle}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'var(--color-bg-hover)';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent';
                        }}
                    >
                        ⊕ Add Automation Lane
                    </button>
                )}
            </div>
        );
    };

    return (
        <>
            {rackContent}
            {renderCtxMenuPopup()}
        </>
    );
};
