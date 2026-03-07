import { useCallback, useState } from 'react';
import * as engineApi from '@/shared/api/engine';
import { useStatusStore } from '@/shared/stores/useStatusStore';

export function useTransportRecording(
    armedTrackIndex: number,
    onRecordingStateChange?: (state: { active: boolean; trackIndex: number }) => void,
) {
    const [isRecording, setIsRecording] = useState(false);

    const handleRecordToggle = useCallback(async () => {
        const resolvedTrackIndex = Math.max(0, armedTrackIndex);
        try {
            if (!isRecording) {
                await engineApi.startRecording();
                setIsRecording(true);
                onRecordingStateChange?.({ active: true, trackIndex: resolvedTrackIndex });
            } else {
                await engineApi.stopRecording();
                setIsRecording(false);
                onRecordingStateChange?.({ active: false, trackIndex: resolvedTrackIndex });
            }
        } catch (err) {
            console.error('[Dream] Recording toggle failed:', err);
            useStatusStore.getState().setError(`Recording failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }, [armedTrackIndex, isRecording, onRecordingStateChange]);

    const stopRecordingIfNeeded = useCallback(async () => {
        if (!isRecording) return;
        try {
            await engineApi.stopRecording();
        } catch (err) {
            console.error('[Dream] stopRecording failed:', err);
            useStatusStore.getState().setError(`Stop recording failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setIsRecording(false);
            onRecordingStateChange?.({
                active: false,
                trackIndex: Math.max(0, armedTrackIndex),
            });
        }
    }, [armedTrackIndex, isRecording, onRecordingStateChange]);

    return { isRecording, setIsRecording, handleRecordToggle, stopRecordingIfNeeded };
}
