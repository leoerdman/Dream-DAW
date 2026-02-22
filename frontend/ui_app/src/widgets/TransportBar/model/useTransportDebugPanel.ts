import { useCallback, useEffect, useRef, useState } from 'react';
import * as engineApi from '@/shared/api/engine';
import { DEFAULT_PDC_PANEL_POS, PDC_PANEL_POS_KEY } from './transportBarDomain';

export function useTransportDebugPanel() {
    const [pdcOpen, setPdcOpen] = useState(false);
    const [debugTab, setDebugTab] = useState<'overview' | 'pdc' | 'sandbox'>('overview');
    const [pdcLoading, setPdcLoading] = useState(false);
    const [pdcError, setPdcError] = useState<string | null>(null);
    const [pdcSnapshot, setPdcSnapshot] = useState<engineApi.PdcDebugSnapshot | null>(null);
    const [rtSnapshot, setRtSnapshot] = useState<engineApi.RtDebugSnapshot | null>(null);
    const [rtLoading, setRtLoading] = useState(false);
    const [rtError, setRtError] = useState<string | null>(null);
    const [sandboxLoading, setSandboxLoading] = useState(false);
    const [sandboxError, setSandboxError] = useState<string | null>(null);
    const [sandboxRuntime, setSandboxRuntime] = useState<engineApi.PluginSandboxSnapshot | null>(null);
    const pdcPanelRef = useRef<HTMLDivElement | null>(null);
    const [pdcPanelPos, setPdcPanelPos] = useState(DEFAULT_PDC_PANEL_POS);
    const dragRef = useRef<{ dragging: boolean; startX: number; startY: number; baseRight: number; baseTop: number }>({
        dragging: false,
        startX: 0,
        startY: 0,
        baseRight: DEFAULT_PDC_PANEL_POS.right,
        baseTop: DEFAULT_PDC_PANEL_POS.top,
    });

    const loadPdcSnapshot = useCallback(async () => {
        setPdcLoading(true);
        try {
            setPdcSnapshot(await engineApi.getPdcDebugSnapshot());
            setPdcError(null);
        } catch (err) {
            setPdcError(err instanceof Error ? err.message : String(err));
        } finally {
            setPdcLoading(false);
        }
    }, []);

    const loadRtSnapshot = useCallback(async () => {
        setRtLoading(true);
        try {
            setRtSnapshot(await engineApi.getRtDebugSnapshot());
            setRtError(null);
        } catch (err) {
            setRtError(err instanceof Error ? err.message : String(err));
        } finally {
            setRtLoading(false);
        }
    }, []);

    const loadSandboxSnapshot = useCallback(async () => {
        setSandboxLoading(true);
        try {
            setSandboxRuntime(await engineApi.getPluginSandboxRuntime());
            setSandboxError(null);
        } catch (err) {
            setSandboxError(err instanceof Error ? err.message : String(err));
        } finally {
            setSandboxLoading(false);
        }
    }, []);

    const refreshSnapshots = useCallback(() => {
        void loadPdcSnapshot();
        void loadRtSnapshot();
        void loadSandboxSnapshot();
    }, [loadPdcSnapshot, loadRtSnapshot, loadSandboxSnapshot]);

    const handlePdcDragStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        dragRef.current = {
            dragging: true,
            startX: e.clientX,
            startY: e.clientY,
            baseRight: pdcPanelPos.right,
            baseTop: pdcPanelPos.top,
        };
        e.preventDefault();
    }, [pdcPanelPos.right, pdcPanelPos.top]);

    const tickWatchdog = useCallback(async () => {
        try {
            setSandboxRuntime(await engineApi.tickPluginSandboxWatchdog());
        } catch (err) {
            setSandboxError(err instanceof Error ? err.message : String(err));
        }
    }, []);

    useEffect(() => {
        try {
            const raw = window.localStorage.getItem(PDC_PANEL_POS_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw) as { right?: number; top?: number };
            if (typeof parsed.right === 'number' && typeof parsed.top === 'number') {
                setPdcPanelPos({
                    right: Math.max(8, Math.min(parsed.right, window.innerWidth - 220)),
                    top: Math.max(40, Math.min(parsed.top, window.innerHeight - 220)),
                });
            }
        } catch {
            // Ignore corrupted localStorage payload.
        }
    }, []);

    useEffect(() => {
        try {
            window.localStorage.setItem(PDC_PANEL_POS_KEY, JSON.stringify(pdcPanelPos));
        } catch {
            // Ignore storage write failures.
        }
    }, [pdcPanelPos]);

    useEffect(() => {
        if (!pdcOpen) return;
        refreshSnapshots();
        const id = window.setInterval(refreshSnapshots, 1500);
        return () => window.clearInterval(id);
    }, [pdcOpen, refreshSnapshots]);

    useEffect(() => {
        void engineApi.setRtDebugEnabled(pdcOpen).catch((err) => {
            console.warn('[TransportBar] setRtDebugEnabled failed:', err);
        });
    }, [pdcOpen]);

    useEffect(() => {
        if (!pdcOpen) return;
        const onDown = (e: MouseEvent) => {
            const target = e.target as Node;
            if (pdcPanelRef.current && !pdcPanelRef.current.contains(target)) setPdcOpen(false);
        };
        const onEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setPdcOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onEsc);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onEsc);
        };
    }, [pdcOpen]);

    useEffect(() => {
        if (!pdcOpen) return;
        const onMove = (e: MouseEvent) => {
            if (!dragRef.current.dragging) return;
            const dx = e.clientX - dragRef.current.startX;
            const dy = e.clientY - dragRef.current.startY;
            setPdcPanelPos({
                right: Math.max(8, Math.min(dragRef.current.baseRight - dx, window.innerWidth - 220)),
                top: Math.max(40, Math.min(dragRef.current.baseTop + dy, window.innerHeight - 220)),
            });
        };
        const onUp = () => {
            dragRef.current.dragging = false;
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        return () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
    }, [pdcOpen]);

    return {
        pdcOpen,
        setPdcOpen,
        debugTab,
        setDebugTab,
        pdcLoading,
        pdcError,
        pdcSnapshot,
        rtSnapshot,
        rtLoading,
        rtError,
        sandboxLoading,
        sandboxError,
        sandboxRuntime,
        pdcPanelRef,
        pdcPanelPos,
        handlePdcDragStart,
        refreshSnapshots,
        tickWatchdog,
    };
}

