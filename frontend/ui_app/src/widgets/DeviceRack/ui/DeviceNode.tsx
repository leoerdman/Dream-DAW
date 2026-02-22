import { resolvePlugin, formatBadgeColor } from '@/shared/config/pluginManifest';
import { useDragStore } from '@/shared/stores/useDragStore';
import * as engineApi from '@/shared/api/engine';
import { PluginSettingsPanel } from '@/widgets/DeviceRack/ui/PluginSettingsPanel';
import { PluginGuiSurface } from '@/widgets/DeviceRack/ui/PluginGuiSurface';
import { QUICK_PRESETS_BY_EFFECT } from '@/widgets/DeviceRack/model/presets';
import type { DeviceSlot, QuickPreset } from '@/widgets/DeviceRack/model/types';
import { canDropInZone } from '@/shared/lib/dndMatrix';

export const DeviceNode = ({
    device, onToggle, onOpenGUI,
    deviceIndex,
    isSelected,
    isNativeEditorOpen,
    showSettings,
    onSelect,
    onOpenSettings,
    onParamChange,
    onParamGestureStart,
    onParamGestureEnd,
    onApplyQuickPreset,
    onRandomize,
    onReset,
    onStoreSnapshot,
    onRecallSnapshot,
    onToggleSnapshot,
    snapshotState,
    onApplyUtilityScene,
    onDropSample,
    onLoadSample,
    editorSupported, editorReason,
    runtimeStatus,
    onParamContextMenu,
    sidechainSourceTrackId,
    sidechainOptions,
    onSidechainSourceChange,
    onEnsureActive,
}: {
    device: DeviceSlot;
    deviceIndex: number;
    onToggle: () => void;
    isSelected: boolean;
    showSettings: boolean;
    onSelect: (e: React.MouseEvent<HTMLDivElement>) => void;
    onOpenSettings: () => void;
    onParamChange: (paramName: string, value: number) => void;
    onParamGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onParamGestureEnd?: (paramName: string) => void;
    onApplyQuickPreset?: (preset: QuickPreset) => void;
    onRandomize?: () => void;
    onReset?: () => void;
    onStoreSnapshot?: (slot: 'A' | 'B') => void;
    onRecallSnapshot?: (slot: 'A' | 'B') => void;
    onToggleSnapshot?: () => void;
    snapshotState?: { A?: Record<string, number>; B?: Record<string, number>; active?: 'A' | 'B' };
    onApplyUtilityScene?: (scene: 'center' | 'mono' | 'wide') => void;
    onDropSample?: (samplePath: string) => void;
    onLoadSample?: () => void;
    onOpenGUI?: () => void;
    isNativeEditorOpen?: boolean;
    editorSupported?: boolean;
    editorReason?: string;
    runtimeStatus?: engineApi.PluginSlotRuntimeStatus;
    onParamContextMenu?: (e: React.MouseEvent, paramName: string) => void;
    sidechainSourceTrackId?: string;
    sidechainOptions?: Array<{ id: string; name: string }>;
    onSidechainSourceChange?: (sourceTrackId: string) => void;
    onEnsureActive?: () => void;
}) => {
    // Resolve plugin metadata from centralized manifest (SSOT)
    const isInstrumentSlot = device.effectType === 'instrument' || device.effectType === 'sampler' || device.effectType === 'waveSynth';
    const manifest = resolvePlugin(device.pluginId, device.name, device.source, isInstrumentSlot);

    // Card dimensions — manifest provides the default, expand for settings
    const baseWidth = device.source === 'internal' && device.effectType === 'waveSynth'
        ? 980
        : device.source === 'internal' && device.effectType === 'eq'
            ? 540
            : manifest.cardWidth;
    const settingsWidth = Math.min(1460, Math.max(baseWidth, 280 + device.params.length * 110));
    const rackWidth = showSettings ? settingsWidth : baseWidth;
    const supportsSettingsToggle = manifest.supportsSettings;
    const pluginFormat = manifest.format;
    const showUiButton = manifest.hasEditor;
    const nativeEditorOpen = isNativeEditorOpen ?? false;
    const showRecoverAction = !!runtimeStatus && !runtimeStatus.loaded;
    const quickPresets = device.source === 'internal'
        ? (QUICK_PRESETS_BY_EFFECT[device.effectType] ?? [])
        : [];

    return (
        <div
            className="device-node"
            data-effect={device.effectType}
            style={{
                minWidth: rackWidth,
                width: rackWidth,
                display: 'flex',
                flexDirection: 'row',
                background: '#3a3a3a',
                borderRadius: 'var(--radius-sm)',
                border: isSelected ? '1px solid rgba(255,255,255,0.7)' : '1px solid #3a3a3a',
                overflow: 'hidden',
                opacity: device.isEnabled ? 1 : 0.5,
                transition: 'opacity var(--transition-fast)',
                flexShrink: 0,
                height: '100%',
                minHeight: '100%',
                position: 'relative',
                boxShadow: 'none',
            }}
            onMouseUp={() => {
                const dragging = useDragStore.getState().draggingItem;
                const acceptance = dragging ? canDropInZone(dragging, 'sampler-surface') : { allowed: false };
                const isSamplerDevice =
                    device.source === 'internal' &&
                    (device.effectType === 'sampler' || device.effectType === 'instrument');
                if (!isSamplerDevice) return;
                if (dragging?.path && acceptance.allowed) {
                    onDropSample?.(dragging.path);
                    useDragStore.getState().endDrag();
                }
            }}
        >
            {/* ── Vertical Left Header Strip (Bitwig-style) ── */}
            <div
                draggable
                onDragStart={(e) => {
                    const target = e.target as HTMLElement;
                    if (target.closest('button, input, select, [data-no-drag]')) {
                        e.preventDefault();
                        return;
                    }
                    e.dataTransfer.setData('application/x-dream-device-id', device.id);
                    e.dataTransfer.setData('application/x-dream-device-index', String(deviceIndex));
                    e.dataTransfer.effectAllowed = 'move';
                    const slot = (e.currentTarget as HTMLElement).closest('.dream-device-drop-indicator') as HTMLElement | null;
                    if (slot) slot.style.opacity = '0.4';
                }}
                onDragEnd={() => {
                    const slot = document.querySelector('.dream-device-drop-indicator[style*="opacity"]') as HTMLElement | null;
                    if (slot) slot.style.opacity = '1';
                    document.querySelectorAll('.dream-device-drop-indicator').forEach((el) => {
                        (el as HTMLElement).style.borderLeft = '';
                        (el as HTMLElement).style.borderRight = '';
                    });
                }}
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 6,
                    padding: '8px 0',
                    borderRight: '1px solid var(--color-divider)',
                    background: 'var(--surface-tab-inactive)',
                    cursor: 'grab',
                    width: 32,
                    minWidth: 32,
                    flexShrink: 0,
                }}
                onClick={(e) => { e.stopPropagation(); onSelect(e); }}
            >
                {/* ● Bypass — round power dot */}
                <button
                    draggable={false}
                    onClick={onToggle}
                    title={device.isEnabled ? 'Disable' : 'Enable'}
                    style={{
                        width: 14, height: 14,
                        borderRadius: '50%',
                        background: device.isEnabled ? 'var(--color-accent-primary)' : 'transparent',
                        border: device.isEnabled ? 'none' : '1px solid var(--color-overlay-light)',
                        cursor: 'pointer',
                        padding: 0,
                        margin: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                    }}
                />
                {/* 👁 UI button — green round with eye icon */}
                {showUiButton && (
                    <button
                        draggable={false}
                        onClick={(e) => { e.stopPropagation(); onOpenGUI?.(); }}
                        title={editorSupported === false
                            ? (editorReason ?? 'Native plugin editor is unavailable; opening inline controls')
                            : 'Open Native Plugin UI'}
                        style={{
                            width: 16, height: 16,
                            borderRadius: 'var(--radius-sm)',
                            background: (showSettings || nativeEditorOpen) ? '#48d282' : 'transparent',
                            border: (showSettings || nativeEditorOpen) ? 'none' : '1px solid var(--color-overlay-light)',
                            cursor: 'pointer',
                            flexShrink: 0,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            padding: 0, margin: 0,
                            transition: 'var(--transition-fast)',
                        }}
                    >
                        <svg width="8" height="8" viewBox="0 0 16 16" fill="none">
                            <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"
                                stroke={(showSettings || nativeEditorOpen) ? 'var(--color-bg-primary)' : '#48d282'}
                                strokeWidth="2" fill="none" />
                            <circle cx="8" cy="8" r="2.5"
                                fill={(showSettings || nativeEditorOpen) ? 'var(--color-bg-primary)' : '#48d282'} />
                        </svg>
                    </button>
                )}
                {/* Fix button — only when plugin runtime is dead */}
                {showRecoverAction && (
                    <button
                        draggable={false}
                        onClick={(e) => { e.stopPropagation(); onEnsureActive?.(); }}
                        title="Recover plugin runtime"
                        style={{
                            width: 14, height: 14,
                            borderRadius: '50%',
                            background: 'rgba(255, 100, 100, 0.25)',
                            border: '1px solid rgba(255, 100, 100, 0.5)',
                            cursor: 'pointer',
                            flexShrink: 0,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            padding: 0,
                            fontSize: 8, fontWeight: 800, color: '#ff6464',
                            transition: 'all 0.15s',
                        }}
                    >
                        !
                    </button>
                )}
                {/* 🔧 Wrench — settings SVG */}
                {supportsSettingsToggle && (
                    <button
                        draggable={false}
                        onClick={(e) => { e.stopPropagation(); onOpenSettings(); }}
                        title="Plugin Settings / Automatable Params"
                        style={{
                            width: 16, height: 16,
                            borderRadius: 'var(--radius-sm)',
                            background: showSettings ? 'var(--color-text-secondary)' : 'transparent',
                            border: showSettings ? 'none' : '1px solid var(--color-overlay-light)',
                            cursor: 'pointer',
                            flexShrink: 0,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            padding: 0, margin: 0,
                            transition: 'var(--transition-fast)',
                        }}
                    >
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                            <path d="M10.5 2a3.5 3.5 0 00-3.22 4.87L2.5 11.65a1.2 1.2 0 001.7 1.7l4.78-4.78A3.5 3.5 0 0010.5 2z"
                                stroke={showSettings ? 'var(--color-bg-primary)' : 'var(--color-text-secondary)'}
                                strokeWidth="1.5" fill="none" strokeLinecap="round" />
                        </svg>
                    </button>
                )}
                {/* Rotated device name — fills remaining vertical space */}
                <span style={{
                    writingMode: 'vertical-lr',
                    transform: 'rotate(180deg)',
                    fontSize: 'var(--font-size-micro)',
                    fontWeight: 'var(--font-weight-bold)' as unknown as number,
                    color: '#808080',
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    lineHeight: 1,
                }}>
                    {device.name}
                </span>
                {/* Format badge at bottom */}
                <span style={{
                    fontSize: 6,
                    color: formatBadgeColor(pluginFormat),
                    fontWeight: 'var(--font-weight-bold)' as unknown as number,
                    flexShrink: 0,
                    opacity: 0.6,
                }}>
                    {pluginFormat}
                </span>
            </div>

            {/* ── Body — fills remaining horizontal space ── */}
            {device.source === 'internal' ? (
                <div
                    style={{
                        padding: 4,
                        flex: 1,
                        minWidth: 0,
                        minHeight: 0,
                        display: 'grid',
                        gridTemplateRows: showSettings && supportsSettingsToggle ? '1fr auto' : '1fr',
                        gap: 4,
                        overflow: 'hidden',
                    }}
                >
                    <div style={{ minHeight: 0 }}>
                        <PluginGuiSurface
                            device={device}
                            onParamChange={onParamChange}
                            onParamGestureStart={onParamGestureStart}
                            onParamGestureEnd={onParamGestureEnd}
                            onApplyUtilityScene={onApplyUtilityScene}
                            onDropSample={onDropSample}
                            onLoadSample={onLoadSample}
                            onParamContextMenu={onParamContextMenu}
                        />
                    </div>
                    {showSettings && supportsSettingsToggle && (
                        <div
                            style={{
                                maxHeight: 230,
                                overflow: 'auto',
                                border: '1px solid rgba(255,255,255,0.04)',
                                borderRadius: 'var(--radius-sm)',
                                background: 'rgba(0,0,0,0.15)',
                                padding: 6,
                            }}
                        >
                            <PluginSettingsPanel
                                device={device}
                                quickPresets={quickPresets}
                                onParamChange={onParamChange}
                                onParamGestureStart={onParamGestureStart}
                                onParamGestureEnd={onParamGestureEnd}
                                onApplyQuickPreset={onApplyQuickPreset}
                                onRandomize={onRandomize}
                                onReset={onReset}
                                onStoreSnapshot={onStoreSnapshot}
                                onRecallSnapshot={onRecallSnapshot}
                                onToggleSnapshot={onToggleSnapshot}
                                snapshotState={snapshotState}
                                onLoadSample={onLoadSample}
                                sidechainSourceTrackId={sidechainSourceTrackId}
                                sidechainOptions={sidechainOptions}
                                onSidechainSourceChange={onSidechainSourceChange}
                                runtimeStatus={runtimeStatus}
                                editorSupported={editorSupported}
                                editorReason={editorReason}
                            />
                        </div>
                    )}
                </div>
            ) : showSettings && supportsSettingsToggle ? (
                <div style={{ padding: 6, flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' }}>
                    <PluginSettingsPanel
                        device={device}
                        quickPresets={quickPresets}
                        onParamChange={onParamChange}
                        onParamGestureStart={onParamGestureStart}
                        onParamGestureEnd={onParamGestureEnd}
                        onApplyQuickPreset={onApplyQuickPreset}
                        onRandomize={onRandomize}
                        onReset={onReset}
                        onStoreSnapshot={onStoreSnapshot}
                        onRecallSnapshot={onRecallSnapshot}
                        onToggleSnapshot={onToggleSnapshot}
                        snapshotState={snapshotState}
                        onLoadSample={onLoadSample}
                        sidechainSourceTrackId={sidechainSourceTrackId}
                        sidechainOptions={sidechainOptions}
                        onSidechainSourceChange={onSidechainSourceChange}
                        runtimeStatus={runtimeStatus}
                        editorSupported={editorSupported}
                        editorReason={editorReason}
                    />
                </div>
            ) : (
                <div style={{
                    padding: device.source === 'vst' ? 8 : 0,
                    flex: 1,
                    minWidth: 0,
                    minHeight: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: device.source === 'vst' ? 'flex-start' : 'center',
                    alignItems: 'center',
                    gap: 6,
                }}>
                    {/* Sidechain dropdown — shown for all external VST plugins */}
                    {device.source === 'vst' && (
                        <div style={{
                            display: 'grid',
                            gap: 4,
                            width: '100%',
                        }}>
                            <span style={{
                                fontSize: 'var(--font-size-2xs)',
                                color: 'var(--color-text-tertiary)',
                                fontWeight: 'var(--font-weight-bold)' as unknown as number,
                                letterSpacing: '0.04em',
                                textTransform: 'uppercase',
                            }}>
                                Side Chain
                            </span>
                            <select
                                value={sidechainSourceTrackId || 'none'}
                                onChange={(e) => onSidechainSourceChange?.(e.target.value)}
                                style={{
                                    border: '1px solid var(--color-divider)',
                                    borderRadius: 'var(--radius-md)',
                                    background: '#2a2a2a',
                                    color: 'var(--color-text-primary)',
                                    fontSize: 'var(--font-size-2xs)',
                                    padding: '4px 6px',
                                    outline: 'none',
                                    width: '100%',
                                }}
                            >
                                <option value="none">None</option>
                                {(sidechainOptions ?? []).map((track) => (
                                    <option key={track.id} value={track.id}>{track.name}</option>
                                ))}
                            </select>
                        </div>
                    )}
                </div>
            )}

        </div>
    );
};
