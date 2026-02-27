import { useCallback, useEffect, useMemo } from 'react';
import throttle from 'lodash.throttle';
import * as engineApi from '@/shared/api/engine';
import { useAutomationStore, type AutomationLane as LaneData } from '@/shared/stores/useAutomationStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';

export function useAutomationLaneSync(lane: LaneData) {
    const pushPointsThrottled = useMemo(
        () =>
            throttle((points: engineApi.AutomationPoint[]) => {
                engineApi
                    .setAutomationPointsWithDeltas(lane.trackId, lane.paramKey, points)
                    .then((response) => useEngineStore.getState().applyProjectDeltas(response.deltas, 'automation:throttle'))
                    .catch((err) => console.error('[Dream] setAutomationPoints failed:', err));
            }, 16),
        [lane.trackId, lane.paramKey],
    );

    useEffect(() => () => pushPointsThrottled.cancel(), [pushPointsThrottled]);

    const buildEnginePoints = useCallback((): engineApi.AutomationPoint[] => {
        const latest = useAutomationStore.getState().lanes[lane.id];
        return (latest?.breakpoints ?? lane.breakpoints).map((bp) => ({
            beat: bp.beat,
            value: bp.value,
            curveType: bp.curve === 'step' ? 'step' : bp.curve === 'bezier' ? 'bezier' : 'linear',
            tension: bp.curve === 'bezier' ? (bp.tension ?? 0.5) : undefined,
        }));
    }, [lane.id, lane.breakpoints]);

    const flushPointsToEngine = useCallback(() => {
        pushPointsThrottled(buildEnginePoints());
    }, [buildEnginePoints, pushPointsThrottled]);

    const pushPointsImmediate = useCallback(() => {
        engineApi
            .setAutomationPointsWithDeltas(lane.trackId, lane.paramKey, buildEnginePoints())
            .then((response) => useEngineStore.getState().applyProjectDeltas(response.deltas, 'automation:flush'))
            .catch((err) => console.error('[Dream] setAutomationPoints final push failed:', err));
    }, [buildEnginePoints, lane.trackId, lane.paramKey]);

    return { flushPointsToEngine, pushPointsImmediate, pushPointsThrottled };
}
