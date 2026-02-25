/** Engine state snapshot — mirrors Rust `EngineStateResponse`. */
export interface EngineState {
    is_playing: boolean;
    bpm: number;
    test_tone_freq: number;
    frames_rendered: number;
    sample_rate: number;
}

/** Transport state — mirrors Rust `TransportState`. */
export interface TransportState {
    is_playing: boolean;
    position_frames: number;
    position_seconds: number;
    position_beats: number;
    bpm: number;
    sample_rate: number;
    loop_enabled: boolean;
    loop_start: number;
    loop_end: number;
    output_latency_frames: number;
    telemetry_timestamp_ms: number;
    time_sig_numerator: number;
    time_sig_denominator: number;
}

/** Per-channel meter reading — mirrors Rust `MeterReading`. */
export interface MeterReading {
    rms: number;
    peak: number;
    clipping: boolean;
}

/** Full metering snapshot — mirrors Rust `MeteringSnapshot`. */
export interface MeteringSnapshot {
    tracks: [MeterReading, MeterReading][];
    master_left: MeterReading;
    master_right: MeterReading;
}

/** Project event-sourcing history item (backend in-memory journal). */
export interface ProjectHistoryEvent {
    seq: number;
    kind: string;
    detail: string;
    timestampMs: number;
}

/** Debug snapshot of backend-built PDC graph diagnostics. */
export interface PdcDebugSnapshot {
    node_count: number;
    edge_count: number;
    node_pdc_nonzero: number;
    edge_pdc_nonzero: number;
    processing_order: string[];
    nodes: PdcNodeDebug[];
    edges: PdcEdgeDebug[];
    node_summary: string;
    edge_summary: string;
}

export interface RtDebugSnapshot {
    enabled: boolean;
    callbackCount: number;
    commandCountTotal: number;
    commandCountLast: number;
    commandCountMax: number;
    callbackDurationUsLast: number;
    callbackDurationUsMax: number;
    callbackFramesLast: number;
    pluginHostLockMissTotal: number;
    queueFullRejectTotal: number;
    deferredTopologyLenLast: number;
}

export interface PdcNodeDebug {
    node_id: number;
    name: string;
    kind: 'Track' | 'Effect' | 'Bus' | 'MasterOutput' | string;
    own_latency_samples: number;
    node_delay_samples: number;
}

export interface PdcEdgeDebug {
    from_node_id: number;
    to_node_id: number;
    from_name: string;
    to_name: string;
    edge_delay_samples: number;
}

/** MIDI input port descriptor. */
export interface MidiInputPort {
    name: string;
    connected: boolean;
}

/** Track state update — mirrors Rust `TrackStateUpdate`. */
export interface TrackStateUpdate {
    track_index: number;
    volume?: number;
    pan?: number;
    muted?: boolean;
    soloed?: boolean;
}

/** Application settings — mirrors Rust `AppSettings` (camelCase serialization). */
export interface AppSettings {
    language: string;
    startupBehavior: string;
    theme: 'dark' | 'light' | 'forest';
    darkThemeShade: number;
    darkThemeTintPercent: number;
    forestThemeCanopyPercent: number;
    forestThemeFogPercent: number;
    lightThemeTexturePercent: number;
    themeDetailPercent: number;
    themePanelsDetailPercent: number;
    themeTimelineDetailPercent: number;
    themeMotionEnabled: boolean;
    themeMotionPercent: number;
    themeOverlayEnabled: boolean;
    themePanelsOrnamentsEnabled: boolean;
    themeTimelineOrnamentsEnabled: boolean;
    themeAtmosphereProfile: string;
    favoriteThemePreset: string;
    waveformStyle: string;
    driverType: string;
    outputDevice: string;
    fallbackOutputDevice: string;
    inputDevice: string;
    sampleRate: number;
    bufferSize: number;
    driverErrorCompensation: number;
    testToneEnabled: boolean;
    testToneVolume: number;
    testToneFrequency: number;
    cpuUsageSimulator: boolean;
    srPitchConversion: boolean;
    userFolderPath: string;
    samplesPath: string;
    vst2Path: string;
    vst3Path: string;
    openRouterApiKey: string;
    openRouterModel: string;
    browserShowSizeColumn: boolean;
    browserShowTypeColumn: boolean;
    browserLeftPaneWidth: number;
    transportFollowPlayhead: boolean;
    transportAutomationVisible: boolean;
    transportPianoPencilMode: boolean;
    arrangementGridDivision: string;
    arrangementGridTriplet: boolean;
    arrangementGridSnapEnabled: boolean;
}

/** Recent project entry. */
export interface RecentProject {
    name: string;
    path: string;
    last_opened: string;
}

/** Project status response. */
export interface ProjectStatus {
    isDirty: boolean;
    filePath: string | null;
    projectFolder: string | null;
}
