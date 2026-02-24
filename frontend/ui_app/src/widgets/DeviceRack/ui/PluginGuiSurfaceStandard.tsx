import React from 'react';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import { renderStandardDistNoiseSurface } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardDistNoise';
import { renderStandardAnalyzerMidiSurface } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardAnalyzerMidi';
import { renderStandardUtilityCompressorSurface } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardUtilityCompressor';
import { renderTimeToneSurface } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardTimeTone';
import { renderStandardDynamicsModSurface } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardDynamicsMod';
import type { SurfaceHandlers } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';

export function renderStandardPluginGuiSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const utilityCompressorSurface = renderStandardUtilityCompressorSurface(device, handlers);
    if (utilityCompressorSurface) return utilityCompressorSurface;

    const timeSurface = renderTimeToneSurface(device, handlers);
    if (timeSurface) return timeSurface;

    const dynamicsModSurface = renderStandardDynamicsModSurface(device, handlers);
    if (dynamicsModSurface) return dynamicsModSurface;

    const distNoiseSurface = renderStandardDistNoiseSurface(device, handlers);
    if (distNoiseSurface) return distNoiseSurface;

    const analyzerMidiSurface = renderStandardAnalyzerMidiSurface(device, handlers);
    if (analyzerMidiSurface) return analyzerMidiSurface;

    return null;
}
