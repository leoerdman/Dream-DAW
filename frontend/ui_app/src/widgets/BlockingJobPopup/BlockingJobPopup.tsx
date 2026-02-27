import { useEffect, useMemo, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import * as engineApi from '@/shared/api/engine';
import type { BackgroundJobSnapshot } from '@/shared/api/engine';
import { ModalOverlay } from '@/shared/ui/ModalOverlay';
import { ActionButton } from '@/shared/ui/ActionButton';

/* ═══════════════════════════════════════════════════════════════
   BlockingJobPopup — Non-dismissible modal for background jobs.
   Shows running jobs with progress, and failed/cancelled jobs
   for 5 seconds so the user can see the error message.
   All values use design tokens from tokens.css.
   ═══════════════════════════════════════════════════════════════ */

const labelByKind: Record<string, string> = {
    export_mix: 'Rendering Audio',
    split_to_stems: 'Splitting To 4 Stems',
    bounce_track: 'Bouncing Track',
    bounce_group: 'Bouncing Group',
    bounce_selection: 'Bouncing Selection',
};

/** How long to show a failed/cancelled job before auto-dismissing (ms). */
const ERROR_DISPLAY_MS = 5000;

export const BlockingJobPopup = () => {
    const [jobs, setJobs] = useState<BackgroundJobSnapshot[]>([]);
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        let unlisten: UnlistenFn | null = null;
        let mounted = true;

        void engineApi.listBackgroundJobs()
            .then((list) => {
                if (mounted) setJobs(list);
            })
            .catch((err) => {
                console.warn('[Dream] listBackgroundJobs failed:', err);
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
            console.warn('[Dream] listener setup failed:', err);
        });

        return () => {
            mounted = false;
            if (unlisten) unlisten();
        };
    }, []);

    // Periodic tick to auto-dismiss stale error displays.
    useEffect(() => {
        const hasActiveTerminalDisplay = jobs.some(
            (j) =>
                (j.status === 'failed' || j.status === 'cancelled') &&
                j.finishedAtMs != null &&
                Date.now() - j.finishedAtMs < ERROR_DISPLAY_MS,
        );
        if (!hasActiveTerminalDisplay) return;

        const timer = window.setInterval(() => {
            const ts = Date.now();
            setNow(ts);
            // Prune stale terminal jobs so the timer can stop naturally.
            setJobs((prev) => prev.filter((j) => {
                if (j.status !== 'failed' && j.status !== 'cancelled') return true;
                if (j.finishedAtMs == null) return true;
                return ts - j.finishedAtMs < ERROR_DISPLAY_MS;
            }));
        }, 500);
        return () => clearInterval(timer);
    }, [jobs]);

    const activeJob = useMemo(() => {
        // Priority 1: running jobs
        const running = jobs
            .filter((j) => j.status === 'running')
            .sort((a, b) => b.startedAtMs - a.startedAtMs);
        if (running.length > 0) return running[0];

        // Priority 2: recently failed/cancelled jobs (visible for ERROR_DISPLAY_MS)
        const recentTerminal = jobs
            .filter(
                (j) =>
                    (j.status === 'failed' || j.status === 'cancelled') &&
                    j.finishedAtMs != null &&
                    now - j.finishedAtMs < ERROR_DISPLAY_MS,
            )
            .sort((a, b) => (b.finishedAtMs ?? 0) - (a.finishedAtMs ?? 0));
        return recentTerminal[0] ?? null;
    }, [jobs, now]);

    if (!activeJob) return null;

    const isTerminal =
        activeJob.status === 'failed' || activeJob.status === 'cancelled';
    const progress = Math.max(0, Math.min(100, activeJob.progress || 0));
    const title = isTerminal
        ? activeJob.status === 'failed'
            ? 'Export Failed'
            : 'Export Cancelled'
        : (labelByKind[activeJob.kind] ?? 'Processing');

    return (
        <ModalOverlay open zIndex="var(--z-drag-overlay)">
            <div style={{
                width: 'var(--modal-width-sm)',
                borderRadius: 'var(--radius-2xl)',
                border: `var(--border-width-1) solid ${isTerminal ? 'var(--color-status-error)' : 'var(--color-border-subtle)'}`,
                background: 'color-mix(in srgb, var(--color-bg-elevated) 92%, var(--color-bg-base))',
                boxShadow: 'var(--shadow-panel)',
                padding: 'var(--space-4)',
                display: 'grid',
                gap: 'var(--space-2-5)',
            }}>
                <div style={{
                    fontSize: 'var(--font-size-lg)',
                    fontWeight: 'var(--font-weight-bold)',
                    color: isTerminal
                        ? 'var(--color-status-error)'
                        : 'var(--color-text-primary)',
                }}>
                    {title}
                </div>

                {/* Error message for failed jobs */}
                {isTerminal && activeJob.error && (
                    <div style={{
                        fontSize: 'var(--font-size-sm)',
                        color: 'var(--color-status-error)',
                        lineHeight: 'var(--leading-snug)',
                        padding: 'var(--space-2)',
                        borderRadius: 'var(--radius-md)',
                        background: 'color-mix(in srgb, var(--color-status-error) 8%, transparent)',
                        wordBreak: 'break-word',
                    }}>
                        {activeJob.error}
                    </div>
                )}

                {/* Phase text for running jobs */}
                {!isTerminal && (
                    <div style={{
                        fontSize: 'var(--font-size-sm)',
                        color: 'var(--color-text-secondary)',
                    }}>
                        {activeJob.phase || 'Processing...'}
                    </div>
                )}

                {/* Progress bar — only for running jobs */}
                {!isTerminal && (
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
                )}

                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                }}>
                    {!isTerminal && (
                        <div style={{
                            fontSize: 'var(--font-size-sm)',
                            color: 'var(--color-text-secondary)',
                            fontFamily: 'var(--font-role-data)',
                        }}>
                            {Math.round(progress)}%
                        </div>
                    )}
                    {isTerminal ? (
                        <ActionButton
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                                // Manually dismiss by clearing the job from state
                                setJobs((prev) => prev.filter((j) => j.id !== activeJob.id));
                            }}
                        >
                            Dismiss
                        </ActionButton>
                    ) : (
                        <ActionButton
                            variant="danger"
                            size="sm"
                            onClick={() => {
                                void engineApi.cancelBackgroundJob(activeJob.id)
                                    .catch((err) => {
                                        console.warn('[Dream] cancelBackgroundJob failed, fallback to cancelExport:', err);
                                        return engineApi.cancelExport();
                                    });
                            }}
                        >
                            Cancel
                        </ActionButton>
                    )}
                </div>
            </div>
        </ModalOverlay>
    );
};
