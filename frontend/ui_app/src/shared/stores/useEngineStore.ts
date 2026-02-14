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
import throttle from 'lodash.throttle';
import * as engine from '@/shared/api/engine';
import type {
    TransportState,
    MeteringSnapshot,
    ImportAudioResponse,
} from '@/shared/api/engine';
import type { TimelineClip } from '@/shared/types/Arrangement';
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

const throttledVolumeSends = new Map<number, (volume: number) => void>();
const throttledPanSends = new Map<number, (pan: number) => void>();
const pendingVolumeValues = new Map<number, number>();
const pendingPanValues = new Map<number, number>();
let pendingMasterVolume: number | null = null;
let projectFetchSeq = 0;
const DEBUG_PROJECT_FETCH =
    (typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV))
    || (typeof window !== 'undefined' && (window as Window & { __dreamDebugProjectFetch?: boolean }).__dreamDebugProjectFetch === true);
const throttledMasterVolumeSend = throttle((volume: number) => {
    void engine.setMasterVolume(volume);
}, 16);

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

    /** Authoritative project BPM from PulseMap (race-safe — not from telemetry). */
    projectBpm: number;

    /** Last IPC error (for error boundary / status bar display). */
    lastError: string | null;
    /** Master fader volume (linear gain 0.0..2.0). */
    masterVolume: number;

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
    projectBpm: 120,
    lastError: null,
    masterVolume: 1.0,

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
        try {
            await engine.setBpm(bpm);
            // Backend mutates pulse map + retimes persisted project structures.
            // Pull refreshed project snapshot immediately so timeline conversions
            // and clip geometry remain mathematically consistent.
            await get().fetchProject('setBpm');
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

    addTrack: async (name?: string) => {
        try {
            await engine.addTrack(name);
            await get().fetchProject('addTrack');
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    deleteTrack: async (index: number) => {
        try {
            await engine.deleteTrack(index);
            await get().fetchProject('deleteTrack');
            set({ lastError: null });
        } catch (e) {
            set({ lastError: String(e) });
        }
    },

    renameTrack: async (index: number, name: string) => {
        try {
            await engine.renameTrack(index, name);
            await get().fetchProject('renameTrack');
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
            await get().fetchProject('createMidiClip');
        } catch (err) {
            const msg = `Create MIDI clip failed: ${err}`;
            console.error(`[Engine] ${msg}`);
            set({ lastError: msg });
        }
    },

    // ── Project Sync ───────────────────────────────────────────────────

    fetchProject: async (reason: string = 'manual') => {
        const requestSeq = ++projectFetchSeq;
        if (DEBUG_PROJECT_FETCH) {
            console.debug(`[ProjectFetch] start #${requestSeq} reason=${reason}`);
        }
        try {
            const project = await engine.getProject() as {
                tracks: Array<{
                    id: string;
                    name: string;
                    track_type: string;
                    color: unknown;
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
                        color_override: unknown;
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
                    }>;
                }>;
                sample_rate: number;
                pulse_map: { tempo_events: Array<{ bpm: number }>; sample_rate: number };
                arrangement_grid_numerator?: number;
                arrangement_grid_denominator?: number;
                arrangement_grid_ntoles?: number;
                arrangement_snap_to_grid?: boolean;
                arrangement_grid_fixed?: boolean;
            };

            // Ignore stale/out-of-order responses (e.g. startup fetch resolving
            // after Open Project fetch). Latest invocation always wins.
            if (requestSeq !== projectFetchSeq) {
                if (DEBUG_PROJECT_FETCH) {
                    console.debug(`[ProjectFetch] stale #${requestSeq} reason=${reason} latest=${projectFetchSeq}`);
                }
                return;
            }

            // CRITICAL: Use the project's own PulseMap BPM as the authoritative SSOT
            // for frame↔beat conversion. The telemetry loop's transport.bpm may be
            // stale after open_project (race condition — telemetry hasn't polled yet).
            const bpm = project.pulse_map?.tempo_events?.[0]?.bpm || get().transport.bpm || 120;
            const sr = project.sample_rate || 44100;
            const beatsPerSecond = bpm / 60;

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
                const trackColor = resolveTrackColor(track.color);
                const trackTypeRaw = (track.track_type ?? '').toString().toLowerCase();
                const isMidiTrack = trackTypeRaw === 'midi';

                projectTracks.push({
                    id: track.id,
                    name: track.name,
                    track_type: track.track_type || 'Audio',
                    color: trackColor,
                    volume: track.volume,
                    pan: track.pan,
                    is_mute: track.is_mute,
                    is_solo: track.is_solo,
                    is_armed: (track as Record<string, unknown>).is_armed as boolean ?? false,
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
                    is_expanded: ((track as Record<string, unknown>).is_expanded as boolean | undefined) ?? true,
                    effects: track.effects ?? [],
                    instrument: track.instrument ?? null,
                    sampler: (track as Record<string, unknown>).sampler as ProjectTrack['sampler'] ?? null,
                });

                for (const clip of track.clips) {
                    const posSeconds = clip.position.sample_frame / sr;
                    const durSeconds = clip.duration.sample_frame / sr;
                    const hasAudioPath = !!(clip.file_path && clip.file_path.trim().length > 0);
                    const treatAsMidi = isMidiTrack;

                    timelineClips.push({
                        id: clip.id,
                        name: clip.name,
                        trackIndex: trackIdx,
                        startBeat: posSeconds * beatsPerSecond,
                        durationBeats: durSeconds * beatsPerSecond,
                        // Editor mode must follow track type:
                        // MIDI tracks -> piano roll, Audio tracks -> sample editor.
                        type: treatAsMidi ? 'midi' : 'audio',
                        color: resolveTrackColor(clip.color_override) !== '#667788'
                            ? resolveTrackColor(clip.color_override)
                            : trackColor,
                        filePath: treatAsMidi ? undefined : clip.file_path,
                        durationSamples: clip.duration.sample_frame,
                        sourceOffset: clip.source_offset?.sample_frame ?? 0,
                        fadeIn: ((clip as Record<string, unknown>).fade_in_frames as number | undefined)
                            ?? ((clip as Record<string, unknown>).fadeIn as number | undefined)
                            ?? 0,
                        fadeOut: ((clip as Record<string, unknown>).fade_out_frames as number | undefined)
                            ?? ((clip as Record<string, unknown>).fadeOut as number | undefined)
                            ?? 0,
                        isOffline: treatAsMidi ? false : (hasAudioPath ? (clip.is_offline ?? false) : false),
                        muted: (clip as Record<string, unknown>).is_muted as boolean ?? false,
                    });
                }

                for (const clip of track.midi_clips ?? []) {
                    const posSeconds = clip.position.sample_frame / sr;
                    const durSeconds = clip.duration.sample_frame / sr;
                    timelineClips.push({
                        id: clip.id,
                        name: clip.name,
                        trackIndex: trackIdx,
                        startBeat: posSeconds * beatsPerSecond,
                        durationBeats: durSeconds * beatsPerSecond,
                        type: 'midi',
                        color: trackColor,
                        durationSamples: clip.duration.sample_frame,
                        sourceOffset: 0,
                        fadeIn: ((clip as Record<string, unknown>).fade_in_frames as number | undefined)
                            ?? ((clip as Record<string, unknown>).fadeIn as number | undefined)
                            ?? 0,
                        fadeOut: ((clip as Record<string, unknown>).fade_out_frames as number | undefined)
                            ?? ((clip as Record<string, unknown>).fadeOut as number | undefined)
                            ?? 0,
                        muted: (clip as Record<string, unknown>).is_muted as boolean ?? false,
                        midiNotes: (clip.notes ?? []).map((note, idx) => ({
                            id: `${clip.id}:${idx}:${note.pitch}:${note.start_frame}`,
                            pitch: note.pitch,
                            startBeat: (note.start_frame / sr) * beatsPerSecond,
                            durationBeats: (note.duration_frames / sr) * beatsPerSecond,
                            velocity: note.velocity,
                        })),
                    });
                }
            }

            if (requestSeq === projectFetchSeq) {
                set((s) => ({
                    timelineClips,
                    projectTracks,
                    projectSampleRate: sr,
                    projectBpm: bpm,
                    // Keep transport.bpm in sync so TransportBar/StatusBar
                    // show correct BPM immediately, even before next telemetry poll
                    transport: { ...s.transport, bpm },
                }));
                if (DEBUG_PROJECT_FETCH) {
                    console.debug(
                        `[ProjectFetch] apply #${requestSeq} reason=${reason} tracks=${projectTracks.length} clips=${timelineClips.length} bpm=${bpm}`,
                    );
                }
            }
        } catch (e) {
            console.error('[Engine] fetchProject failed:', e);
            if (DEBUG_PROJECT_FETCH) {
                console.debug(`[ProjectFetch] error #${requestSeq} reason=${reason}`);
            }
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
        get().fetchProject('telemetry-startup');

        const poll = async () => {
            _frameCount++;
            try {
                // Transport state — every frame (60fps)
                const nextTransport = await engine.getTransport();

                // ── BUG-F5/F10 fix: Shallow comparison ──
                // Only update Zustand when transport values actually changed.
                // Without this, set({ transport }) creates a new object ref
                // every frame, causing every subscriber (DawShell → Timeline →
                // TransportBar → StatusBar) to re-render at 60fps.
                const prev = get().transport;
                const transportChanged =
                    prev.is_playing !== nextTransport.is_playing ||
                    prev.position_beats !== nextTransport.position_beats ||
                    prev.bpm !== nextTransport.bpm ||
                    prev.loop_enabled !== nextTransport.loop_enabled ||
                    prev.loop_start !== nextTransport.loop_start ||
                    prev.loop_end !== nextTransport.loop_end;

                if (transportChanged) {
                    set({ transport: nextTransport, connected: true, lastError: null });
                } else if (!get().connected) {
                    set({ connected: true, lastError: null });
                }

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
