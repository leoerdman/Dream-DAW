import * as engineApi from '@/shared/api/engine';
import { MeterStrip } from '@/shared/ui/MeterStrip';
import { DeviceNode } from '@/widgets/DeviceRack/ui/DeviceNode';
import { linearToMeterNorm } from '@/shared/lib/meterManifest';
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
    return (
        <div
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
                if (!draggedId || Number.isNaN(fromIndex) || fromIndex === deviceIndex || !selectedTrack) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const midX = rect.left + rect.width / 2;
                const isLeftHalf = e.clientX < midX;
                let targetIdx = isLeftHalf ? deviceIndex : deviceIndex + 1;
                if (fromIndex < targetIdx) targetIdx = Math.max(0, targetIdx - 1);
                void engineApi
                    .moveEffectSlotWithDeltas(selectedTrack.id, draggedId, targetIdx)
                    .then((response) => logic.applyProjectDeltas(response.deltas, 'device-rack:move-effect-slot'))
                    .catch((err) => console.error('[DeviceRack] moveEffectSlot failed:', err));
            }}
            className="dream-device-drop-indicator"
            style={{ display: 'flex', flexShrink: 0, height: '100%', transition: 'border 0.1s ease', position: 'relative' }}
        >
            <DeviceNode
                device={device}
                deviceIndex={deviceIndex}
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
                    if (device.source === 'internal' && device.effectType === 'utility') {
                        logic.selectDevice(device.id, false);
                        logic.statusClear();
                        return;
                    }
                    logic.selectDevice(device.id, false);
                    logic.setInlineSettingsOpen((prev) => ({ ...prev, [device.id]: !prev[device.id] }));
                    logic.statusClear();
                }}
                onParamChange={(name, value) => {
                    logic.setPluginParam(device.id, name, value);
                    const gestureKey = selectedTrack ? `${selectedTrack.id}:${device.id}:${name.toLowerCase()}` : null;
                    logic.sendInternalParam(device, name, value, {
                        gestureKey: gestureKey && logic.activeParamGesturesRef.current.has(gestureKey) ? gestureKey : undefined,
                    });
                }}
                onParamGestureStart={(paramName) => logic.beginParamGesture(device.id, paramName)}
                onParamGestureEnd={(paramName) => logic.endParamGesture(device.id, paramName)}
                onApplyQuickPreset={(preset) => logic.applyQuickPreset(device, preset)}
                onRandomize={() => logic.randomizeInternalPluginParams(device)}
                onReset={() => logic.resetInternalPluginParams(device)}
                onStoreSnapshot={(slot) => logic.storeParamSnapshot(device, slot)}
                onRecallSnapshot={(slot) => logic.recallParamSnapshot(device, slot)}
                onToggleSnapshot={() => logic.toggleParamSnapshot(device)}
                snapshotState={logic.paramSnapshotsByDevice[device.id]}
                onApplyUtilityScene={(scene) => logic.applyQuickUtilityScene(device, scene)}
                onParamContextMenu={(e, paramName) => logic.handleParamContextMenu(e, paramName, device.id)}
                showSettings={device.effectType === 'utility' ? false : !!logic.inlineSettingsOpen[device.id]}
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
                        console.error('[DeviceRack] sampler device drop failed:', err);
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
                        console.error('[DeviceRack] setSamplerSample failed:', err);
                        logic.statusError(`Failed to load sampler sample: ${errorMessage(err)}`);
                    }
                }}
                isNativeEditorOpen={!!(selectedTrack && logic.openEditorsByTrack[selectedTrack.id]?.has(device.id))}
                onOpenGUI={async () => {
                    logic.selectDevice(device.id, false);
                    if (!selectedTrack) return;
                    try {
                        if (device.source !== 'internal') {
                            await logic.ensureSlotRuntimeActive(device.id);
                            await logic.togglePluginEditor(selectedTrack.id, device.id);
                        } else {
                            logic.setInlineSettingsOpen((prev) => ({ ...prev, [device.id]: !prev[device.id] }));
                        }
                        logic.statusClear();
                    } catch (err) {
                        console.error('[DeviceRack] togglePluginEditor failed:', err);
                        logic.statusError(`Failed to open native plugin UI: ${errorMessage(err)}`);
                    }
                }}
            />
            <MeterStrip
                levelL={linearToMeterNorm(device.vuLevelL ?? device.vuLevel)}
                levelR={linearToMeterNorm(device.vuLevelR ?? device.vuLevel)}
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
                gap: 8,
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
