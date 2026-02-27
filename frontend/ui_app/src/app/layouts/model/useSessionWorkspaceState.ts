import { useMemo } from 'react';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import { useSessionWorkspaceStore } from '@/shared/stores/useSessionWorkspaceStore';
import { SESSION_SCENE_ROWS } from '../sessionWorkspace.constants';

const SLOT_KEY_SEPARATOR = '::';

function encodeTrackIdForSlot(trackId: string): string {
    return encodeURIComponent(trackId);
}

function decodeTrackIdFromSlot(encoded: string): string {
    try {
        return decodeURIComponent(encoded);
    } catch (decodeErr) {
        console.warn('[Dream] decodeTrackIdFromSlot failed:', decodeErr);
        return encoded;
    }
}

function trackIdFromSlotKey(slotKey: string): string {
    const sep = slotKey.indexOf(SLOT_KEY_SEPARATOR);
    if (sep >= 0) {
        return decodeTrackIdFromSlot(slotKey.slice(0, sep));
    }
    // Backward compatibility for legacy `${trackId}:${sceneIndex}` keys.
    const legacySep = slotKey.indexOf(':');
    return legacySep >= 0 ? slotKey.slice(0, legacySep) : slotKey;
}

export function useSessionWorkspaceState(
    tracks: ProjectTrack[],
    isPlaying: boolean,
    togglePlay: () => Promise<void>,
) {
    const scenes = useMemo(() => Array.from({ length: SESSION_SCENE_ROWS }, (_, i) => i), []);
    const sessionClips = useSessionWorkspaceStore((s) => s.sessionClips);
    const selectedSessionClipId = useSessionWorkspaceStore((s) => s.selectedSessionClipId);
    const playingSessionClipByTrack = useSessionWorkspaceStore((s) => s.playingSessionClipByTrack);
    const setSessionClips = useSessionWorkspaceStore((s) => s.setSessionClips);
    const setSelectedSessionClipId = useSessionWorkspaceStore((s) => s.setSelectedSessionClipId);
    const setPlayingSessionClipByTrack = useSessionWorkspaceStore((s) => s.setPlayingSessionClipByTrack);

    const slotKey = (trackId: string, sceneIndex: number) =>
        `${encodeTrackIdForSlot(trackId)}${SLOT_KEY_SEPARATOR}${sceneIndex}`;
    const validTrackIds = useMemo(() => new Set(tracks.map((track) => track.id)), [tracks]);

    const sessionClipsSafe = useMemo(() => {
        const next: typeof sessionClips = {};
        for (const [key, clip] of Object.entries(sessionClips)) {
            const trackId = trackIdFromSlotKey(key);
            if (!validTrackIds.has(trackId)) continue;
            next[key] = clip;
        }
        return next;
    }, [sessionClips, validTrackIds]);

    const playingSessionClipByTrackSafe = useMemo(() => {
        const next: typeof playingSessionClipByTrack = {};
        for (const [trackId, clipId] of Object.entries(playingSessionClipByTrack)) {
            if (!validTrackIds.has(trackId)) continue;
            next[trackId] = clipId;
        }
        return next;
    }, [playingSessionClipByTrack, validTrackIds]);

    const selectedSessionClipIdSafe = useMemo(() => {
        if (!selectedSessionClipId) return null;
        const exists = Object.values(sessionClipsSafe).some((clip) => clip.id === selectedSessionClipId);
        return exists ? selectedSessionClipId : null;
    }, [selectedSessionClipId, sessionClipsSafe]);

    const launchScene = (sceneIndex: number) => {
        setPlayingSessionClipByTrack((prev) => {
            const next: Record<string, string | null> = { ...prev };
            for (const track of tracks) {
                const clip = sessionClipsSafe[slotKey(track.id, sceneIndex)];
                next[track.id] = clip?.id ?? null;
            }
            return next;
        });
        if (!isPlaying) void togglePlay();
    };

    const stopScene = (sceneIndex: number) => {
        setPlayingSessionClipByTrack((prev) => {
            const next: Record<string, string | null> = { ...prev };
            for (const track of tracks) {
                const clip = sessionClipsSafe[slotKey(track.id, sceneIndex)];
                if (clip && next[track.id] === clip.id) next[track.id] = null;
            }
            return next;
        });
    };

    const activeScenes = useMemo(() => {
        const next = new Set<number>();
        if (!isPlaying) return next;
        for (let sceneIndex = 0; sceneIndex < SESSION_SCENE_ROWS; sceneIndex++) {
            let hasPlayingClip = false;
            for (const track of tracks) {
                const clip = sessionClipsSafe[slotKey(track.id, sceneIndex)];
                if (!clip) continue;
                if (playingSessionClipByTrackSafe[track.id] === clip.id) {
                    hasPlayingClip = true;
                    break;
                }
            }
            if (hasPlayingClip) next.add(sceneIndex);
        }
        return next;
    }, [isPlaying, playingSessionClipByTrackSafe, sessionClipsSafe, tracks]);

    return {
        scenes,
        slotKey,
        sessionClipsSafe,
        selectedSessionClipIdSafe,
        playingSessionClipByTrackSafe,
        setSessionClips,
        setSelectedSessionClipId,
        setPlayingSessionClipByTrack,
        launchScene,
        stopScene,
        activeScenes,
    };
}
