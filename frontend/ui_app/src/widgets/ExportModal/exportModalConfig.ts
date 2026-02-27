import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import { safeStorage } from '@/shared/lib/safeStorage';
import { DEFAULT_SAMPLE_RATE, DEFAULT_TIME_SIG_NUMERATOR } from '@/shared/lib/audioMath';

export type ExportFormat = 'wav' | 'mp3';
export type SampleRate = number;
export type BitDepth = 16 | 24 | 32;
export type ExportRange = 'full' | 'loop' | 'selected';

export interface MarqueeSelection {
    startBeat: number;
    endBeat: number;
    startTrack: number;
    endTrack: number;
}

export interface ExportModalProps {
    isOpen: boolean;
    onClose: () => void;
    projectName?: string;
    selectedClipIds?: string[];
    allClips?: TimelineClip[];
    bpm?: number;
    sampleRate?: number;
    loopStartBeat?: number;
    loopEndBeat?: number;
    marqueeSelection?: MarqueeSelection | null;
}

export const FORMATS: { value: ExportFormat; label: string; desc: string }[] = [
    { value: 'wav', label: 'WAV', desc: 'Uncompressed, highest quality' },
    { value: 'mp3', label: 'MP3', desc: 'Compressed, smaller files (320 kbps)' },
];

export const SAMPLE_RATES: { value: SampleRate; label: string }[] = [
    { value: 44100, label: '44.1 kHz' },
    { value: 48000, label: '48 kHz' },
    { value: 88200, label: '88.2 kHz' },
    { value: 96000, label: '96 kHz' },
    { value: 192000, label: '192 kHz' },
];

export const BIT_DEPTHS: { value: BitDepth; label: string }[] = [
    { value: 16, label: '16-bit' },
    { value: 24, label: '24-bit' },
    { value: 32, label: '32-bit Float' },
];

export const DIALOG_FILTERS: Record<ExportFormat, { name: string; extensions: string[] }[]> = {
    wav: [{ name: 'WAV Audio', extensions: ['wav'] }],
    mp3: [{ name: 'MP3 Audio', extensions: ['mp3'] }],
};

export const EXPORT_PREFS_KEY = 'dream_daw_export_prefs';

export interface ExportPrefs {
    format: ExportFormat;
    sampleRate: SampleRate;
    bitDepth: BitDepth;
    range: ExportRange;
    normalize: boolean;
    tailMs: number;
}

export function beatsToFrames(beats: number, bpm: number, sampleRate: number): number {
    return Math.round((beats / bpm) * 60 * sampleRate);
}

export function formatDuration(seconds: number): string {
    const totalMs = Math.round(seconds * 1000);
    const mins = Math.floor(totalMs / 60000);
    const secs = Math.floor((totalMs % 60000) / 1000);
    const tenths = Math.floor((totalMs % 1000) / 100);
    return `${mins}:${String(secs).padStart(2, '0')}.${tenths}`;
}

export function beatsToBar(beats: number, beatsPerBar = DEFAULT_TIME_SIG_NUMERATOR): number {
    return Math.floor(beats / beatsPerBar) + 1;
}

export function loadExportPrefs(): ExportPrefs {
    try {
        const raw = safeStorage.getItem(EXPORT_PREFS_KEY);
        if (!raw) {
            return { format: 'wav', sampleRate: DEFAULT_SAMPLE_RATE, bitDepth: 24, range: 'full', normalize: false, tailMs: 0 };
        }
        const parsed = JSON.parse(raw) as Partial<ExportPrefs>;
        return {
            format: (['wav', 'mp3'] as ExportFormat[]).includes(parsed.format as ExportFormat)
                ? (parsed.format as ExportFormat) : 'wav',
            sampleRate: ([44100, 48000, 88200, 96000, 192000] as SampleRate[]).includes(parsed.sampleRate as SampleRate)
                ? (parsed.sampleRate as SampleRate) : DEFAULT_SAMPLE_RATE,
            bitDepth: ([16, 24, 32] as BitDepth[]).includes(parsed.bitDepth as BitDepth)
                ? (parsed.bitDepth as BitDepth) : 24,
            range: (['full', 'loop', 'selected'] as ExportRange[]).includes(parsed.range as ExportRange)
                ? (parsed.range as ExportRange) : 'full',
            normalize: typeof parsed.normalize === 'boolean' ? parsed.normalize : false,
            tailMs: typeof parsed.tailMs === 'number' ? Math.max(0, Math.min(5000, parsed.tailMs)) : 0,
        };
    } catch {
        return { format: 'wav', sampleRate: DEFAULT_SAMPLE_RATE, bitDepth: 24, range: 'full', normalize: false, tailMs: 0 };
    }
}

export function saveExportPrefs(prefs: ExportPrefs): void {
    safeStorage.setItem(EXPORT_PREFS_KEY, JSON.stringify(prefs));
}
