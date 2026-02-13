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

/** Application settings — mirrors Rust `AppSettings`. */
export interface AppSettings {
    language: string;
    startup_behavior: string;
    waveform_style: string;
    driver_type: string;
    output_device: string;
    input_device: string;
    sample_rate: number;
    buffer_size: number;
    driver_error_compensation: number;
    test_tone_enabled: boolean;
    test_tone_volume: number;
    test_tone_frequency: number;
    cpu_usage_simulator: boolean;
    sr_pitch_conversion: boolean;
    user_folder_path: string;
    samples_path: string;
    vst2_path: string;
    vst3_path: string;
}

/** Recent project entry. */
export interface RecentProject {
    name: string;
    path: string;
    last_opened: string;
}

/** Project status response. */
export interface ProjectStatus {
    name: string;
    has_file: boolean;
    is_dirty: boolean;
    file_path: string | null;
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
export const importAudioFile = (path: string, trackIndex: number) =>
    invoke<ImportAudioResponse>('import_audio_file', { path, trackIndex });

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
