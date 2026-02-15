import { useEffect, useMemo, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import * as engineApi from '@/shared/api/engine';
import type { BackgroundJobSnapshot } from '@/shared/api/engine';

const statusColor = (status: string): string => {
    if (status === 'completed') return '#63d26f';
    if (status === 'failed') return '#ff6b6b';
    if (status === 'cancelled') return '#ffb86b';
    return '#58a6ff';
};

export const JobCenter = () => {
    const [open, setOpen] = useState(false);
    const [jobs, setJobs] = useState<BackgroundJobSnapshot[]>([]);
    const [filter, setFilter] = useState<'all' | 'running' | 'done' | 'failed'>('all');

    useEffect(() => {
        let unlisten: UnlistenFn | null = null;
        let mounted = true;

        const upsert = (next: BackgroundJobSnapshot) => {
            setJobs((prev) => {
                const idx = prev.findIndex((j) => j.id === next.id);
                if (idx === -1) return [next, ...prev];
                const copy = prev.slice();
                copy[idx] = next;
                return copy;
            });
        };

        void engineApi.listBackgroundJobs()
            .then((list) => {
                if (!mounted) return;
                setJobs(list);
            })
            .catch(() => {});

        void listen<BackgroundJobSnapshot>('background_job_update', (event) => {
            if (!mounted) return;
            upsert(event.payload);
        }).then((fn) => {
            unlisten = fn;
        }).catch(() => {});

        return () => {
            mounted = false;
            if (unlisten) unlisten();
        };
    }, []);

    const ordered = useMemo(() => {
        return [...jobs].sort((a, b) => b.startedAtMs - a.startedAtMs);
    }, [jobs]);

    const runningCount = ordered.filter((j) => j.status === 'running').length;
    const doneCount = ordered.filter((j) => j.status === 'completed').length;
    const failedCount = ordered.filter((j) => j.status === 'failed' || j.status === 'cancelled').length;

    const filtered = useMemo(() => {
        if (filter === 'running') return ordered.filter((j) => j.status === 'running');
        if (filter === 'done') return ordered.filter((j) => j.status === 'completed');
        if (filter === 'failed') return ordered.filter((j) => j.status === 'failed' || j.status === 'cancelled');
        return ordered;
    }, [filter, ordered]);

    const shown = filtered.slice(0, 12);

    return (
        <div style={{ position: 'absolute', right: 14, bottom: 36, zIndex: 1000 }}>
            <button
                onClick={() => setOpen((v) => !v)}
                style={{
                    border: '1px solid var(--color-border-subtle)',
                    background: 'color-mix(in srgb, var(--color-bg-elevated) 92%, #0f1118)',
                    color: 'var(--color-text-primary)',
                    borderRadius: 8,
                    fontSize: 11,
                    fontWeight: 700,
                    height: 26,
                    padding: '0 10px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    cursor: 'pointer',
                    boxShadow: '0 8px 20px rgba(0,0,0,0.25)',
                }}
                title="Background Jobs"
            >
                Jobs
                <span style={{
                    minWidth: 18,
                    height: 18,
                    borderRadius: 10,
                    background: runningCount > 0 ? 'var(--color-accent-primary)' : 'var(--color-bg-panel)',
                    color: runningCount > 0 ? '#fff' : 'var(--color-text-secondary)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 10,
                    fontWeight: 800,
                }}>
                    {runningCount}
                </span>
            </button>

            {open && (
                <div style={{
                    marginTop: 8,
                    width: 340,
                    maxHeight: 370,
                    border: '1px solid var(--color-border-subtle)',
                    borderRadius: 10,
                    background: 'color-mix(in srgb, var(--color-bg-elevated) 94%, #0d0f14)',
                    boxShadow: '0 16px 36px rgba(0,0,0,0.34)',
                    padding: 8,
                }}>
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        marginBottom: 8,
                    }}>
                        <div style={{ display: 'flex', gap: 6 }}>
                            {[
                                { key: 'all', label: `All ${ordered.length}` },
                                { key: 'running', label: `Run ${runningCount}` },
                                { key: 'done', label: `Done ${doneCount}` },
                                { key: 'failed', label: `Fail ${failedCount}` },
                            ].map((chip) => (
                                <button
                                    key={chip.key}
                                    onClick={() => setFilter(chip.key as 'all' | 'running' | 'done' | 'failed')}
                                    style={{
                                        height: 22,
                                        borderRadius: 999,
                                        border: filter === chip.key
                                            ? '1px solid color-mix(in srgb, var(--color-accent-primary) 55%, transparent)'
                                            : '1px solid var(--color-border-subtle)',
                                        background: filter === chip.key
                                            ? 'var(--color-accent-primary-dim)'
                                            : 'color-mix(in srgb, var(--color-bg-panel) 88%, #0e1117)',
                                        color: filter === chip.key ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                                        fontSize: 10,
                                        fontWeight: 700,
                                        padding: '0 9px',
                                        cursor: 'pointer',
                                    }}
                                >
                                    {chip.label}
                                </button>
                            ))}
                        </div>
                        <button
                            onClick={() => {
                                void engineApi.clearFinishedBackgroundJobs()
                                    .then(() => engineApi.listBackgroundJobs())
                                    .then((list) => setJobs(list))
                                    .catch(() => {});
                            }}
                            style={{
                                height: 22,
                                borderRadius: 6,
                                border: '1px solid var(--color-border-subtle)',
                                background: 'color-mix(in srgb, var(--color-bg-panel) 84%, #0d1017)',
                                color: 'var(--color-text-secondary)',
                                fontSize: 10,
                                fontWeight: 700,
                                padding: '0 8px',
                                cursor: 'pointer',
                            }}
                        >
                            Clear History
                        </button>
                    </div>

                    <div style={{ maxHeight: 300, overflowY: 'auto', paddingRight: 2 }}>
                    {shown.length === 0 ? (
                        <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--color-text-secondary)' }}>
                            No jobs in this filter.
                        </div>
                    ) : shown.map((job) => (
                        <div key={job.id} style={{
                            border: '1px solid color-mix(in srgb, var(--color-border-subtle) 82%, transparent)',
                            borderRadius: 8,
                            padding: 8,
                            marginBottom: 6,
                            background: 'color-mix(in srgb, var(--color-bg-panel) 86%, #11151f)',
                        }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-primary)' }}>
                                    {job.kind}
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span style={{
                                        fontSize: 10,
                                        fontWeight: 700,
                                        color: statusColor(job.status),
                                        textTransform: 'uppercase',
                                    }}>
                                        {job.status}
                                    </span>
                                    {job.status === 'running' && job.cancellable && (
                                        <button
                                            onClick={() => { void engineApi.cancelBackgroundJob(job.id); }}
                                            style={{
                                                border: '1px solid color-mix(in srgb, var(--color-status-error) 45%, transparent)',
                                                background: 'color-mix(in srgb, var(--color-status-error) 18%, transparent)',
                                                color: 'var(--color-status-error)',
                                                borderRadius: 5,
                                                height: 20,
                                                padding: '0 8px',
                                                fontSize: 10,
                                                fontWeight: 700,
                                                cursor: 'pointer',
                                            }}
                                        >
                                            Stop
                                        </button>
                                    )}
                                </div>
                            </div>

                            <div style={{ marginTop: 6, fontSize: 10, color: 'var(--color-text-secondary)' }}>
                                {job.phase || 'Working...'}
                            </div>

                            <div style={{
                                marginTop: 6,
                                height: 5,
                                borderRadius: 99,
                                background: 'color-mix(in srgb, var(--color-bg-panel) 70%, #07090f)',
                                overflow: 'hidden',
                            }}>
                                <div style={{
                                    width: `${Math.max(0, Math.min(100, job.progress))}%`,
                                    height: '100%',
                                    background: statusColor(job.status),
                                    transition: 'width 120ms linear',
                                }} />
                            </div>

                            {job.error && (
                                <div style={{ marginTop: 6, fontSize: 10, color: '#ff7b7b' }}>
                                    {job.error}
                                </div>
                            )}
                        </div>
                    ))}
                    </div>
                </div>
            )}
        </div>
    );
};
