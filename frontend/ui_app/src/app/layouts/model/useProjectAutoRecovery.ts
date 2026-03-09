import { useEffect } from 'react';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { applyDeltasWithSnapshotSync } from '@/shared/stores/engine/snapshotSync';
import { isProjectLoadInFlight, withProjectLoad } from '@/shared/lib/projectLoadGuard';

// ── Auto-Recovery: Re-fetch project when frontend state is lost ────────
// After HMR page reload or any event that resets the Zustand store,
// the frontend has 0 tracks and 0 clips while the Rust backend still
// has the full project in memory. This hook detects that scenario and
// automatically re-fetches the project snapshot from the backend.
// ───────────────────────────────────────────────────────────────────────
let recoveryInFlight = false;
let recoveryGeneration = 0;
let lastRecoveryAttemptAtMs = 0;
const INITIAL_DELAY_MS = 2000;
const RETRY_DELAY_MS = 500;
const MAX_RETRY_WINDOW_MS = 15000;
const RECOVERY_COOLDOWN_MS = 30000;

export function useProjectAutoRecovery(): void {
    useEffect(() => {
        const generation = ++recoveryGeneration;
        const startedAt = Date.now();
        let timerId: ReturnType<typeof setTimeout> | null = null;
        let cancelled = false;

        const schedule = (delayMs: number) => {
            if (cancelled) return;
            timerId = setTimeout(runCheck, delayMs);
        };

        const runCheck = () => {
            if (cancelled) return;
            if (generation !== recoveryGeneration) return;
            if (isProjectLoadInFlight()) {
                if (Date.now() - startedAt < MAX_RETRY_WINDOW_MS) {
                    schedule(RETRY_DELAY_MS);
                }
                return;
            }

            const state = useEngineStore.getState();
            const hasNoTracks = state.tracks.allIds.length === 0;
            const isConnected = state.connected || state.telemetryRunning;
            const hasCanonicalClips = state.clips.allIds.length > 0;
            const hasAnyClipData = hasCanonicalClips;
            const hasTracksButNoClips = state.tracks.allIds.length > 0 && !hasAnyClipData;
            const transportLooksActive = state.transport.is_playing || (state.transport.position_frames ?? 0) > 0;
            const looksLikeFreshBoot = state.projectHistory.length === 0 && state.projectHistoryCursor === 0;
            const likelyDesyncedTimeline = hasTracksButNoClips && transportLooksActive && looksLikeFreshBoot;

            if ((!hasNoTracks && !likelyDesyncedTimeline) || !isConnected || recoveryInFlight) return;
            if (Date.now() - lastRecoveryAttemptAtMs < RECOVERY_COOLDOWN_MS) return;

            recoveryInFlight = true;
            lastRecoveryAttemptAtMs = Date.now();
            const reason = hasNoTracks ? 'no-tracks' : 'tracks-without-clips';
            console.warn(`[AutoRecovery] Backend/UI desync detected (${reason}) — re-fetching project...`);

            void withProjectLoad(`auto-recovery:${reason}`, async () => {
                try {
                    const status = await engineApi.getProjectStatus();
                    const filePath = (status as { filePath?: string }).filePath;

                    if (filePath) {
                        const response = await engineApi.openProject(filePath);
                        await applyDeltasWithSnapshotSync(
                            useEngineStore.getState().applyProjectDeltas,
                            response.deltas,
                            `auto-recovery:resync:${reason}`,
                        );
                        console.info('[AutoRecovery] Project re-synced successfully:', filePath);
                    } else {
                        const response = await engineApi.newProject();
                        await applyDeltasWithSnapshotSync(
                            useEngineStore.getState().applyProjectDeltas,
                            response.deltas,
                            `auto-recovery:new-project:${reason}`,
                        );
                        console.info('[AutoRecovery] Loaded default project');
                    }

                } catch (err) {
                    console.error('[AutoRecovery] Failed to recover project state:', err);
                    useStatusStore.getState().setError(`Auto-recovery failed: ${err instanceof Error ? err.message : String(err)}`);
                } finally {
                    recoveryInFlight = false;
                }
            });
        };

        schedule(INITIAL_DELAY_MS);

        return () => {
            cancelled = true;
            if (generation === recoveryGeneration) {
                recoveryGeneration += 1;
            }
            if (timerId) clearTimeout(timerId);
        };
    }, []);
}
