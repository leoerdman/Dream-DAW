import { useState, useEffect, useCallback, useMemo } from 'react';
import * as engineApi from '@/shared/api/engine';
import { DEFAULT_BPM, DEFAULT_SAMPLE_RATE } from '@/shared/lib/audioMath';
import { ModalOverlay } from '@/shared/ui/ModalOverlay';
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

function getErrorMessage(err: unknown): string {
    let raw = '';
    // BUG-035 FIX: Use if/else if chain for proper type narrowing.
    if (typeof err === 'string' && err.trim()) {
        raw = err.trim();
    } else if (err instanceof Error) {
        const cause = (err as Error & { cause?: unknown }).cause;
        if (!raw && typeof cause === 'string' && cause.trim()) raw = cause.trim();
        if (cause && typeof cause === 'object') {
            const causeMessage = (cause as { message?: unknown }).message;
            if (!raw && typeof causeMessage === 'string' && causeMessage.trim()) raw = causeMessage.trim();
        }
        if (!raw && err.message?.trim()) raw = err.message.trim();
    } else if (err && typeof err === 'object') {
        const candidateMessage = (err as { message?: unknown }).message;
        if (!raw && typeof candidateMessage === 'string' && candidateMessage.trim()) raw = candidateMessage.trim();
    }
    if (!raw) {
        raw = String(err);
    }
    const normalized = raw.toLowerCase();
    if (
        normalized.includes('runtime snapshot missing instrument slot')
        || normalized.includes('external fx runtime snapshot missing instrument slot')
        || normalized.includes('runtime binding')
    ) {
        return 'Export failed: one or more external plugins are not fully loaded. Re-open the track plugin(s) and try again, or bypass external plugins for this export.';
    }
    if (normalized.includes('pluginslot not found')) {
        return 'Export failed: plugin chain state is out of sync. Reopen the project (or reload plugins) and retry export.';
    }
    return raw.trim();
}

export const ExportModal = ({
    isOpen,
    onClose,
    projectName = 'Untitled',
    selectedClipIds = [],
    allClips = [],
    bpm = DEFAULT_BPM,
    sampleRate: projectSampleRate = DEFAULT_SAMPLE_RATE,
    loopStartBeat = 0,
    loopEndBeat = 0,
    marqueeSelection = null,
}: ExportModalProps) => {
    const [savedPrefs] = useState(() => loadExportPrefs());
    const [format, setFormat] = useState(savedPrefs.format);
    const [exportSampleRate, setExportSampleRate] = useState(savedPrefs.sampleRate);
    const [bitDepth, setBitDepth] = useState(savedPrefs.bitDepth);
    const [exportRange, setExportRange] = useState<ExportRange>(savedPrefs.range);
    const [normalize, setNormalize] = useState(savedPrefs.normalize);
    const [includeTail, setIncludeTail] = useState(savedPrefs.includeTail);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [bounceError, setBounceError] = useState<string | null>(null);

    useEffect(() => {
        saveExportPrefs({ format, sampleRate: exportSampleRate, bitDepth, range: exportRange, normalize, includeTail });
    }, [format, exportSampleRate, bitDepth, exportRange, normalize, includeTail]);

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
        // BUG-031 FIX: Guard against zero/NaN bpm to prevent Infinity duration.
        const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_BPM;
        const durationSeconds = (durationBeats / safeBpm) * 60;
        return {
            startBeat,
            endBeat,
            startBar: beatsToBar(startBeat),
            endBar: beatsToBar(endBeat),
            durationBeats,
            durationFormatted: formatDuration(durationSeconds),
        };
    }, [exportRange, selectedRange, loopStartBeat, loopEndBeat, projectExtent, bpm]);

    const bounceDisabledReason = useMemo(() => {
        if (exportRange === 'selected' && !selectedRange) {
            return 'Select at least one clip or marquee range to export "Selected".';
        }
        if (!Number.isFinite(rangeInfo.durationBeats) || rangeInfo.durationBeats <= 0) {
            return 'Nothing to export: selected range is empty.';
        }
        return null;
    }, [exportRange, selectedRange, rangeInfo.durationBeats]);
    const canBounce = bounceDisabledReason === null;

    useEffect(() => {
        if (hasMarquee && exportRange !== 'selected') {
            setExportRange('selected');
        }
    }, [exportRange, hasMarquee]);

    const handleBounce = useCallback(async () => {
        // BUG-081 FIX: Prevent double-submit (keyboard shortcut bypass).
        if (isSubmitting) return;
        if (!canBounce) {
            setBounceError(bounceDisabledReason ?? 'Invalid export range.');
            return;
        }
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
                includeTail,
                format,
            };

            // BUG-004 FIX: Send startFrame/endFrame for BOTH 'selected' AND 'loop' ranges.
            // Previously, only 'selected' set frames — 'loop' exported the entire project.
            if (exportRange === 'selected' && selectedRange) {
                settings.startFrame = beatsToFrames(selectedRange.startBeat, bpm, projectSampleRate);
                settings.endFrame = beatsToFrames(selectedRange.endBeat, bpm, projectSampleRate);
            } else if (exportRange === 'loop' && loopEndBeat > loopStartBeat) {
                settings.startFrame = beatsToFrames(loopStartBeat, bpm, projectSampleRate);
                settings.endFrame = beatsToFrames(loopEndBeat, bpm, projectSampleRate);
            }

            await engineApi.exportMix(settings);
            onClose();
        } catch (err) {
            const msg = getErrorMessage(err);
            console.error('[ExportModal] Bounce failed:', msg);
            setBounceError(msg);
        } finally {
            setIsSubmitting(false);
        }
    }, [canBounce, bounceDisabledReason, isSubmitting, exportSampleRate, bitDepth, exportRange, normalize, includeTail, format, projectName, onClose, selectedRange, bpm, projectSampleRate, loopStartBeat, loopEndBeat]);

    // BUG-51 FIX: Memoize rangeOptions to avoid re-creating array every render.
    // MUST be before the early-return to satisfy Rules of Hooks (constant hook count).
    const rangeOptions = useMemo(() => {
        const opts: { value: ExportRange; label: string }[] = [
            { value: 'full', label: 'Full Project' },
            { value: 'loop', label: 'Loop Region' },
        ];
        if (hasSelection) opts.push({ value: 'selected', label: 'Selected' });
        return opts;
    }, [hasSelection]);

    if (!isOpen) return null;

    return (
        <ModalOverlay open={isOpen} onBackdropClick={isSubmitting ? undefined : onClose} labelId="export-audio-title">
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
                includeTail={includeTail}
                setIncludeTail={setIncludeTail}
                bounceError={bounceError}
                canBounce={canBounce}
                bounceDisabledReason={bounceDisabledReason}
                onBounce={handleBounce}
            />
        </ModalOverlay>
    );
};
