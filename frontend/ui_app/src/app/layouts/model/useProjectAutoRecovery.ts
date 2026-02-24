import { useEffect } from 'react';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';

// ── Auto-Recovery: Re-fetch project when frontend state is lost ────────
// After HMR page reload or any event that resets the Zustand store,
// the frontend has 0 tracks and 0 clips while the Rust backend still
// has the full project in memory. This hook detects that scenario and
// automatically re-fetches the project snapshot from the backend.
// ───────────────────────────────────────────────────────────────────────
let recoveryInFlight = false;

export function useProjectAutoRecovery(): void {
    useEffect(() => {
        const timerId = setTimeout(() => {
            const state = useEngineStore.getState();
            const hasNoTracks = state.tracks.allIds.length === 0;
            const isConnected = state.connected || state.telemetryRunning;
            const hasTracksButNoClips = state.tracks.allIds.length > 0 && state.timelineClips.length === 0;
            const transportLooksActive = state.transport.is_playing || (state.transport.position_frames ?? 0) > 0;
            const likelyDesyncedTimeline = hasTracksButNoClips && transportLooksActive;

            if ((!hasNoTracks && !likelyDesyncedTimeline) || !isConnected || recoveryInFlight) return;

            recoveryInFlight = true;
            const reason = hasNoTracks ? 'no-tracks' : 'tracks-without-clips';
            console.warn(`[AutoRecovery] Backend/UI desync detected (${reason}) — re-fetching project...`);

            void (async () => {
                try {
                    const status = await engineApi.getProjectStatus();
                    const filePath = (status as { filePath?: string }).filePath;

                    if (filePath) {
                        const response = await engineApi.openProject(filePath);
                        await useEngineStore.getState().applyProjectDeltas(
                            response.deltas,
                            `auto-recovery:resync:${reason}`,
                        );
                        console.info('[AutoRecovery] Project re-synced successfully:', filePath);
                    } else {
                        const response = await engineApi.newProject();
                        await useEngineStore.getState().applyProjectDeltas(
                            response.deltas,
                            `auto-recovery:new-project:${reason}`,
                        );
                        console.info('[AutoRecovery] Loaded default project');
                    }

                    engineApi.eagerActivateExternalPlugins().catch((err) =>
                        console.warn('[AutoRecovery] Plugin activation (non-fatal):', err),
                    );
                } catch (err) {
                    console.error('[AutoRecovery] Failed to recover project state:', err);
                } finally {
                    recoveryInFlight = false;
                }
            })();
        }, 2000);

        return () => clearTimeout(timerId);
    }, []);
}
