import { useCallback, useState } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';

export function useTransportRecording(
    projectTracks: ProjectTrack[],
    onRecordingStateChange?: (state: { active: boolean; trackIndex: number }) => void,
) {
    const [isRecording, setIsRecording] = useState(false);

    const handleRecordToggle = useCallback(async () => {
        const armedTrackIndex = Math.max(0, projectTracks.findIndex((t) => t.is_armed));
        try {
            if (!isRecording) {
                await engineApi.startRecording();
                setIsRecording(true);
                onRecordingStateChange?.({ active: true, trackIndex: armedTrackIndex });
            } else {
                await engineApi.stopRecording();
                setIsRecording(false);
                onRecordingStateChange?.({ active: false, trackIndex: armedTrackIndex });
            }
        } catch (err) {
            console.error('[TransportBar] Recording toggle failed:', err);
        }
    }, [projectTracks, isRecording, onRecordingStateChange]);

    const stopRecordingIfNeeded = useCallback(async () => {
        if (!isRecording) return;
        try {
            await engineApi.stopRecording();
        } catch (err) {
            console.error('[TransportBar] stopRecording failed:', err);
        } finally {
            setIsRecording(false);
            onRecordingStateChange?.({
                active: false,
                trackIndex: Math.max(0, projectTracks.findIndex((t) => t.is_armed)),
            });
        }
    }, [isRecording, onRecordingStateChange, projectTracks]);

    return { isRecording, setIsRecording, handleRecordToggle, stopRecordingIfNeeded };
}

