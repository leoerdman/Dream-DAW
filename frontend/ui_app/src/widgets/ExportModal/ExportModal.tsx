import { useState, useEffect, useCallback, useMemo } from 'react';
import * as engineApi from '@/shared/api/engine';
import { ExportModalPanel } from './ExportModalPanel';
import {
    DIALOG_FILTERS,
    beatsToBar,
    beatsToFrames,
    formatDuration,
    loadExportPrefs,
    saveExportPrefs,
    type ExportRange,
    type ExportModalProps,
} from './exportModalConfig';

export const ExportModal = ({
    isOpen,
    onClose,
    projectName = 'Untitled',
    selectedClipIds = [],
    allClips = [],
    bpm = 120,
    sampleRate: projectSampleRate = 48000,
    loopStartBeat = 0,
    loopEndBeat = 0,
    marqueeSelection = null,
}: ExportModalProps) => {
    const [savedPrefs] = useState(() => loadExportPrefs());
    const [format, setFormat] = useState(savedPrefs.format);
    const [exportSampleRate, setExportSampleRate] = useState(savedPrefs.sampleRate);
    const [bitDepth, setBitDepth] = useState(savedPrefs.bitDepth);
    const [exportRange, setExportRange] = useState<ExportRange>('full');
    const [normalize, setNormalize] = useState(savedPrefs.normalize);
    const [tailMs, setTailMs] = useState(savedPrefs.tailMs);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [bounceError, setBounceError] = useState<string | null>(null);

    useEffect(() => {
        saveExportPrefs({ format, sampleRate: exportSampleRate, bitDepth, normalize, tailMs });
    }, [format, exportSampleRate, bitDepth, normalize, tailMs]);

    useEffect(() => {
        if (isOpen) {
            setIsSubmitting(false);
            setBounceError(null);
        }
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !isSubmitting) {
                e.preventDefault();
                e.stopPropagation();
                onClose();
            }
        };
        window.addEventListener('keydown', onKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', onKeyDown, { capture: true } as EventListenerOptions);
    }, [isOpen, isSubmitting, onClose]);

    const hasMarquee = Boolean(marqueeSelection && Math.abs(marqueeSelection.endBeat - marqueeSelection.startBeat) > 1e-6);
    const hasClipSelection = selectedClipIds.length > 0;
    const hasSelection = hasMarquee || hasClipSelection;

    const selectedRange = useMemo(() => {
        if (hasMarquee && marqueeSelection) {
            return {
                startBeat: Math.min(marqueeSelection.startBeat, marqueeSelection.endBeat),
                endBeat: Math.max(marqueeSelection.startBeat, marqueeSelection.endBeat),
            };
        }

        if (!hasClipSelection || allClips.length === 0) return null;
        const selectedSet = new Set(selectedClipIds);
        const selected = allClips.filter((c) => selectedSet.has(c.id));
        if (selected.length === 0) return null;

        let minBeat = Infinity;
        let maxBeat = -Infinity;
        for (const c of selected) {
            minBeat = Math.min(minBeat, c.startBeat);
            maxBeat = Math.max(maxBeat, c.startBeat + c.durationBeats);
        }
        return { startBeat: minBeat, endBeat: maxBeat };
    }, [hasMarquee, marqueeSelection, hasClipSelection, allClips, selectedClipIds]);

    const projectExtent = useMemo(() => {
        if (allClips.length === 0) return { startBeat: 0, endBeat: 0 };
        let maxBeat = 0;
        for (const c of allClips) {
            maxBeat = Math.max(maxBeat, c.startBeat + c.durationBeats);
        }
        return { startBeat: 0, endBeat: maxBeat };
    }, [allClips]);

    const rangeInfo = useMemo(() => {
        let startBeat = 0;
        let endBeat = 0;

        if (exportRange === 'selected' && selectedRange) {
            startBeat = selectedRange.startBeat;
            endBeat = selectedRange.endBeat;
        } else if (exportRange === 'loop' && loopEndBeat > loopStartBeat) {
            startBeat = loopStartBeat;
            endBeat = loopEndBeat;
        } else {
            startBeat = projectExtent.startBeat;
            endBeat = projectExtent.endBeat;
        }

        const durationBeats = endBeat - startBeat;
        const durationSeconds = (durationBeats / bpm) * 60;
        return {
            startBeat,
            endBeat,
            startBar: beatsToBar(startBeat),
            endBar: beatsToBar(endBeat),
            durationBeats,
            durationFormatted: formatDuration(durationSeconds),
        };
    }, [exportRange, selectedRange, loopStartBeat, loopEndBeat, projectExtent, bpm]);

    useEffect(() => {
        if (hasMarquee && exportRange !== 'selected') {
            setExportRange('selected');
        } else if (exportRange === 'selected' && !hasSelection) {
            setExportRange('full');
        }
    }, [exportRange, hasSelection, hasMarquee]);

    const handleBounce = useCallback(async () => {
        setBounceError(null);
        setIsSubmitting(true);

        try {
            const { save } = await import('@tauri-apps/plugin-dialog');
            const ext = format === 'mp3' ? 'mp3' : 'wav';
            const outputPath = await save({
                title: 'Export Audio',
                defaultPath: `${projectName}.${ext}`,
                filters: DIALOG_FILTERS[format],
            });

            if (!outputPath) {
                setIsSubmitting(false);
                return;
            }

            const settings: engineApi.ExportSettings = {
                outputPath,
                sampleRate: exportSampleRate,
                bitDepth: format === 'wav' ? bitDepth : 24,
                range: exportRange,
                normalize,
                tailMs,
                format,
            };

            if (exportRange === 'selected' && selectedRange) {
                settings.startFrame = beatsToFrames(selectedRange.startBeat, bpm, projectSampleRate);
                settings.endFrame = beatsToFrames(selectedRange.endBeat, bpm, projectSampleRate);
            }

            await engineApi.exportMix(settings);
            onClose();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[ExportModal] Bounce failed:', msg);
            setBounceError(msg);
        } finally {
            setIsSubmitting(false);
        }
    }, [exportSampleRate, bitDepth, exportRange, normalize, tailMs, format, projectName, onClose, selectedRange, bpm, projectSampleRate]);

    if (!isOpen) return null;

    const rangeOptions: { value: ExportRange; label: string }[] = [
        { value: 'full', label: 'Full Project' },
        { value: 'loop', label: 'Loop Region' },
    ];
    if (hasSelection) rangeOptions.push({ value: 'selected', label: 'Selected' });

    return (
        <>
            <div
                onClick={isSubmitting ? undefined : onClose}
                style={{
                    position: 'fixed',
                    inset: 0,
                    zIndex: 'var(--z-modal)' as unknown as number,
                    background: 'var(--color-overlay-modal)',
                    backdropFilter: 'blur(4px)',
                    WebkitBackdropFilter: 'blur(4px)',
                }}
            />

            <ExportModalPanel
                isSubmitting={isSubmitting}
                onClose={onClose}
                projectName={projectName}
                format={format}
                setFormat={setFormat}
                exportSampleRate={exportSampleRate}
                setExportSampleRate={setExportSampleRate}
                bitDepth={bitDepth}
                setBitDepth={setBitDepth}
                rangeOptions={rangeOptions}
                exportRange={exportRange}
                setExportRange={setExportRange}
                rangeInfo={rangeInfo}
                normalize={normalize}
                setNormalize={setNormalize}
                tailMs={tailMs}
                setTailMs={setTailMs}
                bounceError={bounceError}
                onBounce={handleBounce}
            />
        </>
    );
};
