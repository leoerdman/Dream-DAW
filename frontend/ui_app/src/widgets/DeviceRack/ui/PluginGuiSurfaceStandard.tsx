// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Standard Plugin GUI Surface Dispatcher
// Enterprise architecture: Registry-first, imperative-fallback
// ═══════════════════════════════════════════════════════════════════════════
import React from 'react';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import type { SurfaceHandlers } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';
import {
    lookupPluginDefinition,
    UniversalPluginRenderer,
} from '@/widgets/DeviceRack/ui/PluginDefinitionRegistry';
// Legacy fallback imports (AnalyzerMidi is special — not data-driven yet)
import { renderStandardAnalyzerMidiSurface } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardAnalyzerMidi';

export function renderStandardPluginGuiSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    // ── Registry-driven path (enterprise) ─────────────────────────────
    // If the plugin type exists in the declarative registry, the
    // UniversalPluginRenderer handles everything from pure config.
    const definition = lookupPluginDefinition(device);
    if (definition) {
        return <UniversalPluginRenderer device={device} handlers={handlers} definition={definition} />;
    }

    // ── Legacy fallback for special surfaces ──────────────────────────
    // AnalyzerMidi has unique visualization needs (spectrum overlay, MIDI grid)
    // that require hand-crafted components — kept as imperative surfaces.
    const analyzerMidiSurface = renderStandardAnalyzerMidiSurface(device, handlers);
    if (analyzerMidiSurface) return analyzerMidiSurface;

    return null;
}
