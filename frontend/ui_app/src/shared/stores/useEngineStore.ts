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
            return response;
        } catch (err) {
            const msg = `Import failed: ${err}`;
            console.error(`[Engine] ${msg}`);
            set({ lastError: msg });
            return null;
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
