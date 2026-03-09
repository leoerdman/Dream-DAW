import { useEffect } from 'react';
import * as engineApi from '@/shared/api/engine';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import type { UseAssetBrowserEffectsParams } from './useAssetBrowserEffects.types';
export function useAssetBrowserEffects(p: UseAssetBrowserEffectsParams): void {
    const statusError = useStatusStore((s) => s.setError);
    const statusClear = useStatusStore((s) => s.clear);
    const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
    const {
        leftPaneWidth,
        leftPaneWidthRef,
        setUserFolders,
        prevCategoryRef,
        selectedCategoryId,
        setSelectedCategoryId,
        setSourceFilter,
        setFormatFilter,
        setAudioFilter,
        setSizeFilter,
        setPluginSourceFilter,
        searchRef,
        setDebouncedQuery,
        fileListRef,
        setExpandedFolders,
        setFolderChildrenCache,
        contextMenu,
        contextMenuRef,
        setContextMenu,
        setCurrentProjectFolder,
        settingsLoaded,
        settings,
        setShowSizeColumn,
        setShowTypeColumn,
        setLeftPaneWidth,
        isSamplesCategory,
        scanTriggeredRef,
        setSampleScanLoading,
        setSampleScanError,
        setRealFiles,
        libraryScanNonce,
        pluginScanNonce,
        pluginScanned,
        setPluginScanError,
        setPluginScanLoading,
        setPluginFiles,
        setPluginScanned,
        activeFolderPath,
        folderScanPath,
        setFolderScanPath,
        setFolderScanLoading,
        setFolderScanError,
        setFolderItems,
        prevActiveFolderRef,
        prevCategoryForFolderResetRef,
        setLoadingFolders,
        items,
        selectedItemId,
        setSelectedItemId,
        columnMenuPos,
        columnMenuRef,
        setColumnMenuPos,
        prevCatForPreviewRef,
        isPreviewPlayingRef,
        itemRowRefs,
        suppressNextAutoScrollRef,
    } = p;
    useEffect(() => { leftPaneWidthRef.current = leftPaneWidth; }, [leftPaneWidth, leftPaneWidthRef]);
    useEffect(() => {
        engineApi.getBrowserFolders()
            .then((folders) => {
                setUserFolders(folders);
                statusClear();
            })
            .catch((err) => {
                console.warn('[Dream] Failed to load folders:', err);
                statusError(`Asset Browser: failed to load folders: ${errorText(err)}`);
            });
    }, [setUserFolders, statusClear, statusError]);
    useEffect(() => {
        if (prevCategoryRef.current !== selectedCategoryId) {
            prevCategoryRef.current = selectedCategoryId;
            setSourceFilter(0);
            setFormatFilter(0);
            setAudioFilter(0);
            setSizeFilter(0);
            setPluginSourceFilter('all');
        }
    }, [selectedCategoryId, prevCategoryRef, setAudioFilter, setFormatFilter, setPluginSourceFilter, setSizeFilter, setSourceFilter]);
    useEffect(() => {
        const isEventInsideBrowser = (target: EventTarget | null): boolean => {
            const browserRoot = document.querySelector('[data-testid="asset-browser"]');
            if (!browserRoot) return false;
            const targetInside = target instanceof Node && browserRoot.contains(target);
            const activeInside = document.activeElement instanceof Node && browserRoot.contains(document.activeElement);
            return targetInside || activeInside;
        };
        const handler = (e: KeyboardEvent) => {
            if (e.defaultPrevented || e.isComposing) return;
            if (!isEventInsideBrowser(e.target)) return;
            const isFindHotkey = e.code === 'KeyF' || (typeof e.key === 'string' && e.key.toLowerCase() === 'f');
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && isFindHotkey) {
                e.preventDefault();
                if (selectedCategoryId !== 'all') setSelectedCategoryId('all');
                searchRef.current?.focus();
                searchRef.current?.select();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [searchRef, selectedCategoryId, setSelectedCategoryId]);
    useEffect(() => {
        const input = searchRef.current;
        if (!input) return;
        const onFocus = () => {
            if (selectedCategoryId !== 'all') setSelectedCategoryId('all');
        };
        input.addEventListener('focus', onFocus);
        return () => input.removeEventListener('focus', onFocus);
    }, [searchRef, selectedCategoryId, setSelectedCategoryId]);
    useEffect(() => {
        const focusBrowserSearch = (evt: Event) => {
            const detail = (evt as CustomEvent<{ categoryId?: string }>).detail;
            if (detail?.categoryId) {
                setSelectedCategoryId(detail.categoryId);
                setExpandedFolders(new Set());
                setFolderChildrenCache(new Map());
            }
            searchRef.current?.focus();
            searchRef.current?.select();
        };
        const setBrowserSearch = (evt: Event) => {
            const detail = (evt as CustomEvent<{ query?: string; categoryId?: string }>).detail;
            if (detail?.categoryId) {
                setSelectedCategoryId(detail.categoryId);
                setExpandedFolders(new Set());
                setFolderChildrenCache(new Map());
            }
            if (typeof detail?.query === 'string') setDebouncedQuery(detail.query);
            searchRef.current?.focus();
        };
        window.addEventListener('dream:browser-focus-search', focusBrowserSearch as EventListener);
        window.addEventListener('dream:browser-set-search', setBrowserSearch as EventListener);
        return () => {
            window.removeEventListener('dream:browser-focus-search', focusBrowserSearch as EventListener);
            window.removeEventListener('dream:browser-set-search', setBrowserSearch as EventListener);
        };
    }, [searchRef, setDebouncedQuery, setExpandedFolders, setFolderChildrenCache, setSelectedCategoryId]);
    useEffect(() => {
        if (!contextMenu) return;
        const onClick = (e: MouseEvent) => {
            if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) setContextMenu(null);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null); };
        window.addEventListener('pointerdown', onClick, true);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('pointerdown', onClick, true);
            window.removeEventListener('keydown', onKey);
        };
    }, [contextMenu, contextMenuRef, setContextMenu]);
    useEffect(() => {
        if (selectedCategoryId !== 'currentProject') return;
        let mounted = true;
        void engineApi.getProjectStatus().then((status) => { if (mounted) setCurrentProjectFolder(status.projectFolder ?? null); }).catch(() => { if (mounted) setCurrentProjectFolder(null); });
        return () => { mounted = false; };
    }, [selectedCategoryId, setCurrentProjectFolder]);
    useEffect(() => {
        if (!settingsLoaded) return;
        setShowSizeColumn(settings.browserShowSizeColumn);
        setShowTypeColumn(settings.browserShowTypeColumn);
        setLeftPaneWidth(Math.max(84, Math.min(180, settings.browserLeftPaneWidth || 92)));
    }, [settingsLoaded, settings.browserShowSizeColumn, settings.browserShowTypeColumn, settings.browserLeftPaneWidth, setLeftPaneWidth, setShowSizeColumn, setShowTypeColumn]);
    useEffect(() => {
        if (!isSamplesCategory) return;
        if (scanTriggeredRef.current && libraryScanNonce === 0) return;
        let cancelled = false;
        const timerId = setTimeout(() => {
            if (cancelled) return;
            setSampleScanLoading(true);
            setSampleScanError(null);
            // BUG-21 FIX: properly chain promises — don't continue scan if demo gen fails hard
            engineApi.generateDemoSamples()
                .catch((err) => {
                    console.warn('[Dream] Demo sample generation skipped:', err);
                    // Return resolved so scan can proceed even if demo gen is unavailable
                    return undefined;
                })
                .then(() => {
                    if (cancelled) return Promise.reject('cancelled');
                    return engineApi.scanAllAudioSources();
                })
                .then((files) => {
                    if (!cancelled) {
                        scanTriggeredRef.current = true;
                        setRealFiles(files);
                        setSampleScanLoading(false);
                    }
                })
                .catch((err) => {
                    if (!cancelled && err !== 'cancelled') {
                        console.warn('[Dream] Scan failed:', err);
                        const message = errorText(err);
                        setSampleScanError(message);
                        statusError(`Asset Browser: sample scan failed: ${message}`);
                        setSampleScanLoading(false);
                    }
                });
        }, 300);
        return () => { cancelled = true; clearTimeout(timerId); };
    }, [isSamplesCategory, libraryScanNonce, scanTriggeredRef, setRealFiles, setSampleScanError, setSampleScanLoading, statusError, settings.userFolderPath]);
    useEffect(() => {
        const needsPluginCatalog = selectedCategoryId === 'plugins'
            || selectedCategoryId === 'all'
            || selectedCategoryId === 'instruments'
            || selectedCategoryId === 'audioEffects'
            || selectedCategoryId === 'midiEffects';
        if (!needsPluginCatalog) return;
        // BUG-22 FIX: only force rescan when on 'plugins' tab AND nonce was just incremented
        if (pluginScanned && pluginScanNonce === 0) return;
        let cancelled = false;
        setPluginScanError(null);
        setPluginScanLoading(true);
        engineApi.scanPluginFolders().then((files) => {
            if (cancelled) return;
            setPluginFiles(files);
            setPluginScanned(true);
            setPluginScanLoading(false);
        }).catch((err) => {
            if (cancelled) return;
            console.warn('[Dream] Plugin scan failed:', err);
            const message = errorText(err);
            setPluginScanError(message);
            statusError(`Asset Browser: plugin scan failed: ${message}`);
            setPluginScanLoading(false);
        });
        return () => { cancelled = true; };
    }, [selectedCategoryId, pluginScanNonce, pluginScanned, setPluginFiles, setPluginScanError, setPluginScanLoading, setPluginScanned, statusError]);
    useEffect(() => {
        if (!activeFolderPath || activeFolderPath === folderScanPath) return;
        let cancelled = false;
        setFolderScanPath(activeFolderPath);
        setFolderScanLoading(true);
        setFolderScanError(null);
        engineApi.scanFolderAll(activeFolderPath).then((files) => {
            if (cancelled) return;
            setFolderItems(files);
            setFolderScanLoading(false);
        }).catch((err) => {
            if (cancelled) return;
            console.warn('[Dream] Folder scan failed:', err);
            const message = errorText(err);
            setFolderScanError(message);
            statusError(`Asset Browser: folder scan failed: ${message}`);
            setFolderScanLoading(false);
        });
        return () => { cancelled = true; };
    }, [activeFolderPath, folderScanPath, setFolderItems, setFolderScanError, setFolderScanLoading, setFolderScanPath, statusError]);
    useEffect(() => {
        const folderPathChanged = activeFolderPath !== prevActiveFolderRef.current;
        const categoryChanged = selectedCategoryId !== prevCategoryForFolderResetRef.current;
        prevActiveFolderRef.current = activeFolderPath;
        prevCategoryForFolderResetRef.current = selectedCategoryId;
        // Only reset folder tree state when the user actually switched
        // categories or navigated to a different root folder.
        // Previously this was unconditional, causing a race with
        // toggleFolderExpand that wiped the expanded state every render.
        if (categoryChanged || folderPathChanged) {
            setExpandedFolders(new Set());
            setFolderChildrenCache(new Map());
            setLoadingFolders(new Set());
        }
        if (folderPathChanged) {
            setFolderScanPath(null);
            setFolderItems([]);
        }
    }, [selectedCategoryId, activeFolderPath, prevActiveFolderRef, prevCategoryForFolderResetRef, setExpandedFolders, setFolderChildrenCache, setFolderItems, setFolderScanPath, setLoadingFolders]);
    useEffect(() => {
        if (items.length === 0) { setSelectedItemId(null); return; }
        if (selectedItemId && !items.some((it) => it.id === selectedItemId)) setSelectedItemId(null);
    }, [items, selectedItemId, setSelectedItemId]);
    useEffect(() => {
        if (!columnMenuPos) return;
        const onPointerDown = (e: PointerEvent) => {
            if (!columnMenuRef.current) return;
            if (!columnMenuRef.current.contains(e.target as Node)) setColumnMenuPos(null);
        };
        const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setColumnMenuPos(null); };
        window.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.removeEventListener('pointerdown', onPointerDown);
            window.removeEventListener('keydown', onKeyDown);
        };
    }, [columnMenuPos, columnMenuRef, setColumnMenuPos]);
    useEffect(() => {
        if (prevCatForPreviewRef.current !== selectedCategoryId) {
            prevCatForPreviewRef.current = selectedCategoryId;
            engineApi.stopPreview().catch(() => undefined);
            isPreviewPlayingRef.current = false;
        }
    }, [selectedCategoryId, prevCatForPreviewRef, isPreviewPlayingRef]);
    useEffect(() => {
        if (!selectedItemId) return;
        if (suppressNextAutoScrollRef.current) {
            suppressNextAutoScrollRef.current = false;
            return;
        }
        if (selectedCategoryId === 'plugins') {
            itemRowRefs.current[selectedItemId]?.scrollIntoView({ block: 'nearest' });
            return;
        }
        const index = items.findIndex((it) => it.id === selectedItemId);
        if (index === -1) return;
        const el = fileListRef.current;
        if (!el) return;
        const ROW_HEIGHT = 28;
        const headerOffset = 24;
        const itemTop = index * ROW_HEIGHT;
        const itemBottom = itemTop + ROW_HEIGHT;
        if (itemTop < el.scrollTop + headerOffset) el.scrollTop = itemTop - headerOffset;
        else if (itemBottom > el.scrollTop + el.clientHeight) el.scrollTop = itemBottom - el.clientHeight;
    }, [selectedItemId, items, selectedCategoryId, fileListRef, itemRowRefs, suppressNextAutoScrollRef]);
}
