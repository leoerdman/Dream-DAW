// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Engine IPC Gateway
// ═══════════════════════════════════════════════════════════════════════════
//
// Typed wrappers around every Tauri `invoke()` call.
// This is the ONLY file that imports `@tauri-apps/api`.
// All other code uses these functions — never raw invoke.
//
// ═══════════════════════════════════════════════════════════════════════════

import { invoke } from '@tauri-apps/api/core';

// ── Types (re-exported from shared_bindings) ─────────────────────────────

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
    /** Hardware output latency in sample frames for A/V sync compensation. */
    output_latency_frames: number;
    /** Wall-clock timestamp (ms since UNIX epoch) for playhead interpolation. */
    telemetry_timestamp_ms: number;
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
    waveformStyle: string;
    driverType: string;
    outputDevice: string;
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

// ── Transport Commands ───────────────────────────────────────────────────

/** Start audio playback. */
export const play = () => invoke<void>('play');

/** Stop audio playback. */
export const stop = () => invoke<void>('stop');

/** Toggle play/stop. Returns new playing state. */
export const togglePlayback = () => invoke<boolean>('toggle_playback');

/** Seek to position in sample frames. */
export const seek = (positionFrames: number) =>
    invoke<void>('seek', { positionFrames });

/** Seek to position in seconds. */
export const seekSeconds = (seconds: number) =>
    invoke<void>('seek_seconds', { seconds });

/** Seek to a specific beat position (uses engine BPM + sample rate for precision). */
export const seekToBeat = (beat: number) =>
    invoke<void>('seek_to_beat', { beat });

/** Set project tempo (BPM). Range: 20–999. */
export const setBpm = (bpm: number) => invoke<void>('set_bpm', { bpm });

/** Set loop region and enable/disable looping. */
export const setLoop = (enabled: boolean, startFrames: number, endFrames: number) =>
    invoke<void>('set_loop', { enabled, startFrames, endFrames });

// ── Track Commands ───────────────────────────────────────────────────────

/** Set track volume (linear gain 0.0–2.0). */
export const setTrackVolume = (trackIndex: number, volume: number) =>
    invoke<void>('set_track_volume', { trackIndex, volume });

/** Set track pan (-1.0 to 1.0). */
export const setTrackPan = (trackIndex: number, pan: number) =>
    invoke<void>('set_track_pan', { trackIndex, pan });

/** Set master volume (linear gain 0.0–2.0). */
export const setMasterVolume = (volume: number) =>
    invoke<void>('set_master_volume', { volume });

/** Mute/unmute a track. */
export const setTrackMute = (trackIndex: number, muted: boolean) =>
    invoke<void>('set_track_mute', { trackIndex, muted });

/** Solo/unsolo a track. */
export const setTrackSolo = (trackIndex: number, soloed: boolean) =>
    invoke<void>('set_track_solo', { trackIndex, soloed });

// ── Device Chain Commands ────────────────────────────────────────────────

/** Built-in effect type values (mirrors BuiltinEffectType in Rust). */
export type BuiltinEffectType = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const BuiltinEffectType: {
    Eq: BuiltinEffectType;
    Compressor: BuiltinEffectType;
    Delay: BuiltinEffectType;
    Reverb: BuiltinEffectType;
    Chorus: BuiltinEffectType;
    Utility: BuiltinEffectType;
    Saturator: BuiltinEffectType;
} = {
    Eq: 0,
    Compressor: 1,
    Delay: 2,
    Reverb: 3,
    Chorus: 4,
    Utility: 5,
    Saturator: 6,
};

/** Add a built-in DSP device to a track's insert chain. */
export const addDevice = (trackIndex: number, slotIndex: number, effectType: BuiltinEffectType) =>
    invoke<void>('add_device_cmd', { trackIndex, slotIndex, effectType });

/** Remove a device from a track's insert chain. */
export const removeDevice = (trackIndex: number, slotIndex: number) =>
    invoke<void>('remove_device_cmd', { trackIndex, slotIndex });

/** Bypass or enable a device in a track's insert chain. */
export const bypassDevice = (trackIndex: number, slotIndex: number, bypassed: boolean) =>
    invoke<void>('bypass_device_cmd', { trackIndex, slotIndex, bypassed });

/** Set a parameter on a device in a track's insert chain. */
export const setDeviceParam = (trackIndex: number, slotIndex: number, paramIndex: number, value: number) =>
    invoke<void>('set_device_param_cmd', { trackIndex, slotIndex, paramIndex, value });

/** Batch update a track's state. */
export const updateTrack = (update: TrackStateUpdate) =>
    invoke<void>('update_track', { update });

/** Add a new audio track to the project. Auto-names if name is null. */
export const addTrack = (name?: string) =>
    invoke<void>('add_track_cmd', {
        name: name ?? null,
        trackType: 'audio',
        insertAfterIndex: null,
    });

export type TrackCreateType = 'audio' | 'midi' | 'group';

/** Add a track with explicit type and insertion semantics. */
export const addTrackAdvanced = (
    trackType: TrackCreateType,
    insertAfterIndex?: number | null,
    name?: string,
) =>
    invoke<void>('add_track_cmd', {
        name: name ?? null,
        trackType,
        insertAfterIndex: insertAfterIndex ?? null,
    });

/** Delete a track by its zero-based index. */
export const deleteTrack = (index: number) =>
    invoke<void>('delete_track_cmd', { index });

/** Rename a track by its zero-based index. */
export const renameTrack = (index: number, name: string) =>
    invoke<void>('rename_track_cmd', { index, name });

// ── State Queries ────────────────────────────────────────────────────────

/** Get current engine state snapshot. */
export const getState = () => invoke<EngineState>('get_state');

/** Get current transport state (position, BPM, loop). */
export const getTransport = () => invoke<TransportState>('get_transport');

/** Get lock-free meter readings (VU levels). ~60fps polling target. */
export const getMeters = () => invoke<MeteringSnapshot>('get_meters');

// ── Legacy / Debug ───────────────────────────────────────────────────────

/** Set test tone frequency (Hz). Range: 20–20000. */
export const setFrequency = (freq: number) =>
    invoke<void>('set_frequency', { freq });

// ── Audio Import ─────────────────────────────────────────────────────────

/** Response from importing an audio file — mirrors Rust `ImportAudioResponse`. */
export interface ImportAudioResponse {
    clip_id: string;
    clip_name: string;
    duration_seconds: number;
    sample_rate: number;
    channels: number;
    frames: number;
}

/** Import an audio file, decode it, and place a clip on the specified track. */
export const importAudioFile = (path: string, trackIndex: number, positionFrames?: number) =>
    invoke<ImportAudioResponse>('import_audio_file', {
        path,
        trackIndex,
        positionFrames: positionFrames ?? null,
    });

// ── MIDI Clip ────────────────────────────────────────────────────────────

interface CreateMidiClipResponse {
    clip_id: string;
    clip_name: string;
    position_frames: number;
    duration_frames: number;
}

export interface MidiClipNoteUpdate {
    pitch: number;
    velocity: number;
    startFrames: number;
    durationFrames: number;
}

/** Create an empty MIDI clip on a track at the given position. */
export const createMidiClip = (
    trackIndex: number,
    positionFrames: number,
    durationFrames: number,
    name?: string,
) =>
    invoke<CreateMidiClipResponse>('create_midi_clip_cmd', {
        trackIndex,
        positionFrames,
        durationFrames,
        name: name ?? null,
    });

/** Replace all notes in a MIDI clip. */
export const updateMidiClip = (
    clipId: string,
    notes: MidiClipNoteUpdate[],
) =>
    invoke<void>('update_midi_clip_cmd', {
        clipId,
        notes: notes.map((n) => ({
            pitch: Math.max(0, Math.min(127, Math.round(n.pitch))),
            velocity: Math.max(1, Math.min(127, Math.round(n.velocity))),
            start_frames: Math.max(0, Math.round(n.startFrames)),
            duration_frames: Math.max(1, Math.round(n.durationFrames)),
        })),
    });

/** Enumerate available MIDI input devices from backend. */
export const getMidiInputs = () =>
    invoke<MidiInputPort[]>('get_midi_inputs');

/** Connect live MIDI input by exact OS port name. */
export const connectMidiInput = (portName: string) =>
    invoke<void>('connect_midi_input', { portName });

// ── Audio Preview ────────────────────────────────────────────────────────

/** Generate demo WAV samples in the Samples folder. Returns count of generated files. */
export const generateDemoSamples = () =>
    invoke<number>('generate_demo_samples_cmd');

/** Preview (audition) an audio file through the system output. */
export const previewAudioFile = (path: string) =>
    invoke<void>('preview_audio_file_cmd', { path });

/** Stop the current audio preview. */
export const stopPreview = () =>
    invoke<void>('stop_preview_cmd');

// ── Splash / Window ──────────────────────────────────────────────────────

/** Expand window from splash mode (450×450) to full DAW mode (1400×900). */
export const expandWindow = () => invoke<void>('expand_window');

// ── Project Management ───────────────────────────────────────────────────

/** Create a new empty project. Returns the new project. */
export const newProject = () => invoke<unknown>('new_project');

/** Save current project to its existing path. */
export const saveProject = () => invoke<string>('save_project');

/** Save current project to a new path. */
export const saveProjectAs = (path: string) =>
    invoke<string>('save_project_as', { path });

/** Open a project from disk. Returns the loaded project. */
export const openProject = (path: string) =>
    invoke<unknown>('open_project', { path });

/** Get list of recently opened projects. */
export const getRecentProjects = () =>
    invoke<RecentProject[]>('get_recent_projects');

/** Get current project data. */
export const getProject = () => invoke<unknown>('get_project');

/** Get project status (dirty, path, name). */
export const getProjectStatus = () => invoke<ProjectStatus>('get_project_status');

/** Create a backup of the current project in the Backup/ directory. */
export const createBackup = () => invoke<string>('create_backup_cmd');

/** Mark the project as having unsaved changes (dirty state). */
export const markDirty = () => invoke<void>('mark_dirty_cmd');

/** Sync the window title with the current dirty state (adds/removes *). */
export const syncTitle = () => invoke<void>('sync_title_cmd');

// ── Settings ─────────────────────────────────────────────────────────────

/** Get current application settings. */
export const getSettings = () => invoke<AppSettings>('get_settings');

/** Update application settings and persist to disk. */
export const updateSettings = (newSettings: AppSettings) =>
    invoke<void>('update_settings', { newSettings });

// ── File Browser ─────────────────────────────────────────────────────────

/** Audio file entry returned by folder scan. */
export interface AudioFileEntry {
    name: string;
    path: string;
    size_bytes: number;
    modified_at: string;
    format: string;
}

/** Recursively scan a directory for audio files. */
export const scanAudioFolder = (path: string) =>
    invoke<AudioFileEntry[]>('scan_audio_folder', { path });

/** Scan ALL audio sources: samples_path + all browser_folders. Unified sorted list. */
export const scanAllAudioSources = () =>
    invoke<AudioFileEntry[]>('scan_all_audio_sources');

// ── Browser Folder Management ────────────────────────────────────────

/** Classified file entry returned by scan_folder_all. */
export interface BrowserFileEntry {
    name: string;
    path: string;
    size_bytes: number;
    modified_at: string;
    extension: string;
    /** Semantic type: 'audio' | 'plugin' | 'project' | 'preset' | 'folder' | 'other' */
    file_type: string;
    is_directory: boolean;
}

/** Scan a folder for ALL file types (audio, plugins, projects, presets, folders). */
export const scanFolderAll = (path: string) =>
    invoke<BrowserFileEntry[]>('scan_folder_all', { path });

/** Scan system VST2/VST3/AU paths for installed plugins. */
export const scanPluginFolders = () =>
    invoke<BrowserFileEntry[]>('scan_plugin_folders');

/** Get user-added browser folder paths from settings. */
export const getBrowserFolders = () =>
    invoke<string[]>('get_browser_folders');

/** Open native folder picker, add to browser PLACES, persist. Returns updated list. */
export const addBrowserFolder = () =>
    invoke<string[]>('add_browser_folder');

/** Remove a folder from browser PLACES. Returns updated list. */
export const removeBrowserFolder = (path: string) =>
    invoke<string[]>('remove_browser_folder', { path });

/** Get resolved samples folder path (lightweight, no mutex). */
export const getSamplesPath = () =>
    invoke<string>('get_samples_path');

/** Open a native folder picker dialog. Returns null if cancelled. */
export const pickFolder = () =>
    invoke<string | null>('pick_folder');

/** Open a native file picker filtered to .ddpj files. Returns null if cancelled. */
export const pickProjectFile = () =>
    invoke<string | null>('pick_project_file');

/** Open a native save dialog for .ddpj files. Returns null if cancelled. */
export const saveProjectDialog = () =>
    invoke<string | null>('save_project_dialog');

// ── Waveform Peaks ──────────────────────────────────────────────────────

/** A single min/max peak pair — mirrors Rust `PeakPair`. */
export interface PeakPair {
    min: number;
    max: number;
}

/** Waveform peaks at a single mip level — mirrors Rust `PeakMipLevel`. */
export interface PeakMipLevel {
    samples_per_peak: number;
    peaks: PeakPair[];
}

/** Multi-resolution waveform peak data — mirrors Rust `WaveformPeaks`. */
export interface WaveformPeaks {
    source_id: string;
    sample_rate: number;
    total_samples: number;
    mip_levels: PeakMipLevel[];
}

/** Get multi-resolution waveform peaks for a loaded audio file. */
export const getWaveformPeaks = (filePath: string) =>
    invoke<WaveformPeaks>('get_waveform_peaks', { filePath });

// ── Binary-Optimized Waveform Peaks ──────────────────────────────────────

/** Wire format for the binary-optimized waveform peaks response. */
interface WaveformPeaksBinaryResponse {
    source_id: string;
    sample_rate: number;
    total_samples: number;
    mip_levels: Array<{
        samples_per_peak: number;
        peak_count: number;
        float_offset: number;
    }>;
    /** All peaks as base64-encoded little-endian f32 buffer: [min, max, min, max, ...] */
    peaks_base64: string;
}

/**
 * Get waveform peaks via binary-optimized IPC (base64-encoded Float32Array).
 *
 * ~80% smaller payload than JSON. Returns the same `WaveformPeaks` interface
 * for backward compatibility with `WaveformCache`.
 */
export async function getWaveformPeaksBinary(filePath: string): Promise<WaveformPeaks> {
    const raw = await invoke<WaveformPeaksBinaryResponse>(
        'get_waveform_peaks_binary',
        { filePath },
    );

    // Decode base64 → Uint8Array → Float32Array
    const binaryString = atob(raw.peaks_base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    const floats = new Float32Array(bytes.buffer);

    // Reconstruct PeakMipLevel[] from flat buffer using offsets
    const mip_levels: PeakMipLevel[] = raw.mip_levels.map((meta) => {
        const peaks: PeakPair[] = new Array(meta.peak_count);
        for (let i = 0; i < meta.peak_count; i++) {
            const idx = meta.float_offset + i * 2;
            peaks[i] = { min: floats[idx], max: floats[idx + 1] };
        }
        return {
            samples_per_peak: meta.samples_per_peak,
            peaks,
        };
    });

    return {
        source_id: raw.source_id,
        sample_rate: raw.sample_rate,
        total_samples: raw.total_samples,
        mip_levels,
    };
}

// ── Clip Editing ─────────────────────────────────────────────────────────

/** Response from splitting a clip — contains the IDs of both halves. */
export interface SplitClipResponse {
    left_id: string;
    right_id: string;
}

export interface DuplicateClipResponse {
    new_id: string;
}

export interface MergeClipsResponse {
    new_id: string;
}

/** Move a clip to a new track and/or position (sample frames). */
export const moveClip = (clipId: string, newTrackIndex: number, newPositionFrames: number) =>
    invoke<void>('move_clip_cmd', { clipId, newTrackIndex, newPositionFrames });

/** Split a clip at the given sample frame. Returns IDs of both halves. */
export const splitClip = (clipId: string, splitFrame: number) =>
    invoke<SplitClipResponse>('split_clip_cmd', { clipId, splitFrame });

/** Duplicate a clip (optionally to a specific destination frame). */
export const duplicateClip = (clipId: string, newPositionFrames?: number) =>
    invoke<DuplicateClipResponse>('duplicate_clip_cmd', {
        clipId,
        newPositionFrames: newPositionFrames ?? null,
    });

/** Merge multiple clips into one on the same track. */
export const mergeClips = (clipIds: string[]) =>
    invoke<MergeClipsResponse>('merge_clips_cmd', { clipIds });

/** Delete a clip by UUID. */
export const deleteClip = (clipId: string) =>
    invoke<void>('delete_clip_cmd', { clipId });

// ── Audio Device Management ─────────────────────────────────────────────

/** Available audio devices on the system. */
export interface AudioDevices {
    outputs: string[];
    inputs: string[];
}

/** List all available audio input and output devices (real hardware). */
export const getAudioDevices = () =>
    invoke<AudioDevices>('get_audio_devices');

/** Request engine to switch to a named audio device. */
export const setAudioDevice = (deviceName: string) =>
    invoke<void>('set_audio_device', { deviceName });

/** Force hot-restart audio engine on a named output device. */
export const restartAudioEngine = (deviceName: string) =>
    invoke<void>('restart_audio_engine', { deviceName });

// ── Plugin Window Management ────────────────────────────────────────────

/** Open the native VST/AU plugin GUI window (OS-level C++ window, not webview).
 *  The Rust host creates a platform-native parent window and embeds the plugin
 *  editor view inside it. Window lifecycle is managed by the host. */
export const openPluginWindow = (pluginId: string) =>
    invoke<void>('open_plugin_window', { pluginId });

/** Editor capability probe. Allows UI to fail fast with a clear reason. */
export interface PluginEditorCapability {
    supported: boolean;
    reason?: string | null;
}

export const canOpenPluginEditor = (pluginId: string) =>
    invoke<PluginEditorCapability>('can_open_plugin_editor', { pluginId });

/** Close an open plugin window. */
export const closePluginWindow = (pluginId: string) =>
    invoke<void>('close_plugin_window', { pluginId });

/** Send a frontend crash/error payload to backend unified logs. */
export const logFrontendError = (module: string, error: string, stack?: string) =>
    invoke<void>('log_frontend_error', { module, error, stack: stack ?? null });

// ── Track Routing (DAG Topology) ────────────────────────────────────────

/** Routing target descriptor. */
export interface RoutingTarget {
    trackId: string;
    trackName: string;
    trackType: string;
}

/** Get available routing targets for a track. */
export const getRoutingTargets = (trackId: string) =>
    invoke<RoutingTarget[]>('get_routing_targets', { trackId });

/** Set the audio output routing for a track.
 *  This triggers an ATOMIC rebuild of the audio DAG on the Rust side.
 *  Passing 'master' routes directly to the master bus. */
export const setTrackRouting = (trackId: string, targetId: string) =>
    invoke<void>('set_track_routing_cmd', { trackId, targetId });

/** Set the audio input source for a track (for sidechain / recording input). */
export const setTrackInput = (trackId: string, inputId: string) =>
    invoke<void>('set_track_input_cmd', { trackId, inputId });

/** Add plugin to track chain (instrument/effect). */
export const addPluginToTrack = (
    trackId: string,
    pluginId: string,
    pluginName: string,
    slot: 'instrument' | 'effect' | 'auto' = 'auto',
) =>
    invoke<void>('add_plugin_to_track_cmd', {
        payload: { trackId, pluginId, pluginName, slot },
    });

/** Remove plugin slot from track chain by slot id. */
export const removePluginFromTrack = (trackId: string, slotId: string) =>
    invoke<void>('remove_plugin_from_track_cmd', {
        payload: { trackId, slotId },
    });

/** Set an internal plugin parameter (Utility/Sampler/EQ UI -> backend state). */
export const setInternalPluginParam = (
    trackId: string,
    slotId: string,
    paramId: string,
    value: number,
) =>
    invoke<void>('set_internal_plugin_param_cmd', {
        payload: { trackId, slotId, paramId, value },
    });

/** Assign sample file to track sampler and push into realtime sampler snapshot. */
export const setSamplerSample = (
    trackId: string,
    samplePath: string,
    rootNote?: number,
) =>
    invoke<void>('set_sampler_sample_cmd', {
        payload: { trackId, samplePath, rootNote: rootNote ?? null },
    });

// ── Clip Fades ──────────────────────────────────────────────────────────

/** Set fade-in and fade-out durations for a clip (in sample frames). */
export const setClipFades = (clipId: string, fadeInFrames: number, fadeOutFrames: number) =>
    invoke<void>('set_clip_fades_cmd', { clipId, fadeInFrames, fadeOutFrames });

/** Set source offset for a clip (slip editing — waveform slides inside clip frame). */
export const setClipSourceOffset = (clipId: string, sourceOffsetFrames: number) =>
    invoke<void>('set_clip_source_offset_cmd', { clipId, sourceOffsetFrames });

// ── Export / Bounce ─────────────────────────────────────────────────────

/** Export settings passed to the offline render pipeline. */
export interface ExportSettings {
    outputPath: string;
    sampleRate: 44100 | 48000 | 96000;
    bitDepth: 16 | 24 | 32;
    /** 'full' renders entire project, 'loop' renders only the loop region. */
    range: 'full' | 'loop';
    normalize: boolean;
    tailMs: number;
}

/** Kick off an offline bounce/export. Rust disables the realtime cpal timer
 *  and spins the render loop at max CPU speed. Progress is emitted via
 *  'bounce_progress' Tauri event (payload: { progress: number 0..100 }). */
export const exportMix = (settings: ExportSettings) =>
    invoke<void>('export_mix_cmd', { settings });

/** Cancel an in-progress export/bounce operation. */
export const cancelExport = () =>
    invoke<void>('cancel_export_cmd');

// ── Undo / Redo ─────────────────────────────────────────────────────────

/** Undo the last project mutation. */
export const undo = () => invoke<void>('undo_cmd');

/** Redo the previously undone project mutation. */
export const redo = () => invoke<void>('redo_cmd');

// ── Recording ───────────────────────────────────────────────────────────

/** Arm a track for recording and start recording on play. */
export const armTrack = (trackIndex: number, armed: boolean) =>
    invoke<void>('arm_track_cmd', { trackIndex, armed });

/** Start recording on all armed tracks. Creates clips and streams audio.
 *  Live audio peaks are pushed via 'live_audio_peaks' event. */
export const startRecording = () =>
    invoke<void>('start_recording_cmd');

/** Stop recording and finalize the recorded clips. */
export const stopRecording = () =>
    invoke<void>('stop_recording_cmd');

// ── Media Offline / File Resolution ─────────────────────────────────────

/** Resolve a missing/offline media file by providing a new path. */
export const resolveMissingFile = (clipId: string, newPath: string) =>
    invoke<void>('resolve_missing_file_cmd', { clipId, newPath });

// ── Automation ──────────────────────────────────────────────────────────

/** A single automation breakpoint sent to the engine. */
export interface AutomationPoint {
    beat: number;
    value: number;
    curveType: 'linear' | 'bezier' | 'step';
    /** Control point offset for Bézier curves (0..1 tension). */
    tension?: number;
}

/** Push automation breakpoints to the engine for a specific parameter.
 *  MUST be called through lodash.throttle(fn, 16) to cap at 60 IPC/s. */
export const setAutomationPoints = (trackId: string, paramId: string, points: AutomationPoint[]) =>
    invoke<void>('set_automation_points_cmd', { trackId, paramId, points });
