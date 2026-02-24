import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';

type BottomPanelMode = 'rack' | 'clip';

type ImportFileFn = (path: string, trackIndex: number, positionFrames?: number) => Promise<unknown>;

export function useDawShellGlobalShortcuts(args: {
    setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setExportOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setMainViewMode: React.Dispatch<React.SetStateAction<'arrangement' | 'session'>>;
    setBottomPanelModeForActiveTrack: (updater: (prev: BottomPanelMode) => BottomPanelMode) => void;
}): void {
    const { setSettingsOpen, setExportOpen, setMainViewMode, setBottomPanelModeForActiveTrack } = args;
    useEffect(() => {
        const openExportPanel = () => {
            setExportOpen(true);
            if (typeof window.__dreamOpenExportModal === 'function') {
                window.__dreamOpenExportModal();
                return;
            }
            window.dispatchEvent(new CustomEvent('dream:open-export'));
        };

        const isEditableTarget = (target: EventTarget | null): boolean => {
            const el = target as HTMLElement | null;
            if (!el) return false;
            const tag = el.tagName?.toLowerCase();
            return tag === 'input' || tag === 'textarea' || el.isContentEditable;
        };

        const isMod = (e: KeyboardEvent): boolean => e.metaKey || e.ctrlKey;

        const handler = (e: KeyboardEvent) => {
            if (e.defaultPrevented || e.isComposing) return;

            if (isMod(e) && !e.shiftKey && !e.altKey && e.code === 'Comma') {
                e.preventDefault();
                setSettingsOpen((prev) => !prev);
                return;
            }

            // Export shortcut (Cmd/Ctrl+Shift+R).
            if (isMod(e) && e.shiftKey && !e.altKey && e.code === 'KeyR') {
                e.preventDefault();
                e.stopPropagation();
                openExportPanel();
                return;
            }

            // Reload shortcut uses Cmd/Ctrl+Alt+R to avoid conflicts with export (Cmd/Ctrl+Shift+R).
            if (isMod(e) && !e.shiftKey && e.altKey && e.code === 'KeyR') {
                e.preventDefault();
                e.stopPropagation();
                window.location.reload();
                return;
            }

            // Backward-compatible export shortcut.
            if (isMod(e) && e.shiftKey && !e.altKey && e.code === 'KeyE') {
                e.preventDefault();
                e.stopPropagation();
                openExportPanel();
                return;
            }

            if (e.key === 'Tab' && !e.shiftKey) {
                if (isEditableTarget(e.target)) return;
                e.preventDefault();
                setMainViewMode((prev) => (prev === 'arrangement' ? 'session' : 'arrangement'));
                return;
            }

            if (e.key === 'Tab' && e.shiftKey) {
                if (isEditableTarget(e.target)) return;
                e.preventDefault();
                setBottomPanelModeForActiveTrack((prev) => (prev === 'rack' ? 'clip' : 'rack'));
                return;
            }

            if (e.code === 'KeyA' && !isMod(e) && !e.altKey && !e.shiftKey) {
                if (isEditableTarget(e.target)) return;
                e.preventDefault();
                useAutomationStore.getState().toggleGlobalVisible();
            }
        };

        window.addEventListener('keydown', handler, { capture: true });
        document.addEventListener('keydown', handler, { capture: true });
        return () => {
            window.removeEventListener('keydown', handler, { capture: true } as EventListenerOptions);
            document.removeEventListener('keydown', handler, {
                capture: true,
            } as EventListenerOptions);
        };
    }, [setBottomPanelModeForActiveTrack, setSettingsOpen, setExportOpen, setMainViewMode]);
}

export function useTauriFileDropImport(importFile: ImportFileFn, importingRef: React.MutableRefObject<boolean>): void {
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let cancelled = false;

        const setup = async () => {
            const unlistenHover = await listen('tauri://drag-over', () => {
                if (!window.__dreamInAppDrag) {
                    // no-op
                }
            });
            const unlistenLeave = await listen('tauri://drag-leave', () => {
                // no-op
            });
            const unlistenDrop = await listen<{ paths: string[] }>('tauri://drag-drop', async (event) => {
                if (importingRef.current) return;
                importingRef.current = true;
                try {
                    const paths = event.payload.paths ?? [];
                    const audioFiles = paths.filter((path) => {
                        const dotIdx = path.lastIndexOf('.');
                        if (dotIdx < 0) return false;
                        const ext = path.slice(dotIdx).toLowerCase();
                        return ['.wav', '.mp3', '.flac', '.aiff', '.aif', '.ogg', '.m4a', '.aac'].includes(ext);
                    });
                    if (audioFiles.length === 0) {
                        console.warn('[DawShell] No supported audio files in drop');
                        return;
                    }
                    for (let i = 0; i < audioFiles.length; i++) {
                        await importFile(audioFiles[i], i);
                    }
                    console.log(`[DawShell] Imported ${audioFiles.length} audio file(s)`);
                } finally {
                    importingRef.current = false;
                }
            });

            const combinedUnlisten = () => {
                unlistenHover();
                unlistenLeave();
                unlistenDrop();
            };

            if (cancelled) {
                combinedUnlisten();
            } else {
                unlisten = combinedUnlisten;
            }
        };

        void setup();
        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [importFile, importingRef]);
}

export function useSelectedTrackConsistency(args: {
    selectedTrackIds: string[];
    selectedTrackId: string;
    setSelectedTrackId: React.Dispatch<React.SetStateAction<string>>;
}): void {
    const { selectedTrackIds, selectedTrackId, setSelectedTrackId } = args;
    useEffect(() => {
        if (selectedTrackIds.length === 0) return;
        if (!selectedTrackIds.includes(selectedTrackId)) {
            setSelectedTrackId(selectedTrackIds[selectedTrackIds.length - 1]);
        }
    }, [selectedTrackIds, selectedTrackId, setSelectedTrackId]);
}

export function useAudioFailoverRecovery(args: {
    recoveringAudioRef: React.MutableRefObject<boolean>;
    lastAudioRecoverAtRef: React.MutableRefObject<number>;
}): void {
    const { recoveringAudioRef, lastAudioRecoverAtRef } = args;
    useEffect(() => {
        let unlisten: (() => void) | null = null;
        let cancelled = false;

        const setup = async () => {
            const fn = await listen<{ error?: string }>('audio-stream-error', async (event) => {
                const now = Date.now();
                if (recoveringAudioRef.current) return;
                if (now - lastAudioRecoverAtRef.current < 3000) return;

                recoveringAudioRef.current = true;
                lastAudioRecoverAtRef.current = now;

                try {
                    const settings = await engineApi.getSettings();
                    const fallback = settings.fallbackOutputDevice || 'Default Output';
                    const resolved = await engineApi.restartAudioEngine(fallback);

                    if (settings.outputDevice !== resolved) {
                        await engineApi.updateSettings({ ...settings, outputDevice: resolved });
                    }

                    console.warn('[DawShell] Audio stream recovered via fallback:', {
                        streamError: event.payload?.error,
                        requestedFallback: fallback,
                        resolved,
                    });
                } catch (err) {
                    console.error('[DawShell] Audio fallback recovery failed:', err);
                } finally {
                    recoveringAudioRef.current = false;
                }
            });
            if (cancelled) fn(); else unlisten = fn;
        };

        void setup();
        return () => {
            cancelled = true;
            if (unlisten) unlisten();
        };
    }, [lastAudioRecoverAtRef, recoveringAudioRef]);
}

export function useTelemetryBootstrap(startTelemetryLoop: () => void): void {
    useEffect(() => {
        startTelemetryLoop();
        const retryId = setInterval(() => {
            const running = useEngineStore.getState().telemetryRunning;
            if (!running) {
                console.warn('[DawShell] Telemetry not running — retrying startTelemetryLoop()');
                startTelemetryLoop();
            } else {
                clearInterval(retryId);
            }
        }, 500);
        return () => clearInterval(retryId);
    }, [startTelemetryLoop]);
}

export function useInitialLayoutSync(): void {
    useEffect(() => {
        const id = requestAnimationFrame(() => {
            window.dispatchEvent(new Event('resize'));
        });
        return () => cancelAnimationFrame(id);
    }, []);
}

// ── Auto-Recovery: Re-fetch project when frontend state is lost ────────
// After HMR page reload or any event that resets the Zustand store,
// the frontend has 0 tracks and 0 clips while the Rust backend still
// has the full project in memory. This hook detects that scenario and
// automatically re-fetches the project snapshot from the backend.
// ───────────────────────────────────────────────────────────────────────
let _recoveryInFlight = false;

export function useProjectAutoRecovery(): void {
    useEffect(() => {
        // Wait 2s after mount — gives splash screen time to populate store normally.
        const timerId = setTimeout(() => {
            const state = useEngineStore.getState();
            const hasNoTracks = state.tracks.allIds.length === 0;
            const isConnected = state.connected || state.telemetryRunning;

            if (!hasNoTracks || !isConnected || _recoveryInFlight) return;

            _recoveryInFlight = true;
            console.warn('[AutoRecovery] Store has 0 tracks but backend is connected — re-fetching project...');

            void (async () => {
                try {
                    // 1. Ask backend for current project path
                    const status = await engineApi.getProjectStatus();
                    const filePath = (status as { filePath?: string }).filePath;

                    if (filePath) {
                        // 2. Re-open the project to get a full ProjectSnapshotReplaced delta
                        const response = await engineApi.openProject(filePath);
                        await useEngineStore.getState().applyProjectDeltas(
                            response.deltas,
                            'auto-recovery:resync',
                        );
                        console.info('[AutoRecovery] Project re-synced successfully:', filePath);
                    } else {
                        // No project file — might be a new project, try newProject()
                        const response = await engineApi.newProject();
                        await useEngineStore.getState().applyProjectDeltas(
                            response.deltas,
                            'auto-recovery:new-project',
                        );
                        console.info('[AutoRecovery] Loaded default project');
                    }

                    // 3. Re-activate plugins
                    engineApi.eagerActivateExternalPlugins().catch((err) =>
                        console.warn('[AutoRecovery] Plugin activation (non-fatal):', err),
                    );
                } catch (err) {
                    console.error('[AutoRecovery] Failed to recover project state:', err);
                } finally {
                    _recoveryInFlight = false;
                }
            })();
        }, 2000);

        return () => clearTimeout(timerId);
    }, []);
}
