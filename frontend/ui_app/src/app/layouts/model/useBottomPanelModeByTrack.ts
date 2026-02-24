import { useCallback, type Dispatch, type SetStateAction } from 'react';

type BottomPanelMode = 'rack' | 'clip' | 'mixer';

interface UseBottomPanelModeByTrackArgs {
    selectedTrackId: string;
    setBottomPanelMode: Dispatch<SetStateAction<BottomPanelMode>>;
    setBottomPanelModeByTrack: Dispatch<SetStateAction<Record<string, BottomPanelMode>>>;
}

export function useBottomPanelModeByTrack({
    selectedTrackId,
    setBottomPanelMode,
    setBottomPanelModeByTrack,
}: UseBottomPanelModeByTrackArgs) {
    const activePanelTrackKey = selectedTrackId && selectedTrackId.length > 0 ? selectedTrackId : 'master';
    return useCallback(
        (next: BottomPanelMode | ((prev: BottomPanelMode) => BottomPanelMode)) => {
            setBottomPanelMode((prev) => {
                const resolved = typeof next === 'function'
                    ? (next as (prev: BottomPanelMode) => BottomPanelMode)(prev)
                    : next;
                setBottomPanelModeByTrack((byTrack) => ({
                    ...byTrack,
                    [activePanelTrackKey]: resolved,
                }));
                return resolved;
            });
        },
        [activePanelTrackKey, setBottomPanelMode, setBottomPanelModeByTrack],
    );
}
