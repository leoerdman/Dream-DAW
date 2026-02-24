import { create } from 'zustand';

export interface LastTouchedParam {
    trackId: string;
    deviceId: string;
    paramName: string;
    paramKey: string;
    touchedAtMs: number;
}

interface LastTouchedParamStore {
    lastTouched: LastTouchedParam | null;
    setLastTouched: (payload: Omit<LastTouchedParam, 'touchedAtMs'>) => void;
    clear: () => void;
}

export const useLastTouchedParamStore = create<LastTouchedParamStore>((set) => ({
    lastTouched: null,
    setLastTouched: (payload) => {
        set({
            lastTouched: {
                ...payload,
                touchedAtMs: Date.now(),
            },
        });
    },
    clear: () => set({ lastTouched: null }),
}));
