import { useMemo } from 'react';
import * as engineApi from '@/shared/api/engine';
import { MeterStrip } from '@/shared/ui/MeterStrip';
import { DeviceNode } from '@/widgets/DeviceRack/ui/DeviceNode';
import { normalizePickedPath, errorMessage } from '@/widgets/DeviceRack/model/deviceRackCatalog';
import type { DeviceRackLogicOutput } from '@/widgets/DeviceRack/model/useDeviceRackLogic';
import type { DeviceSlot as DeviceSlotModel } from '@/widgets/DeviceRack/model/types';

export function DeviceSlot({
    device,
    deviceIndex,
    logic,
}: {
    device: DeviceSlotModel;
    deviceIndex: number;
    logic: DeviceRackLogicOutput;
}) {
    const { selectedTrack } = logic;
    // BUG-49 FIX: Memoize effectIds and effectIdSet to prevent recreation every render.
    const effectIds = useMemo(() =>
        (selectedTrack?.effects ?? [])
            .map((effect) => effect?.id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0),
        [selectedTrack?.effects],
    );
    const effectIdSet = useMemo(() => new Set(effectIds), [effectIds]);
    const canReorderThisDevice = effectIdSet.has(device.id);
    return (
        <div
            data-device-id={device.id}
            onDragOver={(e) => {
                const draggedId = e.dataTransfer.getData('application/x-dream-device-id')
                    || e.dataTransfer.getData('text/plain');
                if (!draggedId || !canReorderThisDevice || !effectIdSet.has(draggedId)) {
                    return;
                }
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const rect = e.currentTarget.getBoundingClientRect();
                const midX = rect.left + rect.width / 2;
                const isLeftHalf = e.clientX < midX;
                (e.currentTarget as HTMLElement).style.borderLeft = isLeftHalf ? 'var(--token-size-px-3) solid var(--color-accent-primary)' : '';
                (e.currentTarget as HTMLElement).style.borderRight = !isLeftHalf ? 'var(--token-size-px-3) solid var(--color-accent-primary)' : '';
            }}
            onDragLeave={(e) => {
                (e.currentTarget as HTMLElement).style.borderLeft = '';
                (e.currentTarget as HTMLElement).style.borderRight = '';
            }}
            onDrop={(e) => {
                e.preventDefault();
                (e.currentTarget as HTMLElement).style.borderLeft = '';
                (e.currentTarget as HTMLElement).style.borderRight = '';
                const draggedId = e.dataTransfer.getData('application/x-dream-device-id')
                    || e.dataTransfer.getData('text/plain');
                if (!draggedId || !selectedTrack) return;
                if (!canReorderThisDevice || !effectIdSet.has(draggedId)) return;

                const fromEffectIndex = effectIds.findIndex((id) => id === draggedId);
                const targetEffectIndex = effectIds.findIndex((id) => id === device.id);
                if (fromEffectIndex < 0 || targetEffectIndex < 0 || fromEffectIndex === targetEffectIndex) return;

                const rect = e.currentTarget.getBoundingClientRect();
                const midX = rect.left + rect.width / 2;
                const isLeftHalf = e.clientX < midX;
                let targetIdx = isLeftHalf ? targetEffectIndex : targetEffectIndex + 1;
                if (fromEffectIndex < targetIdx) targetIdx = Math.max(0, targetIdx - 1);
                targetIdx = Math.max(0, Math.min(targetIdx, effectIds.length - 1));

                void engineApi
                    .moveEffectSlotWithDeltas(selectedTrack.id, draggedId, targetIdx)
                    .then((response) => logic.applyProjectDeltas(response.deltas, 'device-rack:move-effect-slot'))
                    .catch((err) => console.error('[Dream] moveEffectSlot failed:', err));
            }}
            className="dream-device-drop-indicator"
            style={{ display: 'flex', flexShrink: 0, height: 'var(--rack-row-height, 100%)', transition: 'border 0.1s ease', position: 'relative' }}
        >
            <DeviceNode
                device={device}
                deviceIndex={deviceIndex}
                canReorder={canReorderThisDevice}
                isSelected={logic.selectedDeviceIds.includes(device.id)}
                editorSupported={logic.pluginCapability[device.id]?.supported ?? true}
                editorReason={logic.pluginCapability[device.id]?.reason}
                runtimeStatus={logic.pluginRuntimeBySlot[device.id]}
                onToggle={() => logic.toggleDevice(device)}
                onSelect={(e) => {
                    logic.selectDevice(device.id, e.shiftKey);
                    logic.rackRef.current?.focus();
                    logic.statusClear();
                }}
                onOpenSettings={() => {
                    logic.selectDevice(device.id, false);
                    logic.setInlineSettingsOpen((prev) => ({ ...prev, [device.id]: !prev[device.id] }));
                    logic.statusClear();
                }}
                onParamChange={(name, value) => {
                    const canonicalName = device.params.find((p) => p.name.toLowerCase() === name.toLowerCase())?.name ?? name;
                    logic.setPluginParam(device.id, canonicalName, value);
                    const gestureKey = selectedTrack ? `${selectedTrack.id}:${device.id}:${canonicalName.toLowerCase()}` : null;
                    logic.sendInternalParam(device, canonicalName, value, {
                        gestureKey: gestureKey && logic.activeParamGesturesRef.current.has(gestureKey) ? gestureKey : undefined,
                    });
                }}
                onParamGestureStart={(paramName, gestureGroupId) => {
                    const canonicalName = device.params.find((p) => p.name.toLowerCase() === paramName.toLowerCase())?.name ?? paramName;
                    logic.beginParamGesture(device.id, canonicalName, gestureGroupId);
                }}
                onParamGestureEnd={(paramName) => {
                    const canonicalName = device.params.find((p) => p.name.toLowerCase() === paramName.toLowerCase())?.name ?? paramName;
                    logic.endParamGesture(device.id, canonicalName);
                }}
                onApplyQuickPreset={(preset) => logic.applyQuickPreset(device, preset)}
                onRandomize={() => logic.randomizeInternalPluginParams(device)}
                onReset={() => logic.resetInternalPluginParams(device)}
                onStoreSnapshot={(slot) => logic.storeParamSnapshot(device, slot)}
                onRecallSnapshot={(slot) => logic.recallParamSnapshot(device, slot)}
                onToggleSnapshot={() => logic.toggleParamSnapshot(device)}
                snapshotState={logic.paramSnapshotsByDevice[device.id]}
                onApplyUtilityScene={(scene) => logic.applyQuickUtilityScene(device, scene)}
                onParamContextMenu={(e, paramName) => logic.handleParamContextMenu(e, paramName, device.id)}
                showSettings={!!logic.inlineSettingsOpen[device.id]}
                sidechainSourceTrackId={device.sidechainSourceTrackId ?? 'none'}
                sidechainOptions={logic.sidechainOptions}
                onSidechainSourceChange={(sourceTrackId) => {
                    void logic.setPluginSidechainSource(device.id, sourceTrackId);
                }}
                onEnsureActive={async () => {
                    await logic.ensureSlotRuntimeActive(device.id);
                }}
                onDropSample={async (samplePath) => {
                    if (!selectedTrack) return;
                    try {
                        const normalizedPath = normalizePickedPath(samplePath);
                        if (!normalizedPath) {
                            logic.statusError('Failed to load sampler sample: invalid file path.');
                            return;
                        }
                        logic.selectDevice(device.id, false);
                        logic.statusClear();
                        const response = await engineApi.setSamplerSampleWithDeltas(selectedTrack.id, normalizedPath);
                        await logic.applyProjectDeltas(response.deltas, 'device-rack:set-sampler-sample-drop');
                    } catch (err) {
                        console.error('[Dream] sampler device drop failed:', err);
                        logic.statusError(`Failed to load sampler sample: ${errorMessage(err)}`);
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
                        if (!normalizedPath) return;
                        const response = await engineApi.setSamplerSampleWithDeltas(selectedTrack.id, normalizedPath);
                        await logic.applyProjectDeltas(response.deltas, 'device-rack:set-sampler-sample-dialog');
                        logic.statusClear();
                    } catch (err) {
                        console.error('[Dream] setSamplerSample failed:', err);
                        logic.statusError(`Failed to load sampler sample: ${errorMessage(err)}`);
                    }
                }}
                isNativeEditorOpen={!!(selectedTrack && logic.openEditorsByTrack[selectedTrack.id]?.has(device.id))}
                onOpenGUI={async () => {
                    logic.selectDevice(device.id, false);
                    if (!selectedTrack) return;
                    try {
                        if (device.pluginId === 'internal://instrument/flow') {
                            const { useFlowSynthStore } = await import('@/widgets/FlowSynth/model/useFlowSynthStore');
                            useFlowSynthStore.getState().openFlowEditor(device.id, selectedTrack.id);
                        } else if (device.source !== 'internal') {
                            await logic.ensureSlotRuntimeActive(device.id);
                            await logic.togglePluginEditor(selectedTrack.id, device.id);
                        } else {
                            logic.setInlineSettingsOpen((prev) => ({ ...prev, [device.id]: !prev[device.id] }));
                        }
                        logic.statusClear();
                    } catch (err) {
                        console.error('[Dream] togglePluginEditor failed:', err);
                        logic.statusError(`Failed to open native plugin UI: ${errorMessage(err)}`);
                    }
                }}
            />
            <MeterStrip
                levelL={device.isEnabled ? logic.outLevelL : 0}
                levelR={device.isEnabled ? logic.outLevelR : 0}
                style={{ marginLeft: 'var(--space-1-5)' }}
            />
        </div>
    );
}

export function EmptyState() {
    return (
        <div
            style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 'var(--space-2)',
                minHeight: 80,
                color: 'var(--color-text-tertiary)',
            }}
        >
            <span style={{ fontSize: 'var(--font-size-2xl)', opacity: 0.3 }}>♪</span>
            <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 500, letterSpacing: '0.03em' }}>
                Drop Files and Devices Here
            </span>
        </div>
    );
}
