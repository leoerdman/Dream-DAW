import { useEffect, useMemo, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import * as engineApi from '@/shared/api/engine';
import type { BackgroundJobSnapshot } from '@/shared/api/engine';
import { ModalOverlay } from '@/shared/ui/ModalOverlay';
import { ActionButton } from '@/shared/ui/ActionButton';

/* ═══════════════════════════════════════════════════════════════
   BlockingJobPopup — Non-dismissible modal for background jobs.
   All values use design tokens from tokens.css.
   ═══════════════════════════════════════════════════════════════ */

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
        <ModalOverlay open zIndex="var(--z-drag-overlay)">
            <div style={{
                width: 'var(--modal-width-sm)',
                borderRadius: 'var(--radius-2xl)',
                border: 'var(--border-width-1) solid var(--color-border-subtle)',
                background: 'color-mix(in srgb, var(--color-bg-elevated) 92%, var(--color-bg-base))',
                boxShadow: 'var(--shadow-panel)',
                padding: 'var(--space-4)',
                display: 'grid',
                gap: 'var(--space-2-5)',
            }}>
                <div style={{
                    fontSize: 'var(--font-size-lg)',
                    fontWeight: 'var(--font-weight-bold)' as unknown as number,
                    color: 'var(--color-text-primary)',
                }}>
                    {title}
                </div>
                <div style={{
                    fontSize: 'var(--font-size-sm)',
                    color: 'var(--color-text-secondary)',
                }}>
                    {activeJob.phase || 'Processing...'}
                </div>
                <div style={{
                    height: 'var(--space-1-5)',
                    borderRadius: 'var(--radius-full)',
                    overflow: 'hidden',
                    background: 'color-mix(in srgb, var(--color-bg-panel) 74%, var(--color-bg-base))',
                }}>
                    <div style={{
                        width: `${progress}%`,
                        height: '100%',
                        background: 'var(--color-accent-primary)',
                        transition: `width var(--transition-linear)`,
                    }} />
                </div>
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                }}>
                    <div style={{
                        fontSize: 'var(--font-size-sm)',
                        color: 'var(--color-text-secondary)',
                        fontFamily: 'var(--font-mono)',
                    }}>
                        {Math.round(progress)}%
                    </div>
                    <ActionButton
                        variant="danger"
                        size="sm"
                        onClick={() => {
                            void engineApi.cancelBackgroundJob(activeJob.id)
                                .catch((err) => {
                                    console.warn('[BlockingJobPopup] cancelBackgroundJob failed, fallback to cancelExport:', err);
                                    return engineApi.cancelExport();
                                });
                        }}
                    >
                        Cancel
                    </ActionButton>
                </div>
            </div>
        </ModalOverlay>
    );
};
