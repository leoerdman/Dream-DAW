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
    setSessionClips: React.Dispatch<React.SetStateAction<Record<string, SessionClip>>>;
    setSelectedSessionClipId: (clipId: string | null) => void;
    setPlayingSessionClipByTrack: React.Dispatch<
        React.SetStateAction<Record<string, string | null>>
    >;
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
