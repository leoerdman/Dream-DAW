// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Engine Store (Zustand)
// ═══════════════════════════════════════════════════════════════════════════
//
// The Global Brain. Single source of truth for the React UI.
//
// Architecture:
//   1. UI calls an ACTION (e.g., togglePlay)
//   2. Action sends IPC command to Rust engine
//   3. Backend emits push telemetry events (`telemetry_tick`) at ~30fps
//   4. Store updates → React re-renders
//
// ═══════════════════════════════════════════════════════════════════════════

import { create } from 'zustand';
import throttle from 'lodash.throttle';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import * as engine from '@/shared/api/engine';
import { frameToBeat } from '@/shared/lib/audioMath';
import type { SampleRackConfig } from '@/shared/types/SampleRackConfig';
import type {
    TransportState,
    MeteringSnapshot,
    ImportAudioResponse,
    ProjectHistoryEvent,
    PluginSandboxSnapshot,
} from '@/shared/api/engine';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import { useGridStore } from '@/shared/stores/useGridStore';

/** Track info from Rust project. */
export interface ProjectTrack {
    id: string;
    name: string;
    track_type: string; // "Audio" | "Midi" | "Group" | "Master" (from Rust TrackType)
    color: string;
    volume: number;
    pan: number;
    is_mute: boolean;
    is_solo: boolean;
    is_armed: boolean;
    /** Persisted arrangement row height in px. */
    height: number;
    /** Output routing target track ID (or 'master'). */
    output: string;
    /** Input routing source ID (or 'none'/'ext-1'/'ext-2'). */
    input: string;
    /** Parent group track ID (if this track is grouped). */
    parent_track_id?: string | null;
    /** Child track IDs (for group tracks). */
    child_track_ids?: string[];
    /** Group expanded/collapsed state (for group tracks). */
    is_expanded?: boolean;
    /** Effect plugin chain (insert slots). */
    effects: Array<{
        id: string;
        name: string;
        plugin_id: string;
        is_bypassed: boolean;
    }>;
    /** Instrument slot for MIDI tracks (optional). */
    instrument: {
        id: string;
        name: string;
        plugin_id: string;
        is_bypassed: boolean;
    } | null;
    /** Sampler state for internal sampler instrument, if present. */
    sampler: {
        sample_path: string;
        root_note: number;
        volume: number;
        attack: number;
        decay: number;
        sustain: number;
        release: number;
        osc2_waveform?: number;
        osc_mix?: number;
        detune_cents?: number;
        sub_level?: number;
    } | null;
    /** 16-Pad Sample Rack (Drum Rack) instrument. */
    sample_rack?: SampleRackConfig | null;
    /** Automation lanes carrying persisted param values (volume, pan, internal plugin params). */
    automation_lanes: Array<{
        param_id: string;
        points: Array<{
            beat: number;
            value: number;
            curve_type?: string;
            tension?: number;
        }>;
    }>;
}

// ── Track color mapping (matches Rust TrackColor enum hex values) ─────────

const TRACK_COLORS: Record<string, string> = {
    Coral: '#F05C4D',
    Orange: '#FF8A1A',
    Gold: '#FFBF33',
    Yellow: '#FFE14D',
    Lime: '#A3D94D',
    Green: '#4DC775',
    Teal: '#4DC7B0',
    Cyan: '#4DC7CC',
    Sky: '#4DA6E3',
    Blue: '#4D7AE3',
    Indigo: '#6B5CE3',
    Purple: '#9B59D9',
    Magenta: '#D94DA6',
    Pink: '#E36B96',
    Rose: '#E66673',
    Slate: '#8C949E',
};

function resolveTrackColor(color: unknown): string {
    if (typeof color === 'string') {
        // Pass through raw hex colors (e.g. from Ableton imports)
        if (color.startsWith('#')) return color;
        return TRACK_COLORS[color] ?? '#667788';
    }
    return '#667788';
}

const throttledVolumeSends = new Map<number, (volume: number) => void>();
const throttledPanSends = new Map<number, (pan: number) => void>();
const pendingVolumeValues = new Map<number, number>();
const pendingPanValues = new Map<number, number>();
let pendingMasterVolume: number | null = null;
let projectFetchSeq = 0;
/** Re-entry guard: prevents recursive fetchProject calls triggered by
 *  synchronous React re-renders inside zustand's set() → useSyncExternalStore. */
let _isFetchingProject = false;
/** Module-level guard for startTelemetryLoop. Prevents re-entry from
 *  synchronous React re-renders triggered by zustand set() inside the call.
 *  The store-level `telemetryRunning` flag races with set() — React fires
 *  forceStoreRerender BEFORE zustand updates the state, so get().telemetryRunning
 *  still reads false on re-entry. This module-level flag is set BEFORE set(). */
let _telemetryStarted = false;
/** Timestamp (ms) until which telemetry BPM updates are suppressed (BUG-3 fix). */
let _bpmPendingUntil = 0;
/** PERF-FIX: Debounce timer for fetchProject calls.
 *  Coalesces rapid-fire UI actions (e.g. addTrack, deleteTrack, rename)
 *  into a single project re-fetch after a 100ms quiet window. */
let _fetchProjectDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const FETCH_PROJECT_DEBOUNCE_MS = 100;
const PROJECT_HISTORY_WINDOW = 256;
const PROJECT_HISTORY_SYNC_EVERY_TICKS = 15; // telemetry is ~30fps
/** PERF-FIX: Only push meter data to React state every N ticks.
 *  At 30fps telemetry, N=5 gives ~6fps meter re-renders — smooth enough
 *  for VU meters while preventing catastrophic re-render storms.
 *  Raw 30fps data is always available via _latestMeters. */
const METER_STATE_UPDATE_EVERY_TICKS = 5;
let _meterFrameCounter = 0;
/** Latest raw meter snapshot (30fps), bypasses React state for perf. */
let _latestMeters: MeteringSnapshot | null = null;
/** rAF batching: pending Zustand updates coalesced across multiple Tauri ticks. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pendingUpdate: Record<string, any> = {};
let _rafPending = false;
/** Get the latest meter snapshot without causing React re-renders. */
export function getMetersRef(): MeteringSnapshot {
    return _latestMeters ?? useEngineStore.getState().meters;
}
const DEBUG_PROJECT_FETCH =
    (typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV))
    || (typeof window !== 'undefined' && (window as Window & { __dreamDebugProjectFetch?: boolean }).__dreamDebugProjectFetch === true);
const throttledMasterVolumeSend = throttle((volume: number) => {
    void engine.setMasterVolume(volume);
}, 16);

function mergeProjectHistory(
    current: ProjectHistoryEvent[],
    currentCursor: number,
    delta: ProjectHistoryEvent[],
): { history: ProjectHistoryEvent[]; cursor: number } {
    if (delta.length === 0) {
        return { history: current, cursor: currentCursor };
    }
    const firstSeq = delta[0].seq;
    const shouldReplace = current.length === 0 || firstSeq <= currentCursor;
    const merged = shouldReplace ? delta : [...current, ...delta];
    const history = merged.length > PROJECT_HISTORY_WINDOW
        ? merged.slice(-PROJECT_HISTORY_WINDOW)
        : merged;
    const cursor = delta[delta.length - 1].seq;
    return { history, cursor };
}

// ── Store Types ──────────────────────────────────────────────────────────

interface EngineStore {
    // ── State ────────────────────────────────────────────────────────────
    /** Whether push telemetry listener has started. */
    telemetryRunning: boolean;

    /** Whether we've successfully connected to the engine at least once. */
    connected: boolean;

    /** Transport state from the Rust engine. */
    transport: TransportState;

    /** VU meter readings from the Rust engine. */
    meters: MeteringSnapshot;

    /** Timeline clips converted from project (sample frames → beats). */
    timelineClips: TimelineClip[];

    /** Track metadata from project. */
    projectTracks: ProjectTrack[];

    /** Project sample rate (for beat conversion). */
    projectSampleRate: number;

    /** Authoritative project BPM from PulseMap (race-safe — not from telemetry). */
    projectBpm: number;

    /** Key signature state from project. */
    keySigEnabled: boolean;
    keySigTonic: string;
    keySigMode: string;

    /** Last IPC error (for error boundary / status bar display). */
    lastError: string | null;
    /** Recent event-sourcing journal entries from backend. */
    projectHistory: ProjectHistoryEvent[];
    /** Last seen backend history sequence number (incremental sync cursor). */
    projectHistoryCursor: number;
    /** Master fader volume (linear gain 0.0..2.0). */
    masterVolume: number;
    /** Runtime state of out-of-process plugin sandbox supervisor. */
    pluginSandbox: PluginSandboxSnapshot | null;

    /** Track native plugin editor states: Record<trackId, Set<slotId>> (idempotent SSOT). */
    openEditorsByTrack: Record<string, Set<string>>;

    // ── Actions ──────────────────────────────────────────────────────────

    /** Start/stop playback. Sends IPC command, then push telemetry syncs state. */
    togglePlay: () => Promise<void>;

    /** Start playback. */
    play: () => Promise<void>;

    /** Stop playback. */
    stop: () => Promise<void>;

    /** Change BPM. Optimistically updates local state, then sends to engine. */
    setBpm: (bpm: number) => Promise<void>;

    /** Seek to a position in seconds. */
    seekSeconds: (seconds: number) => Promise<void>;

    /** Seek to a beat position (precision: single conversion on Rust side). */
    seekToBeat: (beat: number) => Promise<void>;

    /** Set loop region. */
    setLoop: (enabled: boolean, startFrames: number, endFrames: number) => Promise<void>;

    /** Set test tone frequency (debug). */
    setFrequency: (freq: number) => Promise<void>;

    /** Track control: set volume. */
    setTrackVolume: (trackIndex: number, volume: number) => Promise<void>;

    /** Track control: set pan. */
    setTrackPan: (trackIndex: number, pan: number) => Promise<void>;
    /** Master control: set volume. */
    setMasterVolume: (volume: number) => Promise<void>;
    /** Flush final unthrottled track control values (call on mouse/pointer up). */
    flushTrackControlFinals: () => Promise<void>;

    /** Track control: mute/unmute. */
    setTrackMute: (trackIndex: number, muted: boolean) => Promise<void>;

    /** Track control: solo/unsolo. */
    setTrackSolo: (trackIndex: number, soloed: boolean) => Promise<void>;

    /** Add a new track to the project. */
    addTrack: (name?: string) => Promise<void>;

    /** Delete a track by its zero-based index. */
    deleteTrack: (index: number) => Promise<void>;

    /** Rename a track by its zero-based index. */
    renameTrack: (index: number, name: string) => Promise<void>;

    /** Import an audio file onto a track, optionally at a specific position. */
    importFile: (path: string, trackIndex: number, positionFrames?: number) => Promise<ImportAudioResponse | null>;

    /** Create an empty MIDI clip on a track at a given position. */
    createMidiClip: (trackIndex: number, positionFrames: number, durationFrames: number) => Promise<void>;

    /** Fetch project state from Rust and convert to timeline format. */
    fetchProject: (reason?: string) => Promise<void>;
    /** Incrementally sync project history journal without full project fetch. */
    syncProjectHistory: () => Promise<void>;

    /** Expand window from splash to full DAW mode. */
    expandWindow: () => Promise<void>;

    /** Start push telemetry listener (called once at app startup). */
    startTelemetryLoop: () => void;

    /** Stop push telemetry listener. */
    stopTelemetryLoop: () => void;

    /** Toggle native plugin window visibility. Enforces SSOT and prevents double-close. */
    togglePluginEditor: (trackId: string, slotId: string) => Promise<void>;
    /** Close all open native editors across all tracks (cleanup). */
    closeAllPluginEditors: () => Promise<void>;
}

// ── Default Values ───────────────────────────────────────────────────────

const DEFAULT_TRANSPORT: TransportState = {
    is_playing: false,
    position_frames: 0,
    position_seconds: 0,
    position_beats: 0,
    bpm: 120,
    sample_rate: 44100,
    loop_enabled: false,
    loop_start: 0,
    loop_end: 0,
    output_latency_frames: 0,
    telemetry_timestamp_ms: 0,
};

const DEFAULT_METER: engine.MeterReading = {
    rms: -160,
    peak: -160,
    clipping: false,
};

const DEFAULT_METERS: MeteringSnapshot = {
    tracks: [],
    master_left: { ...DEFAULT_METER },
    master_right: { ...DEFAULT_METER },
};

// ── Telemetry Loop Control ───────────────────────────────────────────────

let _telemetryUnlisten: UnlistenFn | null = null;
let _pluginSandboxUnlisten: UnlistenFn | null = null;

// ── Store Creation ───────────────────────────────────────────────────────

export const useEngineStore = create<EngineStore>((set, get) => ({
    // ── Initial State ──────────────────────────────────────────────────
    telemetryRunning: false,
    connected: false,
    transport: { ...DEFAULT_TRANSPORT },
    meters: { ...DEFAULT_METERS },
    timelineClips: [],
    projectTracks: [],
    projectSampleRate: 44100,
    projectBpm: 120,
    keySigEnabled: false,
    keySigTonic: 'C',
    keySigMode: 'Major',
    lastError: null,
    projectHistory: [],
    projectHistoryCursor: 0,
    masterVolume: 1.0,
    pluginSandbox: null,
    openEditorsByTrack: {},

    // ── Transport Actions ──────────────────────────────────────────────

    togglePlay: async () => {
        try {
            const isPlaying = await engine.togglePlayback();
            set((s) => ({
                transport: { ...s.transport, is_playing: isPlaying },
                lastError: null,
            }));
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    play: async () => {
        try {
            await engine.play();
            set((s) => ({
                transport: { ...s.transport, is_playing: true },
                lastError: null,
            }));
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    stop: async () => {
        try {
            await engine.stop();
            set((s) => ({
                transport: { ...s.transport, is_playing: false },
                lastError: null,
            }));
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    setBpm: async (bpm: number) => {
        // Optimistic update — UI responds instantly.
        // Keep transport + project tempo in sync to avoid frame↔beat mismatches
        // during drag/move/loop calculations before the next project refresh.
        set((s) => ({ transport: { ...s.transport, bpm }, projectBpm: bpm }));
        // BUG-3 fix: suppress telemetry BPM overwrites for 500ms so the
        // optimistic value isn't immediately flickered back to the old BPM.
        _bpmPendingUntil = Date.now() + 500;
        try {
            await engine.setBpm(bpm);
            // PERF-FIX (BUG-P3): Debounced fetchProject to coalesce rapid BPM
            // changes (e.g. dragging the BPM knob). Previously called synchronously
            // which triggered full project clone + JSON serialize + IPC on every drag frame.
            if (_fetchProjectDebounceTimer) clearTimeout(_fetchProjectDebounceTimer);
            _fetchProjectDebounceTimer = setTimeout(
                () => void get().fetchProject('setBpm'),
                FETCH_PROJECT_DEBOUNCE_MS,
            );
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    seekSeconds: async (seconds: number) => {
        try {
            await engine.seekSeconds(seconds);
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    seekToBeat: async (beat: number) => {
        try {
            await engine.seekToBeat(beat);
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    setLoop: async (enabled: boolean, startFrames: number, endFrames: number) => {
        set((s) => ({
            transport: { ...s.transport, loop_enabled: enabled, loop_start: startFrames, loop_end: endFrames },
        }));
        try {
            await engine.setLoop(enabled, startFrames, endFrames);
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    setFrequency: async (freq: number) => {
        try {
            await engine.setFrequency(freq);
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    // ── Track Actions ──────────────────────────────────────────────────

    setTrackVolume: async (trackIndex: number, volume: number) => {
        try {
            pendingVolumeValues.set(trackIndex, volume);
            if (!throttledVolumeSends.has(trackIndex)) {
                throttledVolumeSends.set(
                    trackIndex,
                    throttle((nextVolume: number) => {
                        void engine.setTrackVolume(trackIndex, nextVolume).catch((e) => {
                            set({ lastError: String(e) });
                        });
                    }, 16),
                );
            }
            throttledVolumeSends.get(trackIndex)?.(volume);
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    setTrackPan: async (trackIndex: number, pan: number) => {
        try {
            pendingPanValues.set(trackIndex, pan);
            if (!throttledPanSends.has(trackIndex)) {
                throttledPanSends.set(
                    trackIndex,
                    throttle((nextPan: number) => {
                        void engine.setTrackPan(trackIndex, nextPan).catch((e) => {
                            set({ lastError: String(e) });
                        });
                    }, 16),
                );
            }
            throttledPanSends.get(trackIndex)?.(pan);
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    setMasterVolume: async (volume: number) => {
        try {
            const clamped = Math.max(0, Math.min(2, volume));
            pendingMasterVolume = clamped;
            set({ masterVolume: clamped });
            throttledMasterVolumeSend(clamped);
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    flushTrackControlFinals: async () => {
        try {
            const volumeEntries = Array.from(pendingVolumeValues.entries());
            const panEntries = Array.from(pendingPanValues.entries());

            await Promise.all([
                ...volumeEntries.map(([trackIndex, volume]) => engine.setTrackVolume(trackIndex, volume)),
                ...panEntries.map(([trackIndex, pan]) => engine.setTrackPan(trackIndex, pan)),
            ]);
            if (pendingMasterVolume != null) {
                await engine.setMasterVolume(pendingMasterVolume);
            }

            pendingVolumeValues.clear();
            pendingPanValues.clear();
            pendingMasterVolume = null;
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    setTrackMute: async (trackIndex: number, muted: boolean) => {
        // Optimistic update — UI reflects state instantly.
        // PERF-FIX: No fetchProject() — this only toggles a boolean.
        // The backend persists via EngineCommand; full project re-fetch
        // was causing heavy Mutex lock + JSON serialization on every click.
        set((s) => ({
            projectTracks: s.projectTracks.map((t, i) =>
                i === trackIndex ? { ...t, is_mute: muted } : t
            ),
        }));
        try {
            await engine.setTrackMute(trackIndex, muted);
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    setTrackSolo: async (trackIndex: number, soloed: boolean) => {
        // Optimistic update — UI reflects state instantly.
        // PERF-FIX: No fetchProject() — this only toggles a boolean.
        set((s) => ({
            projectTracks: s.projectTracks.map((t, i) =>
                i === trackIndex ? { ...t, is_solo: soloed } : t
            ),
        }));
        try {
            await engine.setTrackSolo(trackIndex, soloed);
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    // ── Audio Import ───────────────────────────────────────────────────

    addTrack: async (name?: string) => {
        try {
            await engine.addTrack(name);
            // PERF-FIX: Debounced fetchProject to coalesce rapid topology changes.
            if (_fetchProjectDebounceTimer) clearTimeout(_fetchProjectDebounceTimer);
            _fetchProjectDebounceTimer = setTimeout(() => void get().fetchProject('addTrack'), FETCH_PROJECT_DEBOUNCE_MS);
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    deleteTrack: async (index: number) => {
        try {
            await engine.deleteTrack(index);

            // BUG-17: Prune stale throttles to prevent memory leaks.
            throttledVolumeSends.clear();
            throttledPanSends.clear();
            pendingVolumeValues.clear();
            pendingPanValues.clear();

            // PERF-FIX: Debounced fetchProject.
            if (_fetchProjectDebounceTimer) clearTimeout(_fetchProjectDebounceTimer);
            _fetchProjectDebounceTimer = setTimeout(() => void get().fetchProject('deleteTrack'), FETCH_PROJECT_DEBOUNCE_MS);
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    renameTrack: async (index: number, name: string) => {
        try {
            await engine.renameTrack(index, name);
            // PERF-FIX: Debounced fetchProject.
            if (_fetchProjectDebounceTimer) clearTimeout(_fetchProjectDebounceTimer);
            _fetchProjectDebounceTimer = setTimeout(() => void get().fetchProject('renameTrack'), FETCH_PROJECT_DEBOUNCE_MS);
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    importFile: async (path: string, trackIndex: number, positionFrames?: number) => {
        try {
            const response = await engine.importAudioFile(path, trackIndex, positionFrames);
            console.log(
                `[Engine] Imported '${response.clip_name}' → track ${trackIndex} (${response.duration_seconds.toFixed(1)}s)`,
            );
            // Refresh project state so Timeline shows the new clip
            await get().fetchProject('importFile');
            return response;
        } catch (err) {
            const msg = `Import failed: ${err}`;
            console.error(`[Engine] ${msg}`);
            set({ lastError: msg });
            return null;
        }
    },

    createMidiClip: async (trackIndex: number, positionFrames: number, durationFrames: number) => {
        try {
            const response = await engine.createMidiClip(trackIndex, positionFrames, durationFrames);
            console.log(
                `[Engine] Created MIDI clip '${response.clip_name}' → track ${trackIndex} @ frame ${positionFrames}`,
            );
            // PERF-FIX: Debounced fetchProject.
            if (_fetchProjectDebounceTimer) clearTimeout(_fetchProjectDebounceTimer);
            _fetchProjectDebounceTimer = setTimeout(() => void get().fetchProject('createMidiClip'), FETCH_PROJECT_DEBOUNCE_MS);
        } catch (err) {
            const msg = `Create MIDI clip failed: ${err}`;
            console.error(`[Engine] ${msg}`);
            set({ lastError: msg });
        }
    },

    // ── Project Sync ───────────────────────────────────────────────────

    fetchProject: async (reason: string = 'manual') => {
        // BUG-FIX: Re-entry guard prevents infinite loop.
        // zustand set() → useSyncExternalStore → synchronous React re-render →
        // Tauri IPC callback resolves → fetchProject called again → "Maximum
        // update depth exceeded". The lock breaks this synchronous cycle.
        if (_isFetchingProject) {
            console.debug(`[fetchProject] BLOCKED re-entry reason="${reason}" — already in progress`);
            return;
        }
        _isFetchingProject = true;
        const requestSeq = ++projectFetchSeq;
        console.debug(`[fetchProject] START #${requestSeq} reason="${reason}"`);
        if (DEBUG_PROJECT_FETCH) {
            console.debug(`[ProjectFetch] start #${requestSeq} reason=${reason}`);
        }
        try {
            const historyCursor = get().projectHistoryCursor;
            const [project, projectHistoryDelta] = await Promise.all([
                engine.getProject() as Promise<{
                    name?: string;
                    tracks: Array<{
                        id: string;
                        name: string;
                        track_type: string;
                        color: unknown;
                        color_hex?: string | null;
                        volume: number;
                        pan: number;
                        is_mute: boolean;
                        is_solo: boolean;
                        output_destination_id?: string | null;
                        input_source_id?: string | null;
                        parent_track_id?: string | null;
                        child_track_ids?: string[];
                        is_expanded?: boolean;
                        effects?: Array<{
                            id: string;
                            name: string;
                            plugin_id: string;
                            is_bypassed: boolean;
                        }>;
                        instrument?: {
                            id: string;
                            name: string;
                            plugin_id: string;
                            is_bypassed: boolean;
                        } | null;
                        clips: Array<{
                            id: string;
                            name: string;
                            file_path: string;
                            position: { sample_frame: number };
                            duration: { sample_frame: number };
                            source_offset: { sample_frame: number };
                            is_warped?: boolean;
                            warp_mode?: number | null;
                            warp_base_bpm?: number;
                            warp_source_duration_frames?: number;
                            color_override: unknown;
                            color_hex?: string | null;
                            is_offline?: boolean;
                        }>;
                        midi_clips?: Array<{
                            id: string;
                            name: string;
                            position: { sample_frame: number };
                            duration: { sample_frame: number };
                            notes?: Array<{
                                pitch: number;
                                velocity: number;
                                start_frame: number;
                                duration_frames: number;
                            }>;
                            color_override?: unknown;
                            color_hex?: string | null;
                        }>;
                    }>;
                    sample_rate: number;
                    pulse_map: { tempo_events: Array<{ bpm: number }>; sample_rate: number };
                    arrangement_grid_numerator?: number;
                    arrangement_grid_denominator?: number;
                    arrangement_grid_ntoles?: number;
                    arrangement_snap_to_grid?: boolean;
                    arrangement_grid_fixed?: boolean;
                    key_sig_enabled?: boolean;
                    key_sig_tonic?: string;
                    key_sig_mode?: string;
                }>,
                engine.getProjectHistory({
                    limit: PROJECT_HISTORY_WINDOW,
                    sinceSeq: historyCursor > 0 ? historyCursor : undefined,
                }),
            ]);

            // Ignore stale/out-of-order responses (e.g. startup fetch resolving
            // after Open Project fetch). Latest invocation always wins.
            if (requestSeq !== projectFetchSeq) {
                console.debug(`[fetchProject] STALE #${requestSeq} reason="${reason}" latest=${projectFetchSeq} tracks=${project.tracks?.length ?? '?'} — DISCARDED`);
                if (DEBUG_PROJECT_FETCH) {
                    console.debug(`[ProjectFetch] stale #${requestSeq} reason=${reason} latest=${projectFetchSeq}`);
                }
                return;
            }
            console.debug(`[fetchProject] ACCEPTED #${requestSeq} reason="${reason}" tracks=${project.tracks?.length ?? '?'} name="${project.name ?? '?'}"`);

            // CRITICAL: Use the project's own PulseMap BPM as the authoritative SSOT
            // for frame↔beat conversion. transport.bpm may be stale immediately
            // after open_project until the next telemetry tick arrives.
            const bpm = project.pulse_map?.tempo_events?.[0]?.bpm || get().transport.bpm || 120;
            const sr = project.sample_rate || 44100;
            const toFiniteNumber = (value: unknown, fallback = 0): number => {
                if (typeof value === 'number') {
                    return Number.isFinite(value) ? value : fallback;
                }
                if (typeof value === 'bigint') {
                    return Number(value);
                }
                const parsed = Number(value);
                return Number.isFinite(parsed) ? parsed : fallback;
            };

            useGridStore.getState().applyProjectGrid({
                numerator: project.arrangement_grid_numerator ?? 1,
                denominator: project.arrangement_grid_denominator ?? 16,
                ntoles: project.arrangement_grid_ntoles ?? 2,
                snapToGrid: project.arrangement_snap_to_grid ?? true,
                fixed: project.arrangement_grid_fixed ?? false,
            });

            // Convert all clips from sample frames → beats
            const timelineClips: TimelineClip[] = [];
            const projectTracks: ProjectTrack[] = [];

            for (let trackIdx = 0; trackIdx < project.tracks.length; trackIdx++) {
                const track = project.tracks[trackIdx];
                const trackColor = track.color_hex || resolveTrackColor(track.color);
                const trackTypeRaw = (track.track_type ?? '').toString().toLowerCase();
                const isMidiTrack = trackTypeRaw === 'midi';

                projectTracks.push({
                    id: track.id,
                    name: track.name,
                    track_type: track.track_type || 'Audio',
                    color: trackColor,
                    volume: track.volume,
                    pan: track.pan,
                    is_mute: Boolean((track as Record<string, unknown>).is_mute ?? false),
                    is_solo: Boolean((track as Record<string, unknown>).is_solo ?? false),
                    // BUG-1 fix: use Boolean() for runtime coercion instead of `as boolean`
                    is_armed: Boolean((track as Record<string, unknown>).is_armed ?? false),
                    height: Number((track as Record<string, unknown>).height ?? 80),
                    output:
                        (track.output_destination_id && track.output_destination_id.length > 0
                            ? track.output_destination_id
                            : ((track as Record<string, unknown>).output as string)) || 'master',
                    input:
                        (track.input_source_id && track.input_source_id.length > 0
                            ? track.input_source_id
                            : ((track as Record<string, unknown>).input as string)) || 'none',
                    parent_track_id: (track as Record<string, unknown>).parent_track_id as string | null | undefined,
                    child_track_ids: ((track as Record<string, unknown>).child_track_ids as string[] | undefined) ?? [],
                    is_expanded: Boolean((track as Record<string, unknown>).is_expanded ?? true),
                    effects: track.effects ?? [],
                    instrument: track.instrument ?? null,
                    sampler: ((track as Record<string, unknown>).sampler as ProjectTrack['sampler']) ?? null,
                    sample_rack: ((track as Record<string, unknown>).sample_rack as ProjectTrack['sample_rack']) ?? null,
                    automation_lanes: (Array.isArray((track as Record<string, unknown>).automation_lanes)
                        ? (track as Record<string, unknown>).automation_lanes as ProjectTrack['automation_lanes']
                        : []),
                });

                for (const clip of track.clips) {
                    const posFrames = toFiniteNumber(clip.position.sample_frame, 0);
                    const durFrames = Math.max(1, toFiniteNumber(clip.duration.sample_frame, 1));
                    const isWarped = Boolean(clip.is_warped ?? false);
                    const warpBaseBpm = Math.max(20, toFiniteNumber(clip.warp_base_bpm, bpm));
                    const warpSourceDurationFrames = Math.max(1, toFiniteNumber(clip.warp_source_duration_frames, durFrames));
                    const sourceOffsetFrames = Math.max(0, toFiniteNumber(clip.source_offset?.sample_frame ?? 0, 0));
                    const fadeInFrames = Math.max(0, toFiniteNumber((clip as Record<string, unknown>).fade_in_frames ?? ((clip as Record<string, unknown>).fadeIn ?? 0), 0));
                    const fadeOutFrames = Math.max(0, toFiniteNumber((clip as Record<string, unknown>).fade_out_frames ?? ((clip as Record<string, unknown>).fadeOut ?? 0), 0));
                    const hasAudioPath = !!(clip.file_path && clip.file_path.trim().length > 0);
                    const treatAsMidi = isMidiTrack;
                    // BUG-6 fix: cache color resolution instead of calling twice
                    const clipColor = resolveTrackColor(clip.color_hex ?? clip.color_override);

                    timelineClips.push({
                        id: clip.id,
                        name: clip.name,
                        trackIndex: trackIdx,
                        startBeat: frameToBeat(posFrames, bpm, sr),
                        // BUG-2 fix: always use project BPM for timeline duration.
                        // durFrames already represents the timeline extent (Rust engine
                        // handles warp stretching via playback_rate in render_callback).
                        durationBeats: frameToBeat(durFrames, bpm, sr),
                        // Editor mode must follow track type:
                        // MIDI tracks -> piano roll, Audio tracks -> sample editor.
                        type: treatAsMidi ? 'midi' : 'audio',
                        color: clipColor !== '#667788' ? clipColor : trackColor,
                        filePath: treatAsMidi ? undefined : clip.file_path,
                        durationSamples: durFrames,
                        isWarped,
                        warpMode: clip.warp_mode ?? null,
                        warpBaseBpm,
                        warpSourceDurationFrames,
                        sourceOffset: sourceOffsetFrames,
                        fadeIn: fadeInFrames,
                        fadeOut: fadeOutFrames,
                        isOffline: treatAsMidi ? false : (hasAudioPath ? (clip.is_offline ?? false) : false),
                        // BUG-1 fix: Boolean() runtime coercion
                        muted: Boolean((clip as Record<string, unknown>).is_muted ?? false),
                    });
                }

                for (const clip of track.midi_clips ?? []) {
                    const posFrames = toFiniteNumber(clip.position.sample_frame, 0);
                    const durFrames = Math.max(1, toFiniteNumber(clip.duration.sample_frame, 1));
                    const fadeInFrames = Math.max(0, toFiniteNumber((clip as Record<string, unknown>).fade_in_frames ?? ((clip as Record<string, unknown>).fadeIn ?? 0), 0));
                    const fadeOutFrames = Math.max(0, toFiniteNumber((clip as Record<string, unknown>).fade_out_frames ?? ((clip as Record<string, unknown>).fadeOut ?? 0), 0));
                    // BUG-6 fix: cache color resolution
                    const midiClipColor = resolveTrackColor(clip.color_hex ?? clip.color_override);
                    timelineClips.push({
                        id: clip.id,
                        name: clip.name,
                        trackIndex: trackIdx,
                        startBeat: frameToBeat(posFrames, bpm, sr),
                        durationBeats: frameToBeat(durFrames, bpm, sr),
                        type: 'midi',
                        color: midiClipColor !== '#667788' ? midiClipColor : trackColor,
                        durationSamples: durFrames,
                        sourceOffset: 0,
                        fadeIn: fadeInFrames,
                        fadeOut: fadeOutFrames,
                        // BUG-1 fix: Boolean() runtime coercion
                        muted: Boolean((clip as Record<string, unknown>).is_muted ?? false),
                        midiNotes: (clip.notes ?? []).map((note, idx) => ({
                            id: `${clip.id}:${idx}:${note.pitch}:${note.start_frame}`,
                            pitch: note.pitch,
                            startBeat: frameToBeat(note.start_frame, bpm, sr),
                            durationBeats: frameToBeat(note.duration_frames, bpm, sr),
                            velocity: note.velocity,
                        })),
                        midiEnvelopes: (((clip as Record<string, unknown>).envelopes as Array<Record<string, unknown>> | undefined) ?? []).map((env) => ({
                            paramId: String(env.param_id ?? env.paramId ?? ''),
                            points: ((env.points as Array<Record<string, unknown>> | undefined) ?? []).map((p) => ({
                                beat: Number(p.beat ?? 0),
                                value: Number(p.value ?? 0),
                                curveType: String(p.curve_type ?? p.curveType ?? 'linear'),
                            })),
                        })),
                    });
                }
            }

            if (requestSeq === projectFetchSeq) {
                set((s) => ({
                    // Append incremental delta from backend history journal.
                    // Backend falls back to full slice when cursor becomes stale
                    // (e.g. after new/open project reset).
                    ...(() => {
                        const merged = mergeProjectHistory(
                            s.projectHistory,
                            s.projectHistoryCursor,
                            projectHistoryDelta,
                        );
                        return {
                            projectHistory: merged.history,
                            projectHistoryCursor: merged.cursor,
                        };
                    })(),
                    timelineClips,
                    projectTracks,
                    projectSampleRate: sr,
                    projectBpm: bpm,
                    keySigEnabled: project.key_sig_enabled ?? false,
                    keySigTonic: project.key_sig_tonic || 'C',
                    keySigMode: project.key_sig_mode || 'Major',
                    // Keep transport.bpm in sync so TransportBar/StatusBar
                    // show correct BPM immediately, even before next telemetry tick.
                    transport: { ...s.transport, bpm },
                }));
                if (DEBUG_PROJECT_FETCH) {
                    console.debug(
                        `[ProjectFetch] apply #${requestSeq} reason=${reason} tracks=${projectTracks.length} clips=${timelineClips.length} bpm=${bpm}`,
                    );
                }

                // BUG-23: Prune stale throttle closures for deleted tracks
                const validTrackIndices = new Set(projectTracks.map((_, i) => i));
                for (const key of throttledVolumeSends.keys()) {
                    if (!validTrackIndices.has(key)) throttledVolumeSends.delete(key);
                }
                for (const key of throttledPanSends.keys()) {
                    if (!validTrackIndices.has(key)) throttledPanSends.delete(key);
                }
                for (const key of pendingVolumeValues.keys()) {
                    if (!validTrackIndices.has(key)) pendingVolumeValues.delete(key);
                }
                for (const key of pendingPanValues.keys()) {
                    if (!validTrackIndices.has(key)) pendingPanValues.delete(key);
                }
            }
        } catch (e) {
            console.debug(`[fetchProject] ERROR #${requestSeq} reason="${reason}":`, e);
            console.error('[Engine] fetchProject failed:', e);
            if (DEBUG_PROJECT_FETCH) {
                console.debug(`[ProjectFetch] error #${requestSeq} reason=${reason}`);
            }
        } finally {
            _isFetchingProject = false;
        }
    },

    syncProjectHistory: async () => {
        try {
            const cursor = get().projectHistoryCursor;
            const delta = await engine.getProjectHistory({
                limit: PROJECT_HISTORY_WINDOW,
                sinceSeq: cursor > 0 ? cursor : undefined,
            });
            if (delta.length === 0) return;
            set((s) => {
                const merged = mergeProjectHistory(
                    s.projectHistory,
                    s.projectHistoryCursor,
                    delta,
                );
                return {
                    projectHistory: merged.history,
                    projectHistoryCursor: merged.cursor,
                };
            });
        } catch (e) {
            // Non-critical. Keep timeline responsive even if history sync hiccups.
            console.warn('[Engine] syncProjectHistory failed:', e);
        }
    },

    // ── Window ─────────────────────────────────────────────────────────

    expandWindow: async () => {
        try {
            await engine.expandWindow();
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    // ── Telemetry Loop ─────────────────────────────────────────────────

    startTelemetryLoop: () => {
        // CRITICAL FIX: Module-level guard for instant synchronous re-entry prevention.
        // _telemetryStarted is set BEFORE any set() call — blocks re-entry even when
        // React hasn't committed the store update yet.
        // We do NOT check get().telemetryRunning because Vite HMR resets _telemetryStarted
        // but zustand persists telemetryRunning: true → would permanently block re-registration.
        if (_telemetryStarted) return;
        _telemetryStarted = true;

        // CRITICAL: Defer ALL state updates to break synchronous React re-render cascade.
        queueMicrotask(() => {
            set({ telemetryRunning: true });
            void get().fetchProject('telemetry-startup');
        });
        let tickCounter = 0;

        void (async () => {
            try {
                _telemetryUnlisten = await listen<{
                    transport: TransportState;
                    meters: MeteringSnapshot;
                }>('telemetry_tick', (event) => {
                    tickCounter++;
                    if (tickCounter % PROJECT_HISTORY_SYNC_EVERY_TICKS === 0) {
                        void get().syncProjectHistory();
                    }
                    const nextTransport = event.payload.transport;
                    const nextMeters = event.payload.meters;
                    const prev = get().transport;

                    // BUG-3 fix: suppress telemetry BPM overwrites while user's
                    // optimistic setBpm update is still pending (avoids flicker).
                    const bpmProtected = Date.now() < _bpmPendingUntil;
                    const effectiveTransport = bpmProtected
                        ? { ...nextTransport, bpm: prev.bpm }
                        : nextTransport;

                    const transportChanged =
                        prev.is_playing !== effectiveTransport.is_playing ||
                        prev.position_beats !== effectiveTransport.position_beats ||
                        prev.position_frames !== effectiveTransport.position_frames ||
                        prev.bpm !== effectiveTransport.bpm ||
                        prev.loop_enabled !== effectiveTransport.loop_enabled ||
                        prev.loop_start !== effectiveTransport.loop_start ||
                        prev.loop_end !== effectiveTransport.loop_end;

                    // PERF-FIX: Always store latest meters in module-level ref
                    // for high-frequency access, but throttle React state updates
                    // to ~6fps to prevent catastrophic re-render storms.
                    _latestMeters = nextMeters;
                    _meterFrameCounter++;
                    const shouldUpdateMeterState = _meterFrameCounter % METER_STATE_UPDATE_EVERY_TICKS === 0;

                    // ══════════════════════════════════════════════════════════
                    // ENTERPRISE FIX: requestAnimationFrame batching
                    //
                    // Tauri pushes 30 telemetry events/sec. Each set() triggers
                    // Zustand → React re-render of ALL subscribed components
                    // (DawShell, TransportBar, Timeline, etc.).
                    // At 30 set()/sec, React's reconciler is permanently busy
                    // and NEVER processes user click/pointer handlers → UI
                    // appears frozen even though events reach JS.
                    //
                    // Fix: Accumulate pending state in a module-level object.
                    // Schedule a single rAF callback that does ONE set() per
                    // browser frame (~16ms). Multiple Tauri events within the
                    // same frame are coalesced → zero data loss, 60fps max.
                    // ══════════════════════════════════════════════════════════
                    if (transportChanged) {
                        _pendingUpdate.transport = effectiveTransport;
                        _pendingUpdate.connected = true;
                        _pendingUpdate.lastError = null;
                    }
                    if (shouldUpdateMeterState) {
                        _pendingUpdate.meters = nextMeters;
                        if (!get().connected) {
                            _pendingUpdate.connected = true;
                            _pendingUpdate.lastError = null;
                        }
                    }
                    if (!get().connected && !_pendingUpdate.connected) {
                        _pendingUpdate.connected = true;
                        _pendingUpdate.lastError = null;
                    }

                    // Schedule single rAF flush (idempotent — only one pending at a time)
                    if (!_rafPending) {
                        _rafPending = true;
                        requestAnimationFrame(() => {
                            _rafPending = false;
                            const update = _pendingUpdate;
                            _pendingUpdate = {};
                            if (Object.keys(update).length > 0) {
                                set(update);
                            }
                        });
                    }
                });
                // BUG-P2 FIX: Route plugin_sandbox_tick through rAF batching.
                // Previously called set() directly at 30fps, causing React re-render
                // storms identical to the telemetry_tick issue.
                _pluginSandboxUnlisten = await listen<PluginSandboxSnapshot>(
                    'plugin_sandbox_tick',
                    (event) => {
                        _pendingUpdate.pluginSandbox = event.payload;
                        if (!_rafPending) {
                            _rafPending = true;
                            requestAnimationFrame(() => {
                                _rafPending = false;
                                const update = _pendingUpdate;
                                _pendingUpdate = {};
                                if (Object.keys(update).length > 0) {
                                    set(update);
                                }
                            });
                        }
                    },
                );
            } catch (e) {
                const msg = String(e);
                console.error('[Telemetry] listen() failed — resetting guard for retry:', msg);
                // CRITICAL: Reset module-level guard so DawShell safety-net useEffect
                // can retry startTelemetryLoop(). Without this, a single failed listen()
                // permanently locks out telemetry → entire UI goes dead.
                _telemetryStarted = false;
                if (get().lastError !== msg) {
                    set({ lastError: msg, connected: false, telemetryRunning: false });
                }
            }
        })();
    },

    stopTelemetryLoop: () => {
        _telemetryStarted = false;
        set({ telemetryRunning: false });
        if (_telemetryUnlisten) {
            _telemetryUnlisten();
            _telemetryUnlisten = null;
        }
        if (_pluginSandboxUnlisten) {
            _pluginSandboxUnlisten();
            _pluginSandboxUnlisten = null;
        }
    },

    togglePluginEditor: async (trackId: string, slotId: string) => {
        const { openEditorsByTrack } = get();
        const trackSet = openEditorsByTrack[trackId] || new Set<string>();
        const isOpen = trackSet.has(slotId);

        try {
            if (isOpen) {
                await engine.closePluginWindowForSlot(trackId, slotId);
                const nextSet = new Set(trackSet);
                nextSet.delete(slotId);
                set((s) => ({
                    openEditorsByTrack: { ...s.openEditorsByTrack, [trackId]: nextSet },
                }));
            } else {
                await engine.openPluginWindowForSlot(trackId, slotId);
                const nextSet = new Set(trackSet);
                nextSet.add(slotId);
                set((s) => ({
                    openEditorsByTrack: { ...s.openEditorsByTrack, [trackId]: nextSet },
                }));
            }
        } catch (e) {
            console.error('[EngineStore] togglePluginEditor failed:', e);
            set({ lastError: String(e) });
        }
    },

    closeAllPluginEditors: async () => {
        const { openEditorsByTrack } = get();
        for (const [trackId, slots] of Object.entries(openEditorsByTrack)) {
            for (const slotId of slots) {
                try {
                    await engine.closePluginWindowForSlot(trackId, slotId);
                } catch (e) {
                    console.warn(`[EngineStore] Failed to close editor ${slotId} on track ${trackId}:`, e);
                }
            }
        }
        set({ openEditorsByTrack: {} });
    },
}));
