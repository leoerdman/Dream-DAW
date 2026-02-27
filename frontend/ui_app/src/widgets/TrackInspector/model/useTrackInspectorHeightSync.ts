import { useEffect } from 'react';
import type React from 'react';

type RowHeightOverrides = Record<string, number>;
type TracksByIdState = Record<string, { height?: number }>;

export function useTrackInspectorHeightSync(
    _rowHeightOverrides: RowHeightOverrides,
    _resizingTrackId: string | null,
    _tracksByIdState: TracksByIdState,
    _trackHeight: number,
    setRowHeightOverrides: React.Dispatch<React.SetStateAction<RowHeightOverrides>>,
) {
    useEffect(() => {
        const onReset = () => {
            setRowHeightOverrides({});
        };
        window.addEventListener('dream:track-heights-reset', onReset as EventListener);
        return () => window.removeEventListener('dream:track-heights-reset', onReset as EventListener);
    }, [setRowHeightOverrides]);
}
