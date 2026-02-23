import type React from 'react';
import { formatBadgeColor } from '@/shared/config/pluginManifest';
import type { PluginFormat } from '@/shared/config/pluginManifest';
import type * as engineApi from '@/shared/api/engine';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';

interface DeviceNodeHeaderProps {
    device: DeviceSlot;
    deviceIndex: number;
    showSettings: boolean;
    supportsSettingsToggle: boolean;
    showUiButton: boolean;
    nativeEditorOpen: boolean;
    showRecoverAction: boolean;
    pluginFormat: string;
    editorSupported?: boolean;
    editorReason?: string;
    onToggle: () => void;
    onOpenGUI?: () => void;
    onEnsureActive?: () => void;
    onOpenSettings: () => void;
    onSelect: (e: React.MouseEvent<HTMLDivElement>) => void;
}

export function DeviceNodeHeader({
    device,
    deviceIndex,
    showSettings,
    supportsSettingsToggle,
    showUiButton,
    nativeEditorOpen,
    showRecoverAction,
    pluginFormat,
    editorSupported,
    editorReason,
    onToggle,
    onOpenGUI,
    onEnsureActive,
    onOpenSettings,
    onSelect,
}: DeviceNodeHeaderProps) {
    const resolvedPluginFormat: PluginFormat = (
        pluginFormat === 'INT' || pluginFormat === 'VST2' || pluginFormat === 'VST3' || pluginFormat === 'AU'
    ) ? pluginFormat : 'INT';

    return (
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
            onClick={(e) => {
                e.stopPropagation();
                onSelect(e);
            }}
        >
            <button
                draggable={false}
                onClick={onToggle}
                title={device.isEnabled ? 'Disable' : 'Enable'}
                style={{
                    width: 14,
                    height: 14,
                    borderRadius: '50%',
                    background: device.isEnabled ? 'var(--color-accent-primary)' : 'transparent',
                    border: device.isEnabled ? 'none' : '1px solid var(--color-overlay-light)',
                    cursor: 'pointer',
                    padding: 0,
                    margin: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                }}
            />
            {showUiButton && (
                <button
                    draggable={false}
                    onClick={(e) => {
                        e.stopPropagation();
                        onOpenGUI?.();
                    }}
                    title={
                        editorSupported === false
                            ? (editorReason ?? 'Native plugin editor is unavailable; opening inline controls')
                            : 'Open Native Plugin UI'
                    }
                    style={{
                        width: 16,
                        height: 16,
                        borderRadius: 'var(--radius-sm)',
                        background: (showSettings || nativeEditorOpen) ? '#48d282' : 'transparent',
                        border: (showSettings || nativeEditorOpen) ? 'none' : '1px solid var(--color-overlay-light)',
                        cursor: 'pointer',
                        flexShrink: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 0,
                        margin: 0,
                        transition: 'var(--transition-fast)',
                    }}
                >
                    <svg width="8" height="8" viewBox="0 0 16 16" fill="none">
                        <path
                            d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"
                            stroke={(showSettings || nativeEditorOpen) ? 'var(--color-bg-primary)' : '#48d282'}
                            strokeWidth="2"
                            fill="none"
                        />
                        <circle cx="8" cy="8" r="2.5" fill={(showSettings || nativeEditorOpen) ? 'var(--color-bg-primary)' : '#48d282'} />
                    </svg>
                </button>
            )}
            {showRecoverAction && (
                <button
                    draggable={false}
                    onClick={(e) => {
                        e.stopPropagation();
                        onEnsureActive?.();
                    }}
                    title="Recover plugin runtime"
                    style={{
                        width: 14,
                        height: 14,
                        borderRadius: '50%',
                        background: 'rgba(255, 100, 100, 0.25)',
                        border: '1px solid rgba(255, 100, 100, 0.5)',
                        cursor: 'pointer',
                        flexShrink: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 0,
                        fontSize: 8,
                        fontWeight: 800,
                        color: '#ff6464',
                    }}
                >
                    !
                </button>
            )}
            {supportsSettingsToggle && (
                <button
                    draggable={false}
                    onClick={(e) => {
                        e.stopPropagation();
                        onOpenSettings();
                    }}
                    title="Plugin Settings / Automatable Params"
                    style={{
                        width: 16,
                        height: 16,
                        borderRadius: 'var(--radius-sm)',
                        background: showSettings ? 'var(--color-text-secondary)' : 'transparent',
                        border: showSettings ? 'none' : '1px solid var(--color-overlay-light)',
                        cursor: 'pointer',
                        flexShrink: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 0,
                        margin: 0,
                    }}
                >
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                        <path
                            d="M10.5 2a3.5 3.5 0 00-3.22 4.87L2.5 11.65a1.2 1.2 0 001.7 1.7l4.78-4.78A3.5 3.5 0 0010.5 2z"
                            stroke={showSettings ? 'var(--color-bg-primary)' : 'var(--color-text-secondary)'}
                            strokeWidth="1.5"
                            fill="none"
                            strokeLinecap="round"
                        />
                    </svg>
                </button>
            )}
            <span
                style={{
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
                }}
            >
                {device.name}
            </span>
            <span
                style={{
                    fontSize: 6,
                    color: formatBadgeColor(resolvedPluginFormat),
                    fontWeight: 'var(--font-weight-bold)' as unknown as number,
                    flexShrink: 0,
                    opacity: 0.6,
                }}
            >
                {pluginFormat}
            </span>
        </div>
    );
}

export type DeviceRuntimeStatus = engineApi.PluginSlotRuntimeStatus;
