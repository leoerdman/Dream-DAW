import { useEffect, useMemo, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import * as engineApi from '@/shared/api/engine';
import type { BackgroundJobSnapshot } from '@/shared/api/engine';

const labelByKind: Record<string, string> = {
    export_mix: 'Rendering Audio',
    split_to_stems: 'Splitting To 4 Stems',
    bounce_track: 'Bouncing Track',
    bounce_group: 'Bouncing Group',
    bounce_selection: 'Bouncing Selection',
};

export const BlockingJobPopup = () => {
    const [jobs, setJobs] = useState<BackgroundJobSnapshot[]>([]);

    useEffect(() => {
        let unlisten: UnlistenFn | null = null;
        let mounted = true;

        void engineApi.listBackgroundJobs()
            .then((list) => {
                if (mounted) setJobs(list);
            })
            .catch((err) => {
                console.warn('[BlockingJobPopup] listBackgroundJobs failed:', err);
            });

        void listen<BackgroundJobSnapshot>('background_job_update', (event) => {
            if (!mounted) return;
            const next = event.payload;
            setJobs((prev) => {
                const idx = prev.findIndex((j) => j.id === next.id);
                if (idx === -1) return [next, ...prev];
                const copy = prev.slice();
                copy[idx] = next;
                return copy;
            });
        }).then((fn) => {
            unlisten = fn;
        }).catch((err) => {
            console.warn('[BlockingJobPopup] listener setup failed:', err);
        });

        return () => {
            mounted = false;
            if (unlisten) unlisten();
        };
    }, []);

    const activeJob = useMemo(() => {
        const running = jobs
            .filter((j) => j.status === 'running' && j.cancellable)
            .sort((a, b) => b.startedAtMs - a.startedAtMs);
        return running[0] ?? null;
    }, [jobs]);

    if (!activeJob) return null;

    const progress = Math.max(0, Math.min(100, activeJob.progress || 0));
    const title = labelByKind[activeJob.kind] ?? 'Processing';

    return (
        <div style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10000,
            background: 'rgba(0, 0, 0, 0.66)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'auto',
        }}>
            <div style={{
                width: 360,
                borderRadius: 12,
                border: '1px solid var(--color-border-subtle)',
                background: 'color-mix(in srgb, var(--color-bg-elevated) 92%, #0b0f17)',
                boxShadow: '0 26px 56px rgba(0,0,0,0.5)',
                padding: 16,
                display: 'grid',
                gap: 10,
            }}>
                <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--color-text-primary)' }}>
                    {title}
                </div>
                <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                    {activeJob.phase || 'Processing...'}
                </div>
                <div style={{
                    height: 6,
                    borderRadius: 99,
                    overflow: 'hidden',
                    background: 'color-mix(in srgb, var(--color-bg-panel) 74%, #06080c)',
                }}>
                    <div style={{
                        width: `${progress}%`,
                        height: '100%',
                        background: 'var(--color-accent-primary)',
                        transition: 'width 120ms linear',
                    }} />
                </div>
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                }}>
                    <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
                        {Math.round(progress)}%
                    </div>
                    <button
                        onClick={() => {
                            void engineApi.cancelBackgroundJob(activeJob.id)
                                .catch((err) => {
                                    console.warn('[BlockingJobPopup] cancelBackgroundJob failed, fallback to cancelExport:', err);
                                    return engineApi.cancelExport();
                                });
                        }}
                        style={{
                            height: 28,
                            borderRadius: 7,
                            border: '1px solid color-mix(in srgb, var(--color-status-error) 45%, transparent)',
                            background: 'color-mix(in srgb, var(--color-status-error) 18%, transparent)',
                            color: 'var(--color-status-error)',
                            fontSize: 12,
                            fontWeight: 700,
                            padding: '0 12px',
                            cursor: 'pointer',
                        }}
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    );
};
