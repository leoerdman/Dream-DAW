// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Engine Store (Zustand)
// ═══════════════════════════════════════════════════════════════════════════
//
// The Global Brain. Single source of truth for the React UI.
//
// Architecture:
//   1. UI calls an ACTION (e.g., togglePlay)
//   2. Action sends IPC command to Rust engine
//   3. Telemetry loop reads engine state back at 60fps
//   4. Store updates → React re-renders
//
// The telemetry loop bridges the gap between the lock-free Rust world
// and the React rendering cycle. It polls `get_transport` and `get_meters`
// using requestAnimationFrame for smooth, jank-free meter animation.
//
// ═══════════════════════════════════════════════════════════════════════════

import { create } from 'zustand';
import * as engine from '@/shared/api/engine';
import type {
    TransportState,
    MeteringSnapshot,
    ImportAudioResponse,
} from '@/shared/api/engine';

// ── Timeline Clip Type (used by Timeline widget) ─────────────────────────

export interface TimelineClip {
    id: string;
    name: string;
    trackIndex: number;
    startBeat: number;
    durationBeats: number;
    type: 'audio' | 'midi';
    color: string;
    selected?: boolean;
}

/** Track info from Rust project. */
export interface ProjectTrack {
    id: string;
    name: string;
    color: string;
    volume: number;
    pan: number;
    is_mute: boolean;
    is_solo: boolean;
}

// ── Track color mapping (matches Rust TrackColor enum) ───────────────────

const TRACK_COLORS: Record<string, string> = {
    Red: '#c93c38',
    Orange: '#d97028',
    Yellow: '#d9a428',
    Green: '#38a84f',
    Teal: '#2d8fa5',
    Blue: '#4466cc',
    Purple: '#8844aa',
    Pink: '#c850a0',
    Slate: '#667788',
    Coral: '#e05050',
    Lime: '#a2a835',
    Indigo: '#5555cc',
};

function resolveTrackColor(color: unknown): string {
    if (typeof color === 'string') {
        return TRACK_COLORS[color] ?? '#667788';
    }
    return '#667788';
}

// ── Store Types ──────────────────────────────────────────────────────────

interface EngineStore {
    // ── State ────────────────────────────────────────────────────────────
    /** Whether the telemetry loop has started. */
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

    /** Last IPC error (for error boundary / status bar display). */
    lastError: string | null;

    // ── Actions ──────────────────────────────────────────────────────────

    /** Start/stop playback. Sends IPC command, then telemetry loop syncs state. */
    togglePlay: () => Promise<void>;

    /** Start playback. */
    play: () => Promise<void>;

    /** Stop playback. */
    stop: () => Promise<void>;

    /** Change BPM. Optimistically updates local state, then sends to engine. */
    setBpm: (bpm: number) => Promise<void>;

    /** Seek to a position in seconds. */
    seekSeconds: (seconds: number) => Promise<void>;

    /** Set loop region. */
    setLoop: (enabled: boolean, startFrames: number, endFrames: number) => Promise<void>;

    /** Set test tone frequency (debug). */
    setFrequency: (freq: number) => Promise<void>;

    /** Track control: set volume. */
    setTrackVolume: (trackIndex: number, volume: number) => Promise<void>;

    /** Track control: set pan. */
    setTrackPan: (trackIndex: number, pan: number) => Promise<void>;

    /** Track control: mute/unmute. */
    setTrackMute: (trackIndex: number, muted: boolean) => Promise<void>;

    /** Track control: solo/unsolo. */
    setTrackSolo: (trackIndex: number, soloed: boolean) => Promise<void>;

    /** Import an audio file onto a track. */
    importFile: (path: string, trackIndex: number) => Promise<ImportAudioResponse | null>;

    /** Fetch project state from Rust and convert to timeline format. */
    fetchProject: () => Promise<void>;

    /** Expand window from splash to full DAW mode. */
    expandWindow: () => Promise<void>;

    /**
     * Start the 60fps telemetry loop.
     * Polls `get_transport` and `get_meters` via requestAnimationFrame.
     * Should be called once at app startup (after splash screen).
     */
    startTelemetryLoop: () => void;

    /**
     * Stop the telemetry loop.
     * Called on app unmount or when switching to a different view.
     */
    stopTelemetryLoop: () => void;
}

// ── Default Values ───────────────────────────────────────────────────────

const DEFAULT_TRANSPORT: TransportState = {
    is_playing: false,
    position_frames: 0,
    position_seconds: 0,
    bpm: 120,
    loop_enabled: false,
    loop_start: 0,
    loop_end: 0,
};

const DEFAULT_METER: engine.MeterReading = {
    rms: 0,
    peak: 0,
    clipping: false,
};

const DEFAULT_METERS: MeteringSnapshot = {
    tracks: [],
    master_left: { ...DEFAULT_METER },
    master_right: { ...DEFAULT_METER },
};

// ── Telemetry Loop Control ───────────────────────────────────────────────

let _rafId: number | null = null;

// Throttle meters to 30fps (every other frame) for performance
let _frameCount = 0;

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
    lastError: null,

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
        // Optimistic update — UI responds instantly
        set((s) => ({ transport: { ...s.transport, bpm } }));
        try {
            await engine.setBpm(bpm);
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
            await engine.setTrackVolume(trackIndex, volume);
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    setTrackPan: async (trackIndex: number, pan: number) => {
        try {
            await engine.setTrackPan(trackIndex, pan);
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    setTrackMute: async (trackIndex: number, muted: boolean) => {
        try {
            await engine.setTrackMute(trackIndex, muted);
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    setTrackSolo: async (trackIndex: number, soloed: boolean) => {
        try {
            await engine.setTrackSolo(trackIndex, soloed);
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    // ── Audio Import ───────────────────────────────────────────────────

    importFile: async (path: string, trackIndex: number) => {
        try {
            const response = await engine.importAudioFile(path, trackIndex);
            console.log(
                `[Engine] Imported '${response.clip_name}' → track ${trackIndex} (${response.duration_seconds.toFixed(1)}s)`,
            );
            // Refresh project state so Timeline shows the new clip
            await get().fetchProject();
            return response;
        } catch (err) {
            const msg = `Import failed: ${err}`;
            console.error(`[Engine] ${msg}`);
            set({ lastError: msg });
            return null;
        }
    },

    // ── Project Sync ───────────────────────────────────────────────────

    fetchProject: async () => {
        try {
            const project = await engine.getProject() as {
                tracks: Array<{
                    id: string;
                    name: string;
                    color: unknown;
                    volume: number;
                    pan: number;
                    is_mute: boolean;
                    is_solo: boolean;
                    clips: Array<{
                        id: string;
                        name: string;
                        position: { sample_frame: number };
                        duration: { sample_frame: number };
                        color_override: unknown;
                    }>;
                }>;
                sample_rate: number;
                pulse_map: { initial_bpm: number };
            };

            const bpm = get().transport.bpm || project.pulse_map?.initial_bpm || 120;
            const sr = project.sample_rate || 44100;
            const beatsPerSecond = bpm / 60;

            // Convert all clips from sample frames → beats
            const timelineClips: TimelineClip[] = [];
            const projectTracks: ProjectTrack[] = [];

            for (let trackIdx = 0; trackIdx < project.tracks.length; trackIdx++) {
                const track = project.tracks[trackIdx];

                projectTracks.push({
                    id: track.id,
                    name: track.name,
                    color: resolveTrackColor(track.color),
                    volume: track.volume,
                    pan: track.pan,
                    is_mute: track.is_mute,
                    is_solo: track.is_solo,
                });

                for (const clip of track.clips) {
                    const posSeconds = clip.position.sample_frame / sr;
                    const durSeconds = clip.duration.sample_frame / sr;
                    const trackColor = resolveTrackColor(track.color);

                    timelineClips.push({
                        id: clip.id,
                        name: clip.name,
                        trackIndex: trackIdx,
                        startBeat: posSeconds * beatsPerSecond,
                        durationBeats: durSeconds * beatsPerSecond,
                        type: 'audio',
                        color: resolveTrackColor(clip.color_override) !== '#667788'
                            ? resolveTrackColor(clip.color_override)
                            : trackColor,
                    });
                }
            }

            set({ timelineClips, projectTracks, projectSampleRate: sr });
        } catch (e) {
            console.error('[Engine] fetchProject failed:', e);
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
        if (get().telemetryRunning) return;
        set({ telemetryRunning: true });

        // Fetch project once at startup
        get().fetchProject();

        const poll = async () => {
            _frameCount++;
            try {
                // Transport state — every frame (60fps)
                const transport = await engine.getTransport();
                set({ transport, connected: true, lastError: null });

                // Meters — every other frame (30fps) for performance
                if (_frameCount % 2 === 0) {
                    const meters = await engine.getMeters();
                    set({ meters });
                }
            } catch (e) {
                // Don't spam errors — only set if different
                const current = get().lastError;
                const msg = String(e);
                if (current !== msg) {
                    set({ lastError: msg, connected: false });
                }
            }

            // Continue loop if still running
            if (get().telemetryRunning) {
                _rafId = requestAnimationFrame(poll);
            }
        };

        _rafId = requestAnimationFrame(poll);
    },

    stopTelemetryLoop: () => {
        set({ telemetryRunning: false });
        if (_rafId !== null) {
            cancelAnimationFrame(_rafId);
            _rafId = null;
        }
    },
}));
