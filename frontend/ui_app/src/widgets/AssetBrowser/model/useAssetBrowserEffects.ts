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
    } = p;
    useEffect(() => { leftPaneWidthRef.current = leftPaneWidth; }, [leftPaneWidth, leftPaneWidthRef]);
    useEffect(() => {
        engineApi.getBrowserFolders()
            .then((folders) => {
                setUserFolders(folders);
                statusClear();
            })
            .catch((err) => {
                console.warn('[Browser] Failed to load folders:', err);
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
        const handler = (e: KeyboardEvent) => {
            if (e.defaultPrevented || e.isComposing) return;
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === 'KeyF') {
                e.preventDefault();
                searchRef.current?.focus();
                searchRef.current?.select();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [searchRef]);
    useEffect(() => {
        const focusBrowserSearch = (evt: Event) => {
            const detail = (evt as CustomEvent<{ categoryId?: string }>).detail;
            if (detail?.categoryId) {
                setExpandedFolders(new Set());
                setFolderChildrenCache(new Map());
            }
            searchRef.current?.focus();
            searchRef.current?.select();
        };
        const setBrowserSearch = (evt: Event) => {
            const detail = (evt as CustomEvent<{ query?: string; categoryId?: string }>).detail;
            if (detail?.categoryId) {
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
    }, [searchRef, setDebouncedQuery, setExpandedFolders, setFolderChildrenCache]);
    useEffect(() => {
        if (!contextMenu) return;
        const onClick = (e: MouseEvent) => {
            if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) setContextMenu(null);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null); };
        window.addEventListener('mousedown', onClick, true);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('mousedown', onClick, true);
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
        if (!isSamplesCategory || scanTriggeredRef.current) return;
        let cancelled = false;
        const timerId = setTimeout(() => {
            if (cancelled) return;
            setSampleScanLoading(true);
            setSampleScanError(null);
            // BUG-21 FIX: properly chain promises — don't continue scan if demo gen fails hard
            engineApi.generateDemoSamples()
                .catch((err) => {
                    console.warn('[AssetBrowser] Demo sample generation skipped:', err);
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
                        console.warn('[AssetBrowser] Scan failed:', err);
                        const message = errorText(err);
                        setSampleScanError(message);
                        statusError(`Asset Browser: sample scan failed: ${message}`);
                        setSampleScanLoading(false);
                    }
                });
        }, 300);
        return () => { cancelled = true; clearTimeout(timerId); };
    }, [isSamplesCategory, scanTriggeredRef, setRealFiles, setSampleScanError, setSampleScanLoading, statusError]);
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
            console.warn('[Browser] Plugin scan failed:', err);
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
            console.warn('[Browser] Folder scan failed:', err);
            const message = errorText(err);
            setFolderScanError(message);
            statusError(`Asset Browser: folder scan failed: ${message}`);
            setFolderScanLoading(false);
        });
        return () => { cancelled = true; };
    }, [activeFolderPath, folderScanPath, setFolderItems, setFolderScanError, setFolderScanLoading, setFolderScanPath, statusError]);
    useEffect(() => {
        const changed = activeFolderPath !== prevActiveFolderRef.current;
        prevActiveFolderRef.current = activeFolderPath;
        setExpandedFolders(new Set());
        setFolderChildrenCache(new Map());
        setLoadingFolders(new Set());
        if (changed) {
            setFolderScanPath(null);
            setFolderItems([]);
        }
    }, [selectedCategoryId, activeFolderPath, prevActiveFolderRef, setExpandedFolders, setFolderChildrenCache, setFolderItems, setFolderScanPath, setLoadingFolders]);
    useEffect(() => {
        if (items.length === 0) { setSelectedItemId(null); return; }
        if (!selectedItemId || !items.some((it) => it.id === selectedItemId)) setSelectedItemId(items[0].id);
    }, [items, selectedItemId, setSelectedItemId]);
    useEffect(() => {
        if (!columnMenuPos) return;
        const onMouseDown = (e: MouseEvent) => {
            if (!columnMenuRef.current) return;
            if (!columnMenuRef.current.contains(e.target as Node)) setColumnMenuPos(null);
        };
        const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setColumnMenuPos(null); };
        window.addEventListener('mousedown', onMouseDown);
        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.removeEventListener('mousedown', onMouseDown);
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
    }, [selectedItemId, items, selectedCategoryId, fileListRef, itemRowRefs]);
}
