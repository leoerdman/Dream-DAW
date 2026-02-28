import { useCallback } from 'react';
import { selectBestPeakLevel } from './assetBrowserUtils';
import * as engineApi from '@/shared/api/engine';
import type { BrowserItem } from './assetBrowserSchema';

interface KeyboardInteractionsParams {
    items: BrowserItem[];
    selectedItemId: string | null;
    selectedCategoryId: string;
    pluginLetterAnchors: { itemByLetter: Record<string, string> };
    previewEnabled: boolean;
    fileListRef: React.RefObject<HTMLDivElement | null>;
    searchRef: React.RefObject<HTMLInputElement | null>;
    itemRowRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
    setSelectedItemId: React.Dispatch<React.SetStateAction<string | null>>;
    setDebouncedQuery: React.Dispatch<React.SetStateAction<string>>;
    syncPreviewForItem: (item: BrowserItem | null) => void;
    handleItemEnter: (item: BrowserItem | null) => Promise<void>;
}

export function useKeyboardInteractions({
    items,
    selectedItemId,
    selectedCategoryId,
    pluginLetterAnchors,
    previewEnabled,
    fileListRef,
    searchRef,
    itemRowRefs,
    setSelectedItemId,
    setDebouncedQuery,
    syncPreviewForItem,
    handleItemEnter,
}: KeyboardInteractionsParams) {
    const scrollRowIntoView = useCallback((id: string) => {
        requestAnimationFrame(() => {
            itemRowRefs.current[id]?.scrollIntoView({ block: 'nearest' });
        });
    }, [itemRowRefs]);

    const jumpToPluginLetter = useCallback((letter: string) => {
        const targetId = pluginLetterAnchors.itemByLetter[letter];
        if (!targetId) return;
        const targetItem = items.find((it) => it.id === targetId) ?? null;
        setSelectedItemId(targetId);
        syncPreviewForItem(targetItem);
        scrollRowIntoView(targetId);
    }, [items, pluginLetterAnchors, scrollRowIntoView, setSelectedItemId, syncPreviewForItem]);

    const moveSelection = useCallback((delta: number) => {
        if (items.length === 0) return;
        // BUG-20 FIX: use functional approach for stable index
        const currentIndex = selectedItemId ? items.findIndex((it) => it.id === selectedItemId) : -1;
        const fallbackIndex = delta >= 0 ? 0 : items.length - 1;
        let rawNextIndex: number;
        if (delta === -Infinity) rawNextIndex = 0; // Home
        else if (delta === Infinity) rawNextIndex = items.length - 1; // End
        else rawNextIndex = currentIndex < 0 ? fallbackIndex : currentIndex + delta;
        const nextIndex = Math.max(0, Math.min(items.length - 1, rawNextIndex));
        const next = items[nextIndex];
        if (!next) return;
        setSelectedItemId(next.id);
        if (previewEnabled) syncPreviewForItem(next);
        if (selectedCategoryId === 'plugins') {
            scrollRowIntoView(next.id);
            return;
        }
        const ROW_HEIGHT = 28;
        const el = fileListRef.current;
        if (!el) return;
        const itemTop = nextIndex * ROW_HEIGHT;
        const itemBottom = itemTop + ROW_HEIGHT;
        const headerOffset = 24;
        if (itemTop < el.scrollTop + headerOffset) el.scrollTop = itemTop - headerOffset;
        else if (itemBottom > el.scrollTop + el.clientHeight) el.scrollTop = itemBottom - el.clientHeight;
    }, [fileListRef, items, previewEnabled, scrollRowIntoView, selectedCategoryId, selectedItemId, setSelectedItemId, syncPreviewForItem]);

    const focusResults = useCallback(() => fileListRef.current?.focus(), [fileListRef]);

    const handleBrowserKeyDown = useCallback((e: React.KeyboardEvent) => {
        const activeEl = document.activeElement;
        if (e.key === 'Escape') {
            if (activeEl === searchRef.current && (searchRef.current?.value.length ?? 0) > 0) {
                e.preventDefault();
                e.stopPropagation();
                setDebouncedQuery('');
                if (searchRef.current) searchRef.current.value = '';
                if (fileListRef.current) fileListRef.current.scrollTop = 0;
            }
            return;
        }
        if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); focusResults(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); focusResults(); return; }
        // BUG-71 FIX: Home/End keys
        if (e.key === 'Home') { e.preventDefault(); moveSelection(-Infinity); focusResults(); return; }
        if (e.key === 'End') { e.preventDefault(); moveSelection(Infinity); focusResults(); return; }
        // BUG-72 FIX: PageUp/PageDown (10 items per page)
        if (e.key === 'PageDown') { e.preventDefault(); moveSelection(10); focusResults(); return; }
        if (e.key === 'PageUp') { e.preventDefault(); moveSelection(-10); focusResults(); return; }
        if (selectedCategoryId === 'plugins' && activeEl !== searchRef.current && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const upper = e.key.toUpperCase();
            const target = e.key === '#' ? '#' : (/^[A-Z]$/.test(upper) ? upper : null);
            if (target && pluginLetterAnchors.itemByLetter[target]) {
                e.preventDefault();
                jumpToPluginLetter(target);
                focusResults();
                return;
            }
        }
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (activeEl === searchRef.current) {
            const first = items[0] ?? null;
            if (!first) return;
            // UX: Enter in search immediately applies the top relevant result.
            setSelectedItemId(first.id);
            if (previewEnabled) syncPreviewForItem(first);
            focusResults();
            void handleItemEnter(first);
            return;
        }
        const selected = items.find((it) => it.id === selectedItemId) ?? items[0] ?? null;
        if (!selected) return;
        void handleItemEnter(selected);
    }, [fileListRef, focusResults, handleItemEnter, items, jumpToPluginLetter, moveSelection, pluginLetterAnchors, previewEnabled, searchRef, selectedCategoryId, selectedItemId, setDebouncedQuery, setSelectedItemId, syncPreviewForItem]);

    return { jumpToPluginLetter, focusResults, handleBrowserKeyDown };
}

interface SplitResizeParams {
    splitRootRef: React.RefObject<HTMLDivElement | null>;
    leftPaneWidthRef: React.MutableRefObject<number>;
    setLeftPaneWidth: React.Dispatch<React.SetStateAction<number>>;
    persistBrowserPrefs: (patch: { browserLeftPaneWidth?: number }) => void;
}

export function useSplitResize({
    splitRootRef,
    leftPaneWidthRef,
    setLeftPaneWidth,
    persistBrowserPrefs,
}: SplitResizeParams) {
    return useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        const root = splitRootRef.current;
        if (!root) return;
        const rootRect = root.getBoundingClientRect();
        let rafId: number | null = null;
        let pendingWidth: number | null = null;
        const flushWidth = () => {
            rafId = null;
            if (pendingWidth === null) return;
            const nextWidth = pendingWidth;
            setLeftPaneWidth((prev) => (prev === nextWidth ? prev : nextWidth));
        };
        const onMove = (me: MouseEvent) => {
            pendingWidth = Math.max(84, Math.min(180, Math.round(me.clientX - rootRect.left)));
            if (rafId === null) rafId = window.requestAnimationFrame(flushWidth);
        };
        const onUp = () => {
            if (rafId !== null) { window.cancelAnimationFrame(rafId); rafId = null; }
            flushWidth();
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            const finalWidth = Math.max(84, Math.min(180, leftPaneWidthRef.current));
            persistBrowserPrefs({ browserLeftPaneWidth: finalWidth });
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [leftPaneWidthRef, persistBrowserPrefs, setLeftPaneWidth, splitRootRef]);
}

interface PreviewSyncParams {
    previewEnabled: boolean;
    previewRequestTokenRef: React.MutableRefObject<number>;
    audioDurationSecRef: React.MutableRefObject<Record<string, number>>;
    isPreviewPlayingRef: React.MutableRefObject<boolean>;
    previewCommandQueueRef: React.MutableRefObject<Promise<void>>;
    setPreviewPeaks: React.Dispatch<React.SetStateAction<import('@/shared/api/engine').PeakPair[] | null>>;
}

export function usePreviewSync({
    previewEnabled,
    previewRequestTokenRef,
    audioDurationSecRef,
    isPreviewPlayingRef,
    previewCommandQueueRef,
    setPreviewPeaks,
}: PreviewSyncParams) {
    const enqueuePreviewCommand = useCallback((command: () => Promise<void>) => {
        previewCommandQueueRef.current = previewCommandQueueRef.current
            .catch(() => undefined)
            .then(command)
            .catch((err) => {
                console.warn('[Dream] preview command failed:', err);
            });
    }, [previewCommandQueueRef]);

    return useCallback((item: BrowserItem | null) => {
        const token = ++previewRequestTokenRef.current;
        if (item?.type === 'audio' && item.path) {
            const audioPath = item.path;
            engineApi.getWaveformPeaksBinary(item.path)
                .then((peaks) => {
                    if (previewRequestTokenRef.current !== token) return;
                    setPreviewPeaks(selectBestPeakLevel(peaks.mip_levels));
                    if (peaks.sample_rate > 0 && peaks.total_samples > 0 && item.path) {
                        audioDurationSecRef.current[item.path] = peaks.total_samples / peaks.sample_rate;
                    }
                })
                .catch(() => {
                    if (previewRequestTokenRef.current === token) setPreviewPeaks(null);
                });

            if (previewEnabled) {
                isPreviewPlayingRef.current = true;
                enqueuePreviewCommand(async () => {
                    await engineApi.stopPreview().catch(() => undefined);
                    if (previewRequestTokenRef.current !== token) return;
                    await engineApi.previewAudioFile(audioPath)
                        .catch((err: unknown) => console.error('[Preview] Failed to preview:', audioPath, err));
                });
            } else {
                isPreviewPlayingRef.current = false;
                enqueuePreviewCommand(async () => {
                    await engineApi.stopPreview().catch(() => undefined);
                });
            }
            return;
        }
        isPreviewPlayingRef.current = false;
        enqueuePreviewCommand(async () => {
            await engineApi.stopPreview().catch(() => undefined);
        });
        if (previewRequestTokenRef.current === token) setPreviewPeaks(null);
    }, [
        audioDurationSecRef,
        enqueuePreviewCommand,
        isPreviewPlayingRef,
        previewEnabled,
        previewRequestTokenRef,
        setPreviewPeaks,
    ]);
}
