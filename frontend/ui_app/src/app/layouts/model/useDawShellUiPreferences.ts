import { useEffect, useRef } from 'react';
import { ALL_DIVISIONS, type GridDivision } from '@/shared/lib/gridSnap';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import { useGridStore } from '@/shared/stores/useGridStore';
import { useSettingsStore } from '@/shared/stores/useSettingsStore';

interface DawShellUiPreferencesArgs {
    settingsLoaded: boolean;
    settings: ReturnType<typeof useSettingsStore.getState>['settings'];
    followPlayhead: boolean;
    automationVisible: boolean;
    pianoPencilMode: boolean;
    gridDivision: GridDivision;
    gridTriplet: boolean;
    gridSnapEnabled: boolean;
    setFollowPlayhead: (next: boolean) => void;
}

export function useDawShellUiPreferences(args: DawShellUiPreferencesArgs): void {
    const {
        settingsLoaded,
        settings,
        followPlayhead,
        automationVisible,
        pianoPencilMode,
        gridDivision,
        gridTriplet,
        gridSnapEnabled,
        setFollowPlayhead,
    } = args;
    const uiPrefsHydratedRef = useRef(false);
    const persistUiPrefsTimerRef = useRef<number | null>(null);

    useEffect(() => {
        if (!settingsLoaded || uiPrefsHydratedRef.current) return;
        const rawDivision = settings.arrangementGridDivision as GridDivision;
        const division: GridDivision = ALL_DIVISIONS.includes(rawDivision) ? rawDivision : 'ADAPTIVE';
        useGridStore.getState().applyUiPreferences({
            division,
            triplet: Boolean(settings.arrangementGridTriplet),
            snapEnabled: Boolean(settings.arrangementGridSnapEnabled),
            pianoPencilMode: Boolean(settings.transportPianoPencilMode),
        });
        useAutomationStore.setState({
            globalVisible: Boolean(settings.transportAutomationVisible),
        });
        setFollowPlayhead(Boolean(settings.transportFollowPlayhead));
        uiPrefsHydratedRef.current = true;
    }, [settingsLoaded, settings, setFollowPlayhead]);

    useEffect(() => {
        if (!settingsLoaded || !uiPrefsHydratedRef.current) return;
        if (persistUiPrefsTimerRef.current != null) {
            window.clearTimeout(persistUiPrefsTimerRef.current);
            persistUiPrefsTimerRef.current = null;
        }
        persistUiPrefsTimerRef.current = window.setTimeout(() => {
            persistUiPrefsTimerRef.current = null;
            const settingsStore = useSettingsStore.getState();
            const current = settingsStore.settings;
            const next = {
                ...current,
                transportFollowPlayhead: Boolean(followPlayhead),
                transportAutomationVisible: Boolean(automationVisible),
                transportPianoPencilMode: Boolean(pianoPencilMode),
                arrangementGridDivision: gridDivision,
                arrangementGridTriplet: Boolean(gridTriplet),
                arrangementGridSnapEnabled: Boolean(gridSnapEnabled),
            };
            if (
                current.transportFollowPlayhead === next.transportFollowPlayhead
                && current.transportAutomationVisible === next.transportAutomationVisible
                && current.transportPianoPencilMode === next.transportPianoPencilMode
                && current.arrangementGridDivision === next.arrangementGridDivision
                && current.arrangementGridTriplet === next.arrangementGridTriplet
                && current.arrangementGridSnapEnabled === next.arrangementGridSnapEnabled
            ) {
                return;
            }
            void settingsStore.updateAllSettings(next);
        }, 180);
        return () => {
            if (persistUiPrefsTimerRef.current != null) {
                window.clearTimeout(persistUiPrefsTimerRef.current);
                persistUiPrefsTimerRef.current = null;
            }
        };
    }, [
        settingsLoaded,
        followPlayhead,
        automationVisible,
        pianoPencilMode,
        gridDivision,
        gridTriplet,
        gridSnapEnabled,
    ]);
}
