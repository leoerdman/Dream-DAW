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
    bpm: number;
    loop_enabled: boolean;
    loop_start: number;
    loop_end: number;
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

/** Mute/unmute a track. */
export const setTrackMute = (trackIndex: number, muted: boolean) =>
    invoke<void>('set_track_mute', { trackIndex, muted });

/** Solo/unsolo a track. */
export const setTrackSolo = (trackIndex: number, soloed: boolean) =>
    invoke<void>('set_track_solo', { trackIndex, soloed });

/** Batch update a track's state. */
export const updateTrack = (update: TrackStateUpdate) =>
    invoke<void>('update_track', { update });

/** Add a new audio track to the project. Auto-names if name is null. */
export const addTrack = (name?: string) =>
    invoke<void>('add_track_cmd', { name: name ?? null });

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

// ── Clip Editing ─────────────────────────────────────────────────────────

/** Response from splitting a clip — contains the IDs of both halves. */
export interface SplitClipResponse {
    left_id: string;
    right_id: string;
}

/** Move a clip to a new track and/or position (sample frames). */
export const moveClip = (clipId: string, newTrackIndex: number, newPositionFrames: number) =>
    invoke<void>('move_clip_cmd', { clipId, newTrackIndex, newPositionFrames });

/** Split a clip at the given sample frame. Returns IDs of both halves. */
export const splitClip = (clipId: string, splitFrame: number) =>
    invoke<SplitClipResponse>('split_clip_cmd', { clipId, splitFrame });

/** Delete a clip by UUID. */
export const deleteClip = (clipId: string) =>
    invoke<void>('delete_clip_cmd', { clipId });
