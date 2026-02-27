import { useCallback, useState } from 'react';
import * as engineApi from '@/shared/api/engine';

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
        }
    }, [armedTrackIndex, isRecording, onRecordingStateChange]);

    const stopRecordingIfNeeded = useCallback(async () => {
        if (!isRecording) return;
        try {
            await engineApi.stopRecording();
        } catch (err) {
            console.error('[Dream] stopRecording failed:', err);
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
