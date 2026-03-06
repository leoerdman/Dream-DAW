import { create } from 'zustand';

export type SessionClip = {
    id: string;
    name: string;
    color: string;
    looped: boolean;
};

interface SessionWorkspaceState {
    sessionClips: Record<string, SessionClip>;
    selectedSessionClipId: string | null;
    playingSessionClipByTrack: Record<string, string | null>;
    // BUG-022 FIX: Zustand-idiomatic types instead of React.Dispatch
    // (which implies reconciliation guarantees that Zustand doesn't provide).
    setSessionClips: (updater: Record<string, SessionClip> | ((prev: Record<string, SessionClip>) => Record<string, SessionClip>)) => void;
    setSelectedSessionClipId: (clipId: string | null) => void;
    setPlayingSessionClipByTrack: (updater: Record<string, string | null> | ((prev: Record<string, string | null>) => Record<string, string | null>)) => void;
}

export const useSessionWorkspaceStore = create<SessionWorkspaceState>((set) => ({
    sessionClips: {},
    selectedSessionClipId: null,
    playingSessionClipByTrack: {},
    setSessionClips: (updater) => {
        set((state) => ({
            sessionClips:
                typeof updater === 'function'
                    ? updater(state.sessionClips)
                    : updater,
        }));
    },
    setSelectedSessionClipId: (clipId) => {
        set({ selectedSessionClipId: clipId });
    },
    setPlayingSessionClipByTrack: (updater) => {
        set((state) => ({
            playingSessionClipByTrack:
                typeof updater === 'function'
                    ? updater(state.playingSessionClipByTrack)
                    : updater,
        }));
    },
}));
