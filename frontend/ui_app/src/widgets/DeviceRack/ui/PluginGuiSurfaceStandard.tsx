// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Standard Plugin GUI Surface Dispatcher
// Enterprise architecture: Registry-first, imperative-fallback
// ═══════════════════════════════════════════════════════════════════════════
import React from 'react';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import type { SurfaceHandlers } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';
import {
    lookupPluginDefinition,
    PluginRendererErrorBoundary,
    UniversalPluginRenderer,
} from '@/widgets/DeviceRack/ui/PluginRegistryRenderer';
// Legacy fallback (AnalyzerMidi — unique viz, not data-driven)
import { renderStandardAnalyzerMidiSurface } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardAnalyzerMidi';

export function renderStandardPluginGuiSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    // ── Registry-driven path (enterprise) ─────────────────────────────
    const definition = lookupPluginDefinition(device);
    if (definition) {
        return (
            <PluginRendererErrorBoundary effectType={device.effectType ?? 'unknown'}>
                <UniversalPluginRenderer device={device} handlers={handlers} definition={definition} />
            </PluginRendererErrorBoundary>
        );
    }

    // ── Legacy fallback for special surfaces ──────────────────────────
    const analyzerMidiSurface = renderStandardAnalyzerMidiSurface(device, handlers);
    if (analyzerMidiSurface) return analyzerMidiSurface;

    return null;
}
