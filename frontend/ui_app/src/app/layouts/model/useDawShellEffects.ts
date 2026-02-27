import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import { dreamGlobals } from '@/shared/lib/dreamGlobals';
import { useStatusStore } from '@/shared/stores/useStatusStore';
type BottomPanelMode = 'rack' | 'clip';
type ImportFileFn = (path: string, trackIndex: number, positionFrames?: number) => Promise<unknown>;
interface AlsImportSummaryPayload {
    project_name: string;
    track_count: number;
    missing_slots_before: number;
    missing_slots_after: number;
    auto_resolved_internal: number;
    auto_resolved_external: number;
    warped_clip_count: number;
    warp_marker_count: number;
    warped_with_source_frames: number;
    unresolved_missing_labels: string[];
}
export function useDawShellGlobalShortcuts(args: {
    setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setExportOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setMainViewMode: React.Dispatch<React.SetStateAction<'arrangement' | 'session'>>;
    setBottomPanelModeForActiveTrack: (updater: (prev: BottomPanelMode) => BottomPanelMode) => void;
}): void {
    const { setSettingsOpen, setExportOpen, setMainViewMode, setBottomPanelModeForActiveTrack } = args;
    useEffect(() => {
        const openExportPanel = () => {
            const openViaGlobal =
                typeof dreamGlobals.getOpenExportModal === 'function'
                    ? dreamGlobals.getOpenExportModal()
                    : null;
            if (typeof openViaGlobal === 'function') {
                openViaGlobal();
                return;
            }
            setExportOpen(true);
            if (typeof window.__dreamOpenExportModal === 'function') {
                window.__dreamOpenExportModal();
                return;
            }
            // Single dispatch + rAF fallback for async listener registration.
            window.dispatchEvent(new CustomEvent('dream:open-export'));
            requestAnimationFrame(() => {
                window.dispatchEvent(new CustomEvent('dream:open-export'));
            });
        };
        const isEditableTarget = (target: EventTarget | null): boolean => {
            const el = target as HTMLElement | null;
            if (!el) return false;
            const tag = el.tagName?.toLowerCase();
            return tag === 'input' || tag === 'textarea' || el.isContentEditable;
        };
        const isMod = (e: KeyboardEvent): boolean => e.metaKey || e.ctrlKey;
        const isExportShortcut = (e: KeyboardEvent): boolean => {
            if (!isMod(e) || !e.shiftKey || e.altKey) return false;
            const key = (e.key || '').toLowerCase();
            return e.code === 'KeyR' || key === 'r' || key === 'к';
        };
        const isTabPress = (e: KeyboardEvent): boolean => e.code === 'Tab' || e.key === 'Tab';
        const handler = (e: KeyboardEvent) => {
            if (e.defaultPrevented || e.isComposing) return;
            // Ableton-like behavior: Tab shortcuts switch DAW views regardless of focused field.
            if (isTabPress(e) && e.shiftKey && !isMod(e) && !e.altKey) {
                e.preventDefault();
                setBottomPanelModeForActiveTrack((prev) => {
                    return prev === 'rack' ? 'clip' : 'rack';
                });
                return;
            }
            if (isTabPress(e) && !e.shiftKey && !isMod(e) && !e.altKey) {
                e.preventDefault();
                setMainViewMode((prev) => (prev === 'arrangement' ? 'session' : 'arrangement'));
                return;
            }
            if (isMod(e) && !e.shiftKey && !e.altKey && e.code === 'Comma') {
                e.preventDefault();
                e.stopPropagation();
                setSettingsOpen((prev) => !prev);
                return;
            }
            // Export shortcut (Cmd/Ctrl+Shift+R).
            if (isExportShortcut(e)) {
                e.preventDefault();
                e.stopPropagation();
                openExportPanel();
                return;
            }
            if (isEditableTarget(e.target)) return;
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
            if (e.code === 'KeyA' && !isMod(e) && !e.altKey && !e.shiftKey) {
                if (isEditableTarget(e.target)) return;
                e.preventDefault();
                useAutomationStore.getState().toggleGlobalVisible();
            }
            // Global Cmd/Ctrl+F: Focus browser search from anywhere in the DAW.
            if (isMod(e) && !e.shiftKey && !e.altKey && (e.code === 'KeyF' || (typeof e.key === 'string' && e.key.toLowerCase() === 'f'))) {
                if (isEditableTarget(e.target)) return;
                e.preventDefault();
                e.stopPropagation();
                window.dispatchEvent(new CustomEvent('dream:browser-focus-search', { detail: {} }));
            }
        };
        window.addEventListener('keydown', handler, { capture: true });
        return () => {
            window.removeEventListener('keydown', handler, { capture: true } as EventListenerOptions);
        };
    }, [setBottomPanelModeForActiveTrack, setSettingsOpen, setExportOpen, setMainViewMode]);
}
export function useTauriFileDropImport(importFile: ImportFileFn, importingRef: React.MutableRefObject<boolean>): void {
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let cancelled = false;
        const setup = async () => {
            // ENTERPRISE FIX: Guard against HMR race — Tauri IPC bridge may not
            // be injected yet when Vite hot-reloads the JS context.
            if (!(window as any).__TAURI_INTERNALS__) return;
            const unlistenHover = await listen('tauri://drag-over', () => {
                if (!dreamGlobals.isInAppDrag()) {
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
                        console.warn('[Dream] No supported audio files in drop');
                        return;
                    }
                    for (let i = 0; i < audioFiles.length; i++) {
                        await importFile(audioFiles[i], i);
                    }

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
        if (selectedTrackIds.length > 0 && !selectedTrackIds.includes(selectedTrackId)) {
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
            // ENTERPRISE FIX: Guard against HMR race — Tauri IPC bridge may not
            // be injected yet when Vite hot-reloads the JS context.
            if (!(window as any).__TAURI_INTERNALS__) return;
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
                    console.warn('[Dream] Audio stream recovered via fallback:', {
                        streamError: event.payload?.error,
                        requestedFallback: fallback,
                        resolved,
                    });
                } catch (err) {
                    console.error('[Dream] Audio fallback recovery failed:', err);
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
        // Permanent retry: if telemetry dies mid-session (error, delta reset, etc.),
        // this ensures it recovers automatically within 2 seconds.
        const retryId = setInterval(() => {
            const running = useEngineStore.getState().telemetryRunning;
            if (!running) {
                console.warn('[Dream] Telemetry not running — retrying startTelemetryLoop()');
                startTelemetryLoop();
            }
        }, 2000);
        return () => clearInterval(retryId);
    }, [startTelemetryLoop]);
}
export function useInitialLayoutSync(): void {
    useEffect(() => {
        const id = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
        return () => cancelAnimationFrame(id);
    }, []);
}
export function useAlsImportSummaryStatus(): void {
    useEffect(() => {
        let unlisten: (() => void) | null = null;
        let cancelled = false;
        const setup = async () => {
            // ENTERPRISE FIX: Guard against HMR race — Tauri IPC bridge may not
            // be injected yet when Vite hot-reloads the JS context.
            if (!(window as any).__TAURI_INTERNALS__) return;
            const fn = await listen<AlsImportSummaryPayload>('als_import_summary', (event) => {
                const p = event.payload;
                const autoResolved = p.auto_resolved_internal + p.auto_resolved_external;
                const unresolvedCount = Math.max(0, p.missing_slots_after);
                const status = useStatusStore.getState();
                const baseMsg =
                    `ALS: ${p.project_name} | tracks ${p.track_count} | missing ${p.missing_slots_before}→${p.missing_slots_after} | auto ${autoResolved} | warp ${p.warped_clip_count} clips/${p.warp_marker_count} markers | source-frames ${p.warped_with_source_frames}`;
                if (unresolvedCount > 0) {
                    const labels = (p.unresolved_missing_labels ?? []).slice(0, 3);
                    const details = labels.length > 0
                        ? ` | unresolved ${unresolvedCount}: ${labels.join(', ')}${unresolvedCount > labels.length ? ', …' : ''}`
                        : ` | unresolved ${unresolvedCount}`;
                    status.setError(`${baseMsg}${details}`);
                    return;
                }
                status.setInfo(baseMsg);
            });
            if (cancelled) fn(); else unlisten = fn;
        };
        void setup();
        return () => {
            cancelled = true;
            if (unlisten) unlisten();
        };
    }, []);
}
